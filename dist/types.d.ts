/**
 * Browser instance interface - compatible with playwright-core and patchright-core
 */
export interface BrowserInstance {
    isConnected(): boolean;
    close(): Promise<void>;
    on?(event: string, listener: (...args: any[]) => void): void;
    off?(event: string, listener: (...args: any[]) => void): void;
    contexts?(): any[];
    newContext?(): Promise<any>;
}
/**
 * Chromium module interface - for connecting via CDP
 */
export interface ChromiumModule {
    connectOverCDP(cdpUrl: string, options?: {
        timeout?: number;
    }): Promise<BrowserInstance>;
}
export type BrowserSessionType = "consumer_distributed" | "hosted";
/**
 * Browser.cash session create options.
 *
 * Additional keys are allowed so the pool can pass through newer SDK/API
 * fields without requiring a library release first.
 */
export interface BrowserSessionCreateOptions {
    nodeId?: string;
    country?: string;
    type?: BrowserSessionType;
    [key: string]: unknown;
}
/**
 * Desired target mix for the pool.
 */
export interface PoolTarget {
    /** Optional stable ID for stats and debugging */
    id?: string;
    /** Number of sessions to keep warm for this target */
    count: number;
    /** Specific Browser.cash node to target */
    nodeId?: string;
    /** 2-letter ISO country code */
    country?: string;
    /** Browser.cash node type */
    type?: BrowserSessionType;
    /** Additional session-create options passed through to Browser.cash */
    sessionOptions?: Record<string, unknown>;
}
/**
 * Internal expanded target slot.
 */
export interface ExpandedPoolTarget {
    targetId: string;
    slotId: string;
    createOptions: BrowserSessionCreateOptions;
}
/**
 * A pooled browser session
 */
export interface PooledSession {
    sessionId: string;
    cdpUrl: string;
    browser: BrowserInstance;
    createdAt: number;
    useCount: number;
    lastUsedAt: number;
    /** Optional: BrowserContext created for this session (if available) */
    context?: any;
    /** Optional: Pre-created Page for this session when enabled via config */
    page?: any;
    /** Optional: The node ID that this session is running on */
    nodeId?: string;
    /** Logical target group ID from the pool config */
    targetId: string;
    /** Unique target slot ID from the pool config */
    targetSlotId: string;
}
/**
 * Pool configuration options
 */
export interface PoolConfig {
    /** Browser.cash API key */
    apiKey: string;
    /** Chromium module (playwright-core or patchright-core) */
    chromium: ChromiumModule;
    /**
     * Number of sessions to maintain in the pool.
     *
     * Backward compatible shortcut for a single default target group. If `targets`
     * is provided, `size` becomes optional and must match the sum of target counts
     * when specified.
     */
    size?: number;
    /** Target-aware pool configuration */
    targets?: PoolTarget[];
    /** Maximum uses per session before recycling (default: 50) */
    maxUses?: number;
    /** Maximum age of session in ms before recycling (default: 5 minutes) */
    maxAgeMs?: number;
    /** Maximum idle time in ms before recycling. Set to `null` or `0` to disable. */
    maxIdleMs?: number | null;
    /** Enable health check interval (default: false) */
    enableHealthCheck?: boolean;
    /** Health check interval in ms (default: 30000) */
    healthCheckIntervalMs?: number;
    /** Timeout for a single health check request (default: min(interval, 10000)) */
    healthCheckTimeoutMs?: number;
    /** Timeout while waiting for a new session to become ready (default: 20000) */
    sessionReadyTimeoutMs?: number;
    /** Timeout while connecting Playwright over CDP (default: 15000) */
    cdpConnectTimeoutMs?: number;
    /** Enable wait queue when pool is exhausted (default: true) */
    enableWaitQueue?: boolean;
    /** Timeout for queued acquire requests (default: 60000) */
    waitQueueTimeoutMs?: number;
    /** Enable CDP disconnect event handling (default: true) */
    enableDisconnectHandling?: boolean;
    /** When true, pre-create a browser Page for each session and expose it on the pooled session (default: false) */
    createPage?: boolean;
    /** Enable debug logging (default: false) */
    debug?: boolean;
    /** Custom logger function */
    logger?: (message: string, data?: Record<string, any>) => void;
}
/**
 * Pool statistics
 */
export interface PoolTargetStats {
    targetId: string;
    desired: number;
    total: number;
    available: number;
    inUse: number;
    creating: number;
}
export interface PoolStats {
    available: number;
    inUse: number;
    creating: number;
    waiting: number;
    total: number;
    maxSize: number;
    desired: number;
    targets: PoolTargetStats[];
}
//# sourceMappingURL=types.d.ts.map