import type { PoolConfig, PoolStats, PooledSession } from "./types.js";
/**
 * Browser session pool for Browser.cash
 *
 * Manages a pool of browser sessions for efficient reuse.
 */
export declare class SessionPool {
    private available;
    private inUse;
    private creating;
    private closed;
    private healthCheckTimer;
    private waitQueue;
    private readonly sdk;
    private readonly chromium;
    private readonly size;
    private readonly maxUses;
    private readonly maxAgeMs;
    private readonly maxIdleMs;
    private readonly enableHealthCheck;
    private readonly healthCheckIntervalMs;
    private readonly enableWaitQueue;
    private readonly enableDisconnectHandling;
    private readonly debug;
    private readonly logger;
    constructor(config: PoolConfig);
    private log;
    private get totalCount();
    /**
     * Initialize the pool with pre-warmed sessions
     */
    init(): Promise<void>;
    private startHealthCheck;
    private performHealthCheck;
    /**
     * Replace a session: create new one first, confirm it's good, then remove old
     */
    private replaceSession;
    private replenish;
    private createSession;
    private closeSession;
    private isUsable;
    private addSession;
    /**
     * Acquire a session from the pool
     */
    acquire(): Promise<PooledSession>;
    /**
     * Release a session back to the pool
     */
    release(session: PooledSession, error?: boolean): void;
    /**
     * Shutdown the pool and close all sessions
     */
    shutdown(): Promise<void>;
    /**
     * Get pool statistics
     */
    stats(): PoolStats;
}
//# sourceMappingURL=pool.d.ts.map