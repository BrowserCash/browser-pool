import type { PoolConfig, PoolStats, PooledSession } from "./types.js";
/**
 * Browser session pool for Browser.cash.
 *
 * Manages a target-aware pool of browser sessions for efficient reuse.
 */
export declare class SessionPool {
    private available;
    private inUse;
    private creating;
    private closed;
    private healthCheckTimer;
    private healthCheckInFlight;
    private replenishPromise;
    private readonly waitQueue;
    private readonly creatingByTarget;
    private readonly sdk;
    private readonly chromium;
    private readonly targets;
    private readonly targetCounts;
    private readonly maxUses;
    private readonly maxAgeMs;
    private readonly maxIdleMs;
    private readonly enableHealthCheck;
    private readonly healthCheckIntervalMs;
    private readonly healthCheckTimeoutMs;
    private readonly sessionReadyTimeoutMs;
    private readonly cdpConnectTimeoutMs;
    private readonly enableWaitQueue;
    private readonly waitQueueTimeoutMs;
    private readonly enableDisconnectHandling;
    private readonly createPage;
    private readonly debug;
    private readonly logger;
    constructor(config: PoolConfig);
    private log;
    private get size();
    private get totalCount();
    /**
     * Initialize the pool with pre-warmed sessions.
     */
    init(): Promise<void>;
    private startHealthCheck;
    private performHealthCheck;
    private replaceSession;
    private replenish;
    private runReplenish;
    private addSession;
    private createSessionForTarget;
    private attachDisconnectHandler;
    private closeSession;
    private isHealthy;
    private isUsable;
    /**
     * Acquire a session from the pool.
     */
    acquire(): Promise<PooledSession>;
    /**
     * Release a session back to the pool.
     */
    release(session: PooledSession, error?: boolean): void;
    /**
     * Shutdown the pool and close all sessions.
     */
    shutdown(): Promise<void>;
    /**
     * Get pool statistics.
     */
    stats(): PoolStats;
    private createSessionForAcquire;
    private enqueueAvailableSession;
    private waitForSession;
    private shiftWaiter;
    private removeWaiter;
    private removeSessionReferences;
    private removeAndClose;
    private scheduleTargetRetry;
    private collectMissingTargets;
    private pickMissingTarget;
    private hasSessionForTarget;
    private incrementCreating;
    private decrementCreating;
    private getCreatingCount;
    private buildTargetStats;
    private awaitSessionReady;
    private withTimeout;
}
//# sourceMappingURL=pool.d.ts.map