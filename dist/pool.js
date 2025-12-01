import BrowsercashSDK from "@browsercash/sdk";
/**
 * Browser session pool for Browser.cash
 *
 * Manages a pool of browser sessions for efficient reuse.
 */
export class SessionPool {
    available = [];
    inUse = new Set();
    creating = 0;
    closed = false;
    healthCheckTimer = null;
    waitQueue = [];
    sdk;
    chromium;
    size;
    maxUses;
    maxAgeMs;
    maxIdleMs;
    enableHealthCheck;
    healthCheckIntervalMs;
    enableWaitQueue;
    enableDisconnectHandling;
    createPage;
    debug;
    logger;
    constructor(config) {
        this.sdk = new BrowsercashSDK({ apiKey: config.apiKey });
        this.chromium = config.chromium;
        this.size = config.size;
        this.maxUses = config.maxUses ?? 50;
        this.maxAgeMs = config.maxAgeMs ?? 5 * 60 * 1000;
        this.maxIdleMs = config.maxIdleMs ?? 2 * 60 * 1000; // 2 minutes default
        this.enableHealthCheck = config.enableHealthCheck ?? false;
        this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 30_000;
        this.enableWaitQueue = config.enableWaitQueue ?? true;
        this.enableDisconnectHandling = config.enableDisconnectHandling ?? true;
        this.createPage = config.createPage ?? false;
        this.debug = config.debug ?? false;
        this.logger = config.logger ?? ((msg, data) => {
            if (data) {
                console.log(msg, data);
            }
            else {
                console.log(msg);
            }
        });
    }
    log(message, data) {
        if (this.debug) {
            this.logger(message, data);
        }
    }
    get totalCount() {
        return this.available.length + this.inUse.size + this.creating;
    }
    /**
     * Initialize the pool with pre-warmed sessions
     */
    async init() {
        this.log("[pool] initializing", { size: this.size });
        const warmupPromises = [];
        for (let i = 0; i < this.size; i++) {
            warmupPromises.push(this.addSession());
        }
        // Wait for at least one session to be ready
        await Promise.race(warmupPromises);
        // Wait for all warmup to complete
        await Promise.allSettled(warmupPromises);
        if (this.enableHealthCheck) {
            this.startHealthCheck();
        }
        this.log("[pool] initialized", { ...this.stats() });
    }
    startHealthCheck() {
        if (this.healthCheckTimer)
            return;
        this.healthCheckTimer = setInterval(() => {
            if (this.closed)
                return;
            this.performHealthCheck();
        }, this.healthCheckIntervalMs);
        // Don't prevent process exit
        if (this.healthCheckTimer.unref) {
            this.healthCheckTimer.unref();
        }
    }
    performHealthCheck() {
        const toReplace = [];
        for (const session of this.available) {
            if (!this.isUsable(session))
                toReplace.push(session);
        }
        const deficit = this.size - this.totalCount;
        // Only log if there are issues (sessions to replace or pool is below capacity)
        if (toReplace.length > 0 || deficit > 0) {
            this.log("[pool] health check: issues found", {
                toReplace: toReplace.length,
                deficit,
                ...this.stats()
            });
        }
        // Replace each unusable session: create new one first, then remove old
        for (const oldSession of toReplace) {
            this.replaceSession(oldSession).catch((err) => {
                this.log("[pool] replaceSession failed during health-check", {
                    error: err instanceof Error ? err.message : String(err)
                });
            });
        }
        // Also replenish if we're below target (e.g., sessions that failed to create)
        this.replenish();
    }
    /**
     * Replace a session: create new one first, confirm it's good, then remove old
     */
    async replaceSession(oldSession) {
        if (this.closed)
            return;
        const oldSessionId = oldSession.sessionId;
        this.log("[pool] replacing session", { sessionId: oldSessionId });
        try {
            // Create new session first
            const newSession = await this.createSession();
            // Attach disconnect handler to new session
            if (this.enableDisconnectHandling && typeof newSession.browser.on === "function") {
                newSession.browser.on("disconnected", () => {
                    this.log("[pool] browser disconnected", {
                        sessionId: newSession.sessionId,
                        ageMs: Date.now() - newSession.createdAt,
                        useCount: newSession.useCount,
                    });
                    const availIdx = this.available.indexOf(newSession);
                    if (availIdx !== -1)
                        this.available.splice(availIdx, 1);
                    if (this.inUse.has(newSession))
                        this.inUse.delete(newSession);
                    this.closeSession(newSession).catch(() => { });
                    this.replenish();
                });
            }
            // New session is good - now remove old one
            const idx = this.available.indexOf(oldSession);
            if (idx !== -1) {
                this.available.splice(idx, 1);
            }
            // Add new session to pool
            this.available.push(newSession);
            this.log("[pool] session replaced", {
                oldSessionId,
                newSessionId: newSession.sessionId,
                ...this.stats()
            });
            // Close old session in background
            this.closeSession(oldSession).catch((err) => {
                this.log("[pool] closeSession failed for replaced session", {
                    sessionId: oldSessionId,
                    error: err instanceof Error ? err.message : String(err)
                });
            });
        }
        catch (err) {
            this.log("[pool] failed to create replacement session", {
                oldSessionId,
                error: err instanceof Error ? err.message : String(err)
            });
            // Still remove the old unusable session
            const idx = this.available.indexOf(oldSession);
            if (idx !== -1) {
                this.available.splice(idx, 1);
                this.closeSession(oldSession).catch(() => { });
            }
            // replenish() will be called after to try again
        }
    }
    replenish() {
        const deficit = this.size - this.totalCount;
        if (deficit <= 0)
            return;
        this.log("[pool] replenishing", { deficit, ...this.stats() });
        this.addSession().catch((err) => {
            this.log("[pool] replenish addSession failed", {
                error: err instanceof Error ? err.message : String(err)
            });
        });
    }
    async createSession() {
        const session = await this.sdk.browser.session.create();
        if (!session.cdpUrl) {
            throw new Error("No CDP URL returned for session");
        }
        this.log("[cdp] session ready", {
            sessionId: session.sessionId,
            cdpUrl: `https://dash.browser.cash/cdp_tabs?ws=${encodeURIComponent(session.cdpUrl)}`,
        });
        let browser;
        try {
            browser = await this.chromium.connectOverCDP(session.cdpUrl);
        }
        catch (err) {
            // CDP connection failed - stop the Browser.cash session so it doesn't dangle
            this.log("[pool] CDP connection failed, stopping session", {
                sessionId: session.sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
            try {
                await this.sdk.browser.session.stop({ sessionId: session.sessionId });
            }
            catch { }
            throw err;
        }
        // Ensure a context exists so parallel work doesn't race on first context creation
        let context;
        if (typeof browser.contexts === "function") {
            const contexts = browser.contexts();
            if (Array.isArray(contexts) && contexts.length > 0) {
                context = contexts[0];
            }
            else if (typeof browser.newContext === "function") {
                context = await browser.newContext();
            }
        }
        // Optionally create a Page for consumers that want a ready-to-use tab
        let page;
        if (this.createPage && context && typeof context.newPage === "function") {
            page = await context.newPage();
        }
        const now = Date.now();
        return {
            sessionId: session.sessionId,
            cdpUrl: session.cdpUrl,
            browser,
            createdAt: now,
            useCount: 0,
            lastUsedAt: now,
            context,
            page,
        };
    }
    async closeSession(session) {
        if (!session)
            return;
        try {
            await session.browser.close().catch(() => { });
        }
        catch (err) {
            this.log("[pool] browser close warning", {
                error: err instanceof Error ? err.message : String(err)
            });
        }
        try {
            await this.sdk.browser.session.stop({ sessionId: session.sessionId });
            this.log("[session] stopped", { sessionId: session.sessionId });
        }
        catch (err) {
            this.log("[session] stop API failed", {
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }
    isUsable(session) {
        if (!session)
            return false;
        if (!session.browser.isConnected())
            return false;
        if (session.useCount >= this.maxUses)
            return false;
        if (Date.now() - session.createdAt > this.maxAgeMs)
            return false;
        if (Date.now() - session.lastUsedAt > this.maxIdleMs)
            return false; // Idle timeout
        return true;
    }
    async addSession() {
        if (this.closed)
            return;
        this.creating++;
        if (this.totalCount > this.size) {
            this.creating--;
            this.log("[pool] addSession: already at capacity, aborting", { ...this.stats() });
            return;
        }
        try {
            const session = await this.createSession();
            // Attach disconnect handler
            if (this.enableDisconnectHandling && typeof session.browser.on === "function") {
                session.browser.on("disconnected", () => {
                    this.log("[pool] browser disconnected", {
                        sessionId: session.sessionId,
                        ageMs: Date.now() - session.createdAt,
                        useCount: session.useCount,
                    });
                    // Remove from any lists
                    const availIdx = this.available.indexOf(session);
                    if (availIdx !== -1)
                        this.available.splice(availIdx, 1);
                    if (this.inUse.has(session))
                        this.inUse.delete(session);
                    // Close and replenish
                    this.closeSession(session).catch(() => { });
                    this.replenish();
                });
            }
            if (this.closed) {
                await this.closeSession(session);
                return;
            }
            if (this.totalCount > this.size) {
                this.log("[pool] addSession: over capacity after create, closing", {
                    sessionId: session.sessionId,
                    ...this.stats(),
                });
                await this.closeSession(session);
                return;
            }
            // If someone is waiting, give them the session
            if (this.enableWaitQueue && this.waitQueue.length > 0) {
                const waiter = this.waitQueue.shift();
                this.inUse.add(session);
                session.useCount++;
                this.log("[pool] session created and assigned to waiter", {
                    sessionId: session.sessionId,
                    ...this.stats(),
                });
                waiter.resolve(session);
            }
            else {
                this.available.push(session);
                this.log("[pool] session added to pool", {
                    sessionId: session.sessionId,
                    ...this.stats(),
                });
            }
            // Continue filling pool if needed
            if (this.totalCount < this.size && !this.closed) {
                setImmediate(() => this.addSession().catch(() => { }));
            }
        }
        catch (err) {
            this.log("[pool] failed to create session", {
                error: err instanceof Error ? err.message : String(err)
            });
            // Reject a waiter if there is one
            if (this.enableWaitQueue && this.waitQueue.length > 0) {
                const waiter = this.waitQueue.shift();
                waiter.reject(err instanceof Error ? err : new Error(String(err)));
            }
            // Retry after delay
            if (!this.closed && this.totalCount < this.size) {
                setTimeout(() => this.addSession().catch(() => { }), 5000);
            }
        }
        finally {
            this.creating--;
        }
    }
    /**
     * Acquire a session from the pool
     */
    async acquire() {
        // Try to get an available session
        while (this.available.length > 0) {
            const session = this.available.pop();
            if (this.isUsable(session)) {
                this.inUse.add(session);
                session.useCount++;
                this.log("[pool] acquired", {
                    sessionId: session.sessionId,
                    useCount: session.useCount,
                    ...this.stats(),
                });
                return session;
            }
            this.closeSession(session).catch(() => { });
        }
        // Create on-demand if under capacity
        this.creating++;
        if (this.totalCount <= this.size) {
            this.log("[browser miss] no available sessions; creating on-demand");
            try {
                const session = await this.createSession();
                if (this.totalCount > this.size) {
                    this.log("[pool] over capacity after on-demand create, closing", {
                        sessionId: session.sessionId,
                        ...this.stats(),
                    });
                    this.creating--;
                    await this.closeSession(session);
                }
                else {
                    this.creating--;
                    this.inUse.add(session);
                    session.useCount++;
                    this.log("[pool] on-demand session created", {
                        sessionId: session.sessionId,
                        ...this.stats(),
                    });
                    return session;
                }
            }
            catch (err) {
                this.creating--;
                throw err;
            }
        }
        else {
            this.creating--;
        }
        // Wait queue if enabled
        if (this.enableWaitQueue) {
            this.log("[pool] at capacity, waiting for session", { ...this.stats() });
            return new Promise((resolve, reject) => {
                this.waitQueue.push({ resolve, reject });
            });
        }
        throw new Error("Pool exhausted and wait queue disabled");
    }
    /**
     * Release a session back to the pool
     */
    release(session, error) {
        this.inUse.delete(session);
        if (error || !this.isUsable(session)) {
            this.closeSession(session).catch(() => { });
            this.log("[pool] released (unusable/error)", {
                sessionId: session.sessionId,
                ...this.stats(),
            });
            this.replenish();
        }
        else {
            // Update lastUsedAt since session was just used
            session.lastUsedAt = Date.now();
            // If someone is waiting, give them the session
            if (this.enableWaitQueue && this.waitQueue.length > 0) {
                const waiter = this.waitQueue.shift();
                this.inUse.add(session);
                session.useCount++;
                this.log("[pool] session reassigned to waiter", {
                    sessionId: session.sessionId,
                    ...this.stats(),
                });
                waiter.resolve(session);
            }
            else {
                this.available.push(session);
                this.log("[pool] released", {
                    sessionId: session.sessionId,
                    ...this.stats(),
                });
            }
        }
    }
    /**
     * Shutdown the pool and close all sessions
     */
    async shutdown() {
        this.closed = true;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        // Reject all waiters
        while (this.waitQueue.length > 0) {
            const waiter = this.waitQueue.shift();
            waiter.reject(new Error("Pool shutting down"));
        }
        const allSessions = [...this.available, ...this.inUse];
        this.available = [];
        this.inUse.clear();
        this.log("[pool] shutting down", { count: allSessions.length });
        await Promise.all(allSessions.map((s) => this.closeSession(s).catch(() => { })));
        this.log("[pool] shutdown complete");
    }
    /**
     * Get pool statistics
     */
    stats() {
        return {
            available: this.available.length,
            inUse: this.inUse.size,
            creating: this.creating,
            waiting: this.waitQueue.length,
            total: this.totalCount,
            maxSize: this.size,
        };
    }
}
//# sourceMappingURL=pool.js.map