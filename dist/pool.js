import BrowsercashSDK from "@browsercash/sdk";
/**
 * Browser session pool for Browser.cash.
 *
 * Manages a target-aware pool of browser sessions for efficient reuse.
 */
export class SessionPool {
    available = [];
    inUse = new Set();
    creating = 0;
    closed = false;
    healthCheckTimer = null;
    healthCheckInFlight = false;
    replenishPromise = null;
    waitQueue = [];
    creatingByTarget = new Map();
    sdk;
    chromium;
    targets;
    targetCounts = new Map();
    maxUses;
    maxAgeMs;
    maxIdleMs;
    enableHealthCheck;
    healthCheckIntervalMs;
    healthCheckTimeoutMs;
    sessionReadyTimeoutMs;
    cdpConnectTimeoutMs;
    enableWaitQueue;
    waitQueueTimeoutMs;
    enableDisconnectHandling;
    createPage;
    debug;
    logger;
    constructor(config) {
        this.sdk = new BrowsercashSDK({ apiKey: config.apiKey });
        this.chromium = config.chromium;
        this.targets = expandTargets(config);
        this.targetCounts = buildTargetCountMap(this.targets);
        this.maxUses = config.maxUses ?? 50;
        this.maxAgeMs = config.maxAgeMs ?? 5 * 60 * 1000;
        this.maxIdleMs = normalizeIdleTimeout(config.maxIdleMs);
        this.enableHealthCheck = config.enableHealthCheck ?? false;
        this.healthCheckIntervalMs = config.healthCheckIntervalMs ?? 30_000;
        this.healthCheckTimeoutMs =
            config.healthCheckTimeoutMs ?? Math.min(this.healthCheckIntervalMs, 10_000);
        this.sessionReadyTimeoutMs = config.sessionReadyTimeoutMs ?? 20_000;
        this.cdpConnectTimeoutMs = config.cdpConnectTimeoutMs ?? 15_000;
        this.enableWaitQueue = config.enableWaitQueue ?? true;
        this.waitQueueTimeoutMs = config.waitQueueTimeoutMs ?? 60_000;
        this.enableDisconnectHandling = config.enableDisconnectHandling ?? true;
        this.createPage = config.createPage ?? false;
        this.debug = config.debug ?? false;
        this.logger = config.logger ?? ((message, data) => {
            if (data) {
                console.log(message, data);
            }
            else {
                console.log(message);
            }
        });
    }
    log(message, data) {
        if (this.debug) {
            this.logger(message, data);
        }
    }
    get size() {
        return this.targets.length;
    }
    get totalCount() {
        return this.available.length + this.inUse.size + this.creating;
    }
    /**
     * Initialize the pool with pre-warmed sessions.
     */
    async init() {
        this.log("[pool] initializing", { size: this.size, targets: this.targetCounts.size });
        await this.replenish();
        if (this.available.length === 0 && this.inUse.size === 0) {
            throw new Error("Failed to initialize pool: no Browser.cash sessions became ready");
        }
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
            void this.performHealthCheck();
        }, this.healthCheckIntervalMs);
        if (this.healthCheckTimer.unref) {
            this.healthCheckTimer.unref();
        }
    }
    async performHealthCheck() {
        if (this.healthCheckInFlight || this.closed)
            return;
        this.healthCheckInFlight = true;
        try {
            const snapshot = [...this.available];
            const toReplace = [];
            await Promise.allSettled(snapshot.map(async (session) => {
                if (!(await this.isHealthy(session))) {
                    toReplace.push(session);
                }
            }));
            const deficit = this.collectMissingTargets().length;
            if (toReplace.length > 0 || deficit > 0) {
                this.log("[pool] health check: issues found", {
                    toReplace: toReplace.length,
                    deficit,
                    ...this.stats(),
                });
            }
            await Promise.allSettled(toReplace.map((session) => this.replaceSession(session).catch((error) => {
                this.log("[pool] replaceSession failed during health-check", {
                    sessionId: session.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            })));
            if (!this.closed) {
                await this.replenish();
            }
        }
        finally {
            this.healthCheckInFlight = false;
        }
    }
    async replaceSession(oldSession) {
        if (this.closed)
            return;
        const target = this.targets.find((entry) => entry.slotId === oldSession.targetSlotId);
        if (!target) {
            await this.removeAndClose(oldSession);
            return;
        }
        this.log("[pool] replacing session", {
            sessionId: oldSession.sessionId,
            targetId: target.targetId,
            targetSlotId: target.slotId,
        });
        const idx = this.available.indexOf(oldSession);
        if (idx === -1) {
            return;
        }
        try {
            const newSession = await this.createSessionForTarget(target);
            this.attachDisconnectHandler(newSession);
            if (this.closed) {
                await this.closeSession(newSession);
                return;
            }
            this.available.splice(idx, 1);
            this.enqueueAvailableSession(newSession);
            this.log("[pool] session replaced", {
                oldSessionId: oldSession.sessionId,
                newSessionId: newSession.sessionId,
                targetId: target.targetId,
                targetSlotId: target.slotId,
                ...this.stats(),
            });
            this.closeSession(oldSession).catch((error) => {
                this.log("[pool] closeSession failed for replaced session", {
                    sessionId: oldSession.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
        catch (error) {
            this.available.splice(idx, 1);
            this.closeSession(oldSession).catch(() => { });
            this.log("[pool] failed to create replacement session", {
                oldSessionId: oldSession.sessionId,
                targetId: target.targetId,
                targetSlotId: target.slotId,
                error: error instanceof Error ? error.message : String(error),
            });
            this.scheduleTargetRetry(target);
        }
    }
    async replenish() {
        if (this.closed)
            return;
        if (this.replenishPromise) {
            await this.replenishPromise;
            return;
        }
        this.replenishPromise = this.runReplenish().finally(() => {
            this.replenishPromise = null;
        });
        await this.replenishPromise;
    }
    async runReplenish() {
        const missingTargets = this.collectMissingTargets();
        if (missingTargets.length === 0)
            return;
        this.log("[pool] replenishing", {
            deficit: missingTargets.length,
            ...this.stats(),
        });
        await Promise.allSettled(missingTargets.map((target) => this.addSession(target).catch((error) => {
            this.log("[pool] replenish addSession failed", {
                targetId: target.targetId,
                targetSlotId: target.slotId,
                error: error instanceof Error ? error.message : String(error),
            });
        })));
    }
    async addSession(target) {
        if (this.closed)
            return;
        if (this.hasSessionForTarget(target.slotId) || this.getCreatingCount(target.slotId) > 0) {
            return;
        }
        this.incrementCreating(target.slotId);
        try {
            const session = await this.createSessionForTarget(target);
            this.attachDisconnectHandler(session);
            if (this.closed) {
                await this.closeSession(session);
                return;
            }
            if (this.hasSessionForTarget(target.slotId)) {
                this.log("[pool] target already filled after create, closing duplicate", {
                    sessionId: session.sessionId,
                    targetId: target.targetId,
                    targetSlotId: target.slotId,
                });
                await this.closeSession(session);
                return;
            }
            this.enqueueAvailableSession(session);
            this.log("[pool] session added to pool", {
                sessionId: session.sessionId,
                targetId: target.targetId,
                targetSlotId: target.slotId,
                nodeId: session.nodeId,
                ...this.stats(),
            });
        }
        catch (error) {
            this.log("[pool] failed to create session", {
                targetId: target.targetId,
                targetSlotId: target.slotId,
                error: error instanceof Error ? error.message : String(error),
            });
            this.scheduleTargetRetry(target);
            throw error;
        }
        finally {
            this.decrementCreating(target.slotId);
        }
    }
    async createSessionForTarget(target) {
        const session = await this.sdk.browser.session.create(target.createOptions);
        const readySession = await this.awaitSessionReady({
            sessionId: session.sessionId,
            cdpUrl: session.cdpUrl,
            servedBy: session.servedBy,
            status: session.status,
        });
        if (!readySession?.cdpUrl) {
            try {
                await this.sdk.browser.session.stop({ sessionId: session.sessionId });
            }
            catch { }
            throw new Error("No CDP URL returned for session");
        }
        this.log("[cdp] session ready", {
            sessionId: readySession.sessionId,
            targetId: target.targetId,
            targetSlotId: target.slotId,
            cdpUrl: `https://dash.browser.cash/cdp_tabs?ws=${encodeURIComponent(readySession.cdpUrl)}`,
        });
        let browser;
        try {
            browser = await this.withTimeout(this.chromium.connectOverCDP(readySession.cdpUrl, {
                timeout: this.cdpConnectTimeoutMs,
            }), this.cdpConnectTimeoutMs + 2_000, `CDP connect timed out for ${readySession.sessionId}`);
        }
        catch (error) {
            this.log("[pool] CDP connection failed, stopping session", {
                sessionId: readySession.sessionId,
                targetId: target.targetId,
                targetSlotId: target.slotId,
                error: error instanceof Error ? error.message : String(error),
            });
            try {
                await this.sdk.browser.session.stop({ sessionId: readySession.sessionId });
            }
            catch { }
            throw error;
        }
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
        let page;
        if (this.createPage && context && typeof context.newPage === "function") {
            page = await context.newPage();
        }
        const now = Date.now();
        return {
            sessionId: readySession.sessionId,
            cdpUrl: readySession.cdpUrl,
            browser,
            createdAt: now,
            useCount: 0,
            lastUsedAt: now,
            context,
            page,
            nodeId: readySession.servedBy,
            targetId: target.targetId,
            targetSlotId: target.slotId,
        };
    }
    attachDisconnectHandler(session) {
        if (!this.enableDisconnectHandling || typeof session.browser.on !== "function") {
            return;
        }
        session.browser.on("disconnected", () => {
            this.log("[pool] browser disconnected", {
                sessionId: session.sessionId,
                targetId: session.targetId,
                targetSlotId: session.targetSlotId,
                ageMs: Date.now() - session.createdAt,
                useCount: session.useCount,
            });
            this.removeSessionReferences(session);
            this.closeSession(session).catch(() => { });
            const target = this.targets.find((entry) => entry.slotId === session.targetSlotId);
            if (target) {
                this.scheduleTargetRetry(target);
            }
            else {
                void this.replenish().catch(() => { });
            }
        });
    }
    async closeSession(session) {
        if (!session)
            return;
        try {
            await session.browser.close().catch(() => { });
        }
        catch (error) {
            this.log("[pool] browser close warning", {
                sessionId: session.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        try {
            await this.sdk.browser.session.stop({ sessionId: session.sessionId });
            this.log("[session] stopped", {
                sessionId: session.sessionId,
                targetId: session.targetId,
                targetSlotId: session.targetSlotId,
            });
        }
        catch (error) {
            this.log("[session] stop API failed", {
                sessionId: session.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    async isHealthy(session) {
        if (!this.isUsable(session))
            return false;
        if (!session)
            return false;
        try {
            const remote = await this.withTimeout(this.sdk.browser.session.get({ sessionId: session.sessionId }), this.healthCheckTimeoutMs, `Health check timed out for ${session.sessionId}`);
            if (remote.status === "completed" || remote.status === "error") {
                return false;
            }
            if (!remote.cdpUrl || remote.cdpUrl !== session.cdpUrl) {
                return false;
            }
            session.nodeId = remote.servedBy;
            return true;
        }
        catch (error) {
            this.log("[pool] remote health check failed", {
                sessionId: session.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
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
        if (this.maxIdleMs !== null && this.maxIdleMs > 0) {
            if (Date.now() - session.lastUsedAt > this.maxIdleMs)
                return false;
        }
        return true;
    }
    /**
     * Acquire a session from the pool.
     */
    async acquire() {
        while (this.available.length > 0) {
            const session = this.available.pop();
            if (this.isUsable(session)) {
                this.inUse.add(session);
                session.useCount++;
                session.lastUsedAt = Date.now();
                this.log("[pool] acquired", {
                    sessionId: session.sessionId,
                    targetId: session.targetId,
                    targetSlotId: session.targetSlotId,
                    useCount: session.useCount,
                    ...this.stats(),
                });
                return session;
            }
            this.closeSession(session).catch(() => { });
            const target = this.targets.find((entry) => entry.slotId === session.targetSlotId);
            if (target) {
                this.scheduleTargetRetry(target);
            }
        }
        const missingTarget = this.pickMissingTarget();
        if (missingTarget) {
            this.log("[pool] no available sessions; creating on-demand", {
                targetId: missingTarget.targetId,
                targetSlotId: missingTarget.slotId,
            });
            return this.createSessionForAcquire(missingTarget);
        }
        if (this.enableWaitQueue) {
            this.log("[pool] at capacity, waiting for session", { ...this.stats() });
            return this.waitForSession();
        }
        throw new Error("Pool exhausted and wait queue disabled");
    }
    /**
     * Release a session back to the pool.
     */
    release(session, error) {
        this.inUse.delete(session);
        if (error || !this.isUsable(session)) {
            this.closeSession(session).catch(() => { });
            this.log("[pool] released (unusable/error)", {
                sessionId: session.sessionId,
                targetId: session.targetId,
                targetSlotId: session.targetSlotId,
                ...this.stats(),
            });
            const target = this.targets.find((entry) => entry.slotId === session.targetSlotId);
            if (target) {
                this.scheduleTargetRetry(target);
            }
            return;
        }
        session.lastUsedAt = Date.now();
        this.enqueueAvailableSession(session);
        this.log("[pool] released", {
            sessionId: session.sessionId,
            targetId: session.targetId,
            targetSlotId: session.targetSlotId,
            ...this.stats(),
        });
    }
    /**
     * Shutdown the pool and close all sessions.
     */
    async shutdown() {
        this.closed = true;
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        while (this.waitQueue.length > 0) {
            const waiter = this.waitQueue.shift();
            waiter.settled = true;
            if (waiter.timeoutId) {
                clearTimeout(waiter.timeoutId);
            }
            waiter.reject(new Error("Pool shutting down"));
        }
        const allSessions = [...this.available, ...this.inUse];
        this.available = [];
        this.inUse.clear();
        this.log("[pool] shutting down", { count: allSessions.length });
        await Promise.all(allSessions.map((session) => this.closeSession(session).catch(() => { })));
        this.log("[pool] shutdown complete");
    }
    /**
     * Get pool statistics.
     */
    stats() {
        return {
            available: this.available.length,
            inUse: this.inUse.size,
            creating: this.creating,
            waiting: this.waitQueue.length,
            total: this.totalCount,
            maxSize: this.size,
            desired: this.size,
            targets: this.buildTargetStats(),
        };
    }
    async createSessionForAcquire(target) {
        if (this.hasSessionForTarget(target.slotId) || this.getCreatingCount(target.slotId) > 0) {
            return this.acquire();
        }
        this.incrementCreating(target.slotId);
        try {
            const session = await this.createSessionForTarget(target);
            this.attachDisconnectHandler(session);
            if (this.closed) {
                await this.closeSession(session);
                throw new Error("Pool is closed");
            }
            if (this.hasSessionForTarget(target.slotId)) {
                await this.closeSession(session);
                return this.acquire();
            }
            this.inUse.add(session);
            session.useCount++;
            session.lastUsedAt = Date.now();
            this.log("[pool] on-demand session created", {
                sessionId: session.sessionId,
                targetId: session.targetId,
                targetSlotId: session.targetSlotId,
                ...this.stats(),
            });
            return session;
        }
        finally {
            this.decrementCreating(target.slotId);
        }
    }
    enqueueAvailableSession(session) {
        if (this.enableWaitQueue) {
            const waiter = this.shiftWaiter();
            if (waiter) {
                this.inUse.add(session);
                session.useCount++;
                session.lastUsedAt = Date.now();
                waiter.settled = true;
                if (waiter.timeoutId) {
                    clearTimeout(waiter.timeoutId);
                }
                waiter.resolve(session);
                this.log("[pool] session assigned to waiter", {
                    sessionId: session.sessionId,
                    targetId: session.targetId,
                    targetSlotId: session.targetSlotId,
                    ...this.stats(),
                });
                return;
            }
        }
        this.available.push(session);
    }
    waitForSession() {
        return new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                timeoutId: null,
                settled: false,
            };
            entry.timeoutId = setTimeout(() => {
                if (entry.settled)
                    return;
                entry.settled = true;
                this.removeWaiter(entry);
                reject(new Error("Timed out waiting for an available pooled session"));
            }, this.waitQueueTimeoutMs);
            this.waitQueue.push(entry);
            void this.replenish().catch(() => { });
        });
    }
    shiftWaiter() {
        while (this.waitQueue.length > 0) {
            const waiter = this.waitQueue.shift();
            if (!waiter.settled) {
                return waiter;
            }
        }
        return undefined;
    }
    removeWaiter(entry) {
        const idx = this.waitQueue.indexOf(entry);
        if (idx !== -1) {
            this.waitQueue.splice(idx, 1);
        }
    }
    removeSessionReferences(session) {
        const availableIdx = this.available.indexOf(session);
        if (availableIdx !== -1) {
            this.available.splice(availableIdx, 1);
        }
        this.inUse.delete(session);
    }
    async removeAndClose(session) {
        this.removeSessionReferences(session);
        await this.closeSession(session);
    }
    scheduleTargetRetry(target) {
        if (this.closed)
            return;
        setTimeout(() => {
            if (this.closed)
                return;
            if (this.hasSessionForTarget(target.slotId) || this.getCreatingCount(target.slotId) > 0) {
                return;
            }
            void this.addSession(target).catch(() => { });
        }, 5_000);
    }
    collectMissingTargets() {
        const occupied = new Set();
        for (const session of this.available) {
            occupied.add(session.targetSlotId);
        }
        for (const session of this.inUse) {
            occupied.add(session.targetSlotId);
        }
        return this.targets.filter((target) => !occupied.has(target.slotId) && this.getCreatingCount(target.slotId) === 0);
    }
    pickMissingTarget() {
        const missing = this.collectMissingTargets();
        if (missing.length === 0)
            return null;
        const index = Math.floor(Date.now() % missing.length);
        return missing[index] ?? missing[0] ?? null;
    }
    hasSessionForTarget(targetSlotId) {
        return (this.available.some((session) => session.targetSlotId === targetSlotId) ||
            [...this.inUse].some((session) => session.targetSlotId === targetSlotId));
    }
    incrementCreating(targetSlotId) {
        this.creating++;
        this.creatingByTarget.set(targetSlotId, this.getCreatingCount(targetSlotId) + 1);
    }
    decrementCreating(targetSlotId) {
        this.creating = Math.max(0, this.creating - 1);
        const next = this.getCreatingCount(targetSlotId) - 1;
        if (next <= 0) {
            this.creatingByTarget.delete(targetSlotId);
        }
        else {
            this.creatingByTarget.set(targetSlotId, next);
        }
    }
    getCreatingCount(targetSlotId) {
        return this.creatingByTarget.get(targetSlotId) ?? 0;
    }
    buildTargetStats() {
        const statsByTarget = new Map();
        for (const [targetId, desired] of this.targetCounts.entries()) {
            statsByTarget.set(targetId, {
                targetId,
                desired,
                total: 0,
                available: 0,
                inUse: 0,
                creating: 0,
            });
        }
        for (const session of this.available) {
            const target = statsByTarget.get(session.targetId);
            if (!target)
                continue;
            target.total += 1;
            target.available += 1;
        }
        for (const session of this.inUse) {
            const target = statsByTarget.get(session.targetId);
            if (!target)
                continue;
            target.total += 1;
            target.inUse += 1;
        }
        for (const entry of this.targets) {
            const target = statsByTarget.get(entry.targetId);
            if (!target)
                continue;
            target.creating += this.getCreatingCount(entry.slotId);
        }
        return [...statsByTarget.values()];
    }
    async awaitSessionReady(session) {
        if (session.cdpUrl) {
            return session;
        }
        const started = Date.now();
        while (Date.now() - started < this.sessionReadyTimeoutMs) {
            await sleep(500);
            let latest;
            try {
                latest = await this.withTimeout(this.sdk.browser.session.get({ sessionId: session.sessionId }), Math.min(this.healthCheckTimeoutMs, 4_000), `Session readiness timed out for ${session.sessionId}`);
            }
            catch {
                continue;
            }
            if (latest.cdpUrl && (latest.status === "active" || latest.status === "starting")) {
                return {
                    sessionId: latest.sessionId,
                    cdpUrl: latest.cdpUrl,
                    servedBy: latest.servedBy,
                    status: latest.status,
                };
            }
            if (latest.status === "completed" || latest.status === "error") {
                return null;
            }
        }
        return null;
    }
    withTimeout(promise, timeoutMs, message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            promise
                .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
                .catch((error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
    }
}
function expandTargets(config) {
    const targets = config.targets;
    if (targets && targets.length > 0) {
        const explicitIds = new Set();
        for (const [index, target] of targets.entries()) {
            const id = target.id?.trim();
            if (!id)
                continue;
            if (explicitIds.has(id)) {
                throw new Error(`Pool target ID "${id}" is duplicated at index ${index}`);
            }
            explicitIds.add(id);
        }
        const expanded = targets.flatMap((target, index) => expandTarget(target, index));
        if (typeof config.size === "number" && config.size !== expanded.length) {
            throw new Error("PoolConfig.size must match the total count across PoolConfig.targets");
        }
        return expanded;
    }
    const size = config.size ?? 0;
    if (!Number.isInteger(size) || size <= 0) {
        throw new Error("PoolConfig.size must be a positive integer when targets are not provided");
    }
    return Array.from({ length: size }, (_, slotIndex) => ({
        targetId: "default",
        slotId: `default-slot-${slotIndex}`,
        createOptions: {},
    }));
}
function expandTarget(target, index) {
    if (!Number.isInteger(target.count) || target.count <= 0) {
        throw new Error(`Pool target at index ${index} must have a positive integer count`);
    }
    const targetId = target.id?.trim() || `target-${index}`;
    const createOptions = buildCreateOptions(target);
    return Array.from({ length: target.count }, (_, slotIndex) => ({
        targetId,
        slotId: `${targetId}-slot-${slotIndex}`,
        createOptions,
    }));
}
function buildCreateOptions(target) {
    return {
        ...(target.sessionOptions ?? {}),
        ...(target.country ? { country: target.country } : {}),
        ...(target.nodeId ? { nodeId: target.nodeId } : {}),
        ...(target.type ? { type: target.type } : {}),
    };
}
function buildTargetCountMap(targets) {
    const counts = new Map();
    for (const target of targets) {
        counts.set(target.targetId, (counts.get(target.targetId) ?? 0) + 1);
    }
    return counts;
}
function normalizeIdleTimeout(value) {
    if (value === null || value === undefined || value <= 0) {
        return null;
    }
    return value;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=pool.js.map