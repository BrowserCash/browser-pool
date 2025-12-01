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
    connectOverCDP(cdpUrl: string): Promise<BrowserInstance>;
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
}
/**
 * Pool configuration options
 */
export interface PoolConfig {
    /** Browser.cash API key */
    apiKey: string;
    /** Chromium module (playwright-core or patchright-core) */
    chromium: ChromiumModule;
    /** Number of sessions to maintain in pool */
    size: number;
    /** Maximum uses per session before recycling (default: 50) */
    maxUses?: number;
    /** Maximum age of session in ms before recycling (default: 5 minutes) */
    maxAgeMs?: number;
    /** Maximum idle time in ms before recycling (default: 2 minutes) */
    maxIdleMs?: number;
    /** Enable health check interval (default: false) */
    enableHealthCheck?: boolean;
    /** Health check interval in ms (default: 30000) */
    healthCheckIntervalMs?: number;
    /** Enable wait queue when pool is exhausted (default: true) */
    enableWaitQueue?: boolean;
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
export interface PoolStats {
    available: number;
    inUse: number;
    creating: number;
    waiting: number;
    total: number;
    maxSize: number;
}
//# sourceMappingURL=types.d.ts.map