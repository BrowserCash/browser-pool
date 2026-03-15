import BrowsercashSDK from "@browsercash/sdk";
import type {
  BrowserInstance,
  ChromiumModule,
  ExpandedPoolTarget,
  PoolConfig,
  PoolStats,
  PoolTarget,
  PoolTargetStats,
  PooledSession,
} from "./types.js";

interface WaitQueueEntry {
  resolve: (session: PooledSession) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

interface SessionState {
  sessionId: string;
  cdpUrl: string | null;
  servedBy: string;
  status: "starting" | "active" | "completed" | "error";
}

/**
 * Browser session pool for Browser.cash.
 *
 * Manages a target-aware pool of browser sessions for efficient reuse.
 */
export class SessionPool {
  private available: PooledSession[] = [];
  private inUse: Set<PooledSession> = new Set();
  private creating = 0;
  private closed = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckInFlight = false;
  private replenishPromise: Promise<void> | null = null;
  private readonly waitQueue: WaitQueueEntry[] = [];
  private readonly creatingByTarget = new Map<string, number>();

  private readonly sdk: InstanceType<typeof BrowsercashSDK>;
  private readonly chromium: ChromiumModule;
  private readonly targets: ExpandedPoolTarget[];
  private readonly targetCounts = new Map<string, number>();
  private readonly maxUses: number;
  private readonly maxAgeMs: number;
  private readonly maxIdleMs: number | null;
  private readonly enableHealthCheck: boolean;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;
  private readonly sessionReadyTimeoutMs: number;
  private readonly cdpConnectTimeoutMs: number;
  private readonly enableWaitQueue: boolean;
  private readonly waitQueueTimeoutMs: number;
  private readonly enableDisconnectHandling: boolean;
  private readonly createPage: boolean;
  private readonly debug: boolean;
  private readonly logger: (message: string, data?: Record<string, unknown>) => void;

  constructor(config: PoolConfig) {
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
      } else {
        console.log(message);
      }
    });
  }

  private log(message: string, data?: Record<string, unknown>): void {
    if (this.debug) {
      this.logger(message, data);
    }
  }

  private get size(): number {
    return this.targets.length;
  }

  private get totalCount(): number {
    return this.available.length + this.inUse.size + this.creating;
  }

  /**
   * Initialize the pool with pre-warmed sessions.
   */
  async init(): Promise<void> {
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

  private startHealthCheck(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(() => {
      if (this.closed) return;
      void this.performHealthCheck();
    }, this.healthCheckIntervalMs);

    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  private async performHealthCheck(): Promise<void> {
    if (this.healthCheckInFlight || this.closed) return;
    this.healthCheckInFlight = true;

    try {
      const snapshot = [...this.available];
      const toReplace: PooledSession[] = [];

      await Promise.allSettled(
        snapshot.map(async (session) => {
          if (!(await this.isHealthy(session))) {
            toReplace.push(session);
          }
        }),
      );

      const deficit = this.collectMissingTargets().length;
      if (toReplace.length > 0 || deficit > 0) {
        this.log("[pool] health check: issues found", {
          toReplace: toReplace.length,
          deficit,
          ...this.stats(),
        });
      }

      await Promise.allSettled(
        toReplace.map((session) =>
          this.replaceSession(session).catch((error) => {
            this.log("[pool] replaceSession failed during health-check", {
              sessionId: session.sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        ),
      );

      if (!this.closed) {
        await this.replenish();
      }
    } finally {
      this.healthCheckInFlight = false;
    }
  }

  private async replaceSession(oldSession: PooledSession): Promise<void> {
    if (this.closed) return;

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
    } catch (error) {
      this.available.splice(idx, 1);
      this.closeSession(oldSession).catch(() => {});
      this.log("[pool] failed to create replacement session", {
        oldSessionId: oldSession.sessionId,
        targetId: target.targetId,
        targetSlotId: target.slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleTargetRetry(target);
    }
  }

  private async replenish(): Promise<void> {
    if (this.closed) return;
    if (this.replenishPromise) {
      await this.replenishPromise;
      return;
    }

    this.replenishPromise = this.runReplenish().finally(() => {
      this.replenishPromise = null;
    });

    await this.replenishPromise;
  }

  private async runReplenish(): Promise<void> {
    const missingTargets = this.collectMissingTargets();
    if (missingTargets.length === 0) return;

    this.log("[pool] replenishing", {
      deficit: missingTargets.length,
      ...this.stats(),
    });

    await Promise.allSettled(
      missingTargets.map((target) =>
        this.addSession(target).catch((error) => {
          this.log("[pool] replenish addSession failed", {
            targetId: target.targetId,
            targetSlotId: target.slotId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      ),
    );
  }

  private async addSession(target: ExpandedPoolTarget): Promise<void> {
    if (this.closed) return;
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
    } catch (error) {
      this.log("[pool] failed to create session", {
        targetId: target.targetId,
        targetSlotId: target.slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleTargetRetry(target);
      throw error;
    } finally {
      this.decrementCreating(target.slotId);
    }
  }

  private async createSessionForTarget(target: ExpandedPoolTarget): Promise<PooledSession> {
    const session = await this.sdk.browser.session.create(target.createOptions as Record<string, unknown>);
    const readySession = await this.awaitSessionReady({
      sessionId: session.sessionId,
      cdpUrl: session.cdpUrl,
      servedBy: session.servedBy,
      status: session.status,
    });

    if (!readySession?.cdpUrl) {
      try {
        await this.sdk.browser.session.stop({ sessionId: session.sessionId });
      } catch {}
      throw new Error("No CDP URL returned for session");
    }

    this.log("[cdp] session ready", {
      sessionId: readySession.sessionId,
      targetId: target.targetId,
      targetSlotId: target.slotId,
      cdpUrl: `https://dash.browser.cash/cdp_tabs?ws=${encodeURIComponent(readySession.cdpUrl)}`,
    });

    let browser: BrowserInstance;
    try {
      browser = await this.withTimeout(
        this.chromium.connectOverCDP(readySession.cdpUrl, {
          timeout: this.cdpConnectTimeoutMs,
        }),
        this.cdpConnectTimeoutMs + 2_000,
        `CDP connect timed out for ${readySession.sessionId}`,
      );
    } catch (error) {
      this.log("[pool] CDP connection failed, stopping session", {
        sessionId: readySession.sessionId,
        targetId: target.targetId,
        targetSlotId: target.slotId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.sdk.browser.session.stop({ sessionId: readySession.sessionId });
      } catch {}
      throw error;
    }

    let context: any | undefined;
    if (typeof browser.contexts === "function") {
      const contexts = browser.contexts();
      if (Array.isArray(contexts) && contexts.length > 0) {
        context = contexts[0];
      } else if (typeof browser.newContext === "function") {
        context = await browser.newContext();
      }
    }

    let page: any | undefined;
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

  private attachDisconnectHandler(session: PooledSession): void {
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
      this.closeSession(session).catch(() => {});
      const target = this.targets.find((entry) => entry.slotId === session.targetSlotId);
      if (target) {
        this.scheduleTargetRetry(target);
      } else {
        void this.replenish().catch(() => {});
      }
    });
  }

  private async closeSession(session: PooledSession | null): Promise<void> {
    if (!session) return;

    try {
      await session.browser.close().catch(() => {});
    } catch (error) {
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
    } catch (error) {
      this.log("[session] stop API failed", {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async isHealthy(session: PooledSession | null): Promise<boolean> {
    if (!this.isUsable(session)) return false;
    if (!session) return false;

    try {
      const remote = await this.withTimeout(
        this.sdk.browser.session.get({ sessionId: session.sessionId }),
        this.healthCheckTimeoutMs,
        `Health check timed out for ${session.sessionId}`,
      );

      if (remote.status === "completed" || remote.status === "error") {
        return false;
      }

      if (!remote.cdpUrl || remote.cdpUrl !== session.cdpUrl) {
        return false;
      }

      session.nodeId = remote.servedBy;
      return true;
    } catch (error) {
      this.log("[pool] remote health check failed", {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private isUsable(session: PooledSession | null): boolean {
    if (!session) return false;
    if (!session.browser.isConnected()) return false;
    if (session.useCount >= this.maxUses) return false;
    if (Date.now() - session.createdAt > this.maxAgeMs) return false;

    if (this.maxIdleMs !== null && this.maxIdleMs > 0) {
      if (Date.now() - session.lastUsedAt > this.maxIdleMs) return false;
    }

    return true;
  }

  /**
   * Acquire a session from the pool.
   */
  async acquire(): Promise<PooledSession> {
    while (this.available.length > 0) {
      const session = this.available.pop()!;
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

      this.closeSession(session).catch(() => {});
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
  release(session: PooledSession, error?: boolean): void {
    this.inUse.delete(session);

    if (error || !this.isUsable(session)) {
      this.closeSession(session).catch(() => {});
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
  async shutdown(): Promise<void> {
    this.closed = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
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

    await Promise.all(allSessions.map((session) => this.closeSession(session).catch(() => {})));
    this.log("[pool] shutdown complete");
  }

  /**
   * Get pool statistics.
   */
  stats(): PoolStats {
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

  private async createSessionForAcquire(target: ExpandedPoolTarget): Promise<PooledSession> {
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
    } finally {
      this.decrementCreating(target.slotId);
    }
  }

  private enqueueAvailableSession(session: PooledSession): void {
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

  private waitForSession(): Promise<PooledSession> {
    return new Promise((resolve, reject) => {
      const entry: WaitQueueEntry = {
        resolve,
        reject,
        timeoutId: null,
        settled: false,
      };

      entry.timeoutId = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        this.removeWaiter(entry);
        reject(new Error("Timed out waiting for an available pooled session"));
      }, this.waitQueueTimeoutMs);

      this.waitQueue.push(entry);
      void this.replenish().catch(() => {});
    });
  }

  private shiftWaiter(): WaitQueueEntry | undefined {
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      if (!waiter.settled) {
        return waiter;
      }
    }

    return undefined;
  }

  private removeWaiter(entry: WaitQueueEntry): void {
    const idx = this.waitQueue.indexOf(entry);
    if (idx !== -1) {
      this.waitQueue.splice(idx, 1);
    }
  }

  private removeSessionReferences(session: PooledSession): void {
    const availableIdx = this.available.indexOf(session);
    if (availableIdx !== -1) {
      this.available.splice(availableIdx, 1);
    }
    this.inUse.delete(session);
  }

  private async removeAndClose(session: PooledSession): Promise<void> {
    this.removeSessionReferences(session);
    await this.closeSession(session);
  }

  private scheduleTargetRetry(target: ExpandedPoolTarget): void {
    if (this.closed) return;

    setTimeout(() => {
      if (this.closed) return;
      if (this.hasSessionForTarget(target.slotId) || this.getCreatingCount(target.slotId) > 0) {
        return;
      }

      void this.addSession(target).catch(() => {});
    }, 5_000);
  }

  private collectMissingTargets(): ExpandedPoolTarget[] {
    const occupied = new Set<string>();
    for (const session of this.available) {
      occupied.add(session.targetSlotId);
    }
    for (const session of this.inUse) {
      occupied.add(session.targetSlotId);
    }

    return this.targets.filter(
      (target) => !occupied.has(target.slotId) && this.getCreatingCount(target.slotId) === 0,
    );
  }

  private pickMissingTarget(): ExpandedPoolTarget | null {
    const missing = this.collectMissingTargets();
    if (missing.length === 0) return null;

    const index = Math.floor(Date.now() % missing.length);
    return missing[index] ?? missing[0] ?? null;
  }

  private hasSessionForTarget(targetSlotId: string): boolean {
    return (
      this.available.some((session) => session.targetSlotId === targetSlotId) ||
      [...this.inUse].some((session) => session.targetSlotId === targetSlotId)
    );
  }

  private incrementCreating(targetSlotId: string): void {
    this.creating++;
    this.creatingByTarget.set(targetSlotId, this.getCreatingCount(targetSlotId) + 1);
  }

  private decrementCreating(targetSlotId: string): void {
    this.creating = Math.max(0, this.creating - 1);
    const next = this.getCreatingCount(targetSlotId) - 1;
    if (next <= 0) {
      this.creatingByTarget.delete(targetSlotId);
    } else {
      this.creatingByTarget.set(targetSlotId, next);
    }
  }

  private getCreatingCount(targetSlotId: string): number {
    return this.creatingByTarget.get(targetSlotId) ?? 0;
  }

  private buildTargetStats(): PoolTargetStats[] {
    const statsByTarget = new Map<string, PoolTargetStats>();

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
      if (!target) continue;
      target.total += 1;
      target.available += 1;
    }

    for (const session of this.inUse) {
      const target = statsByTarget.get(session.targetId);
      if (!target) continue;
      target.total += 1;
      target.inUse += 1;
    }

    for (const entry of this.targets) {
      const target = statsByTarget.get(entry.targetId);
      if (!target) continue;
      target.creating += this.getCreatingCount(entry.slotId);
    }

    return [...statsByTarget.values()];
  }

  private async awaitSessionReady(session: SessionState): Promise<SessionState | null> {
    if (session.cdpUrl) {
      return session;
    }

    const started = Date.now();
    while (Date.now() - started < this.sessionReadyTimeoutMs) {
      await sleep(500);

      let latest;
      try {
        latest = await this.withTimeout(
          this.sdk.browser.session.get({ sessionId: session.sessionId }),
          Math.min(this.healthCheckTimeoutMs, 4_000),
          `Session readiness timed out for ${session.sessionId}`,
        );
      } catch {
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

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
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

function expandTargets(config: PoolConfig): ExpandedPoolTarget[] {
  const targets = config.targets;
  if (targets && targets.length > 0) {
    const explicitIds = new Set<string>();
    for (const [index, target] of targets.entries()) {
      const id = target.id?.trim();
      if (!id) continue;
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

function expandTarget(target: PoolTarget, index: number): ExpandedPoolTarget[] {
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

function buildCreateOptions(target: PoolTarget): Record<string, unknown> {
  return {
    ...(target.sessionOptions ?? {}),
    ...(target.country ? { country: target.country } : {}),
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.type ? { type: target.type } : {}),
  };
}

function buildTargetCountMap(targets: ExpandedPoolTarget[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    counts.set(target.targetId, (counts.get(target.targetId) ?? 0) + 1);
  }
  return counts;
}

function normalizeIdleTimeout(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value <= 0) {
    return null;
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
