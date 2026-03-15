<div align="center">
  <h1>🌊 Browser Pool</h1>
  <p>
    <strong>Robust browser session management for Playwright & Browser.cash.</strong>
  </p>
  <p>
    Powered by <a href="https://browser.cash/developers">Browser.cash</a> remote browsers.
  </p>

  <p>
    <a href="#features">Features</a> •
    <a href="#installation">Installation</a> •
    <a href="#usage">Usage</a> •
    <a href="#configuration">Configuration</a> •
    <a href="#contributing">Contributing</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
    <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="Node.js Version">
    <img src="https://img.shields.io/badge/typescript-5.6-blue" alt="TypeScript">
    <img src="https://img.shields.io/badge/powered%20by-browser.cash-orange" alt="Visit Browser.cash">
  </p>

  <p>
    <a href="https://x.com/aibrowsers">
      <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
    </a>
    <a href="https://linkedin.com/company/megatera">
      <img src="https://img.shields.io/badge/Follow%20on%20LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white" alt="Follow on LinkedIn" />
    </a>
    <a href="https://discord.gg/F9afFJPtYb">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
  </p>

  <br>

  <p>
    💡 <strong>Pro Tip:</strong> See this library in action in 
    <a href="https://github.com/BrowserCash/teracrawl"><strong>Teracrawl</strong></a> and 
    <a href="https://github.com/BrowserCash/browser-serp"><strong>Browser SERP</strong></a>.
  </p>
</div>

---

## 🚀 What is Browser Pool?

**Browser Pool** is a specialized library designed to manage pools of remote browser sessions. It handles the lifecycle of Playwright browsers connected to **Browser.cash**, ensuring your application always has a healthy browser ready to perform tasks.

It abstracts away the complexity of connection management, error recovery, and session recycling, making it ideal for building high-concurrency scrapers and automation tools.

## <a id="features"></a>✨ Features

- **Automatic Pooling**: Maintains a fixed number of active browser sessions.
- **Target-Aware Pooling**: Specify exactly how many browsers you want per node, country, or node type.
- **Self-Healing**: Automatically detects and replaces dead or disconnected browsers.
- **Health Checks**: Periodically verifies browser responsiveness.
- **Concurrency Control**: Queues requests when all sessions are busy.
- **Type-Safe**: Written in TypeScript with full type definitions.

## <a id="installation"></a>🛠️ Installation

```bash
npm install @browsercash/pool
```

_Note: You must also have `playwright-core` installed as a peer dependency._

## <a id="usage"></a>💻 Usage

```typescript
import { chromium } from "playwright-core";
import { SessionPool, type PoolConfig } from "@browsercash/pool";

const cfg: PoolConfig = {
  apiKey: process.env.BROWSER_API_KEY,
  chromium,
  targets: [
    { id: "us-hosted", count: 2, country: "US", type: "hosted" },
    { id: "de-consumer", count: 1, country: "DE", type: "consumer_distributed" },
    { id: "pinned-node", count: 1, nodeId: "node_123" },
  ],
  enableHealthCheck: true,
  waitQueueTimeoutMs: 30_000,
};

// 1. Create the pool
const pool = new SessionPool(cfg);

// 2. Initialize
await pool.init();

// 3. Acquire a session (waits if none available)
const session = await pool.acquire();

try {
  // Use the standard Playwright browser instance
  const page = await session.browser.newPage();
  await page.goto("https://example.com");
  console.log(await page.title());
} finally {
  // 4. Always release the session back to the pool
  // Pass 'true' as second arg if the session encountered a fatal error
  pool.release(session);
}

// 5. Cleanup on shutdown
await pool.shutdown();
```

There is also a dedicated example config file in
[examples/browser-pool.config.mjs](/Users/alexspring/Desktop/Programming/Typescript/browser-pool/examples/browser-pool.config.mjs).

If you just want the old behavior, `size` still works:

```typescript
const pool = new SessionPool({
  apiKey: process.env.BROWSER_API_KEY,
  chromium,
  size: 3,
});
```

### Example CFG

```typescript
import { chromium } from "playwright-core";
import { type PoolConfig } from "@browsercash/pool";

export const browserPoolCfg: PoolConfig = {
  apiKey: process.env.BROWSER_API_KEY!,
  chromium,
  targets: [
    { id: "us-primary", count: 2, country: "US", type: "hosted" },
    { id: "eu-fallback", count: 2, country: "DE", type: "consumer_distributed" },
    { id: "pinned-fraud-node", count: 1, nodeId: "node_123" },
  ],
  maxUses: 25,
  maxAgeMs: 10 * 60 * 1000,
  maxIdleMs: null,
  enableHealthCheck: true,
  healthCheckIntervalMs: 30_000,
  sessionReadyTimeoutMs: 30_000,
  cdpConnectTimeoutMs: 15_000,
  waitQueueTimeoutMs: 60_000,
};
```

Equivalent standalone file:

```javascript
// examples/browser-pool.config.mjs
import { chromium } from "playwright-core";

export const browserPoolCfg = {
  apiKey: process.env.BROWSER_API_KEY,
  chromium,
  targets: [
    { id: "de-consumer", count: 1, country: "DE", type: "consumer_distributed" },
  ],
  maxUses: 25,
  maxAgeMs: 10 * 60 * 1000,
  maxIdleMs: null,
  enableHealthCheck: true,
  healthCheckIntervalMs: 30_000,
  sessionReadyTimeoutMs: 30_000,
  cdpConnectTimeoutMs: 15_000,
  waitQueueTimeoutMs: 60_000,
};
```

For a larger production mix, expand `targets` with more entries such as hosted US nodes or pinned `nodeId` targets.

## <a id="configuration"></a>⚙️ Configuration

| Option | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `apiKey` | `string` | **Required** | Your Browser.cash API key. |
| `chromium` | `ChromiumModule` | **Required** | The Playwright Chromium module. |
| `size` | `number` | `1` | Backward-compatible shortcut for a single default target group. |
| `targets` | `PoolTarget[]` | `[]` | Explicit target mix. Sum of `count` values becomes the pool size. |
| `maxUses` | `number` | `50` | Max times a browser is reused before recycling. |
| `maxAgeMs` | `number` | `300000` | Max age (ms) of a session before recycling. |
| `maxIdleMs` | `number \| null` | `null` | Max idle time before recycling. `null` or `0` disables idle recycling. |
| `enableHealthCheck` | `boolean` | `false` | Enable background remote health checks. |
| `healthCheckIntervalMs` | `number` | `30000` | Interval for health checks (ms). |
| `healthCheckTimeoutMs` | `number` | `min(interval, 10000)` | Timeout for each health-check request. |
| `sessionReadyTimeoutMs` | `number` | `20000` | How long to wait for Browser.cash to return a usable CDP URL. |
| `cdpConnectTimeoutMs` | `number` | `15000` | Timeout for Playwright `connectOverCDP`. |
| `enableWaitQueue` | `boolean` | `true` | Queue acquire requests if pool is full. |
| `waitQueueTimeoutMs` | `number` | `60000` | Max time an acquire call will wait in queue. |
| `enableDisconnectHandling` | `boolean` | `true` | Replace sessions when the CDP connection disconnects. |
| `createPage` | `boolean` | `false` | Pre-create a page for each pooled session. |
| `debug` | `boolean` | `false` | Enable verbose logging. |
| `logger` | `(message, data) => void` | `console.log` | Custom logger used when `debug` is enabled. |

### `PoolTarget`

```typescript
type PoolTarget = {
  id?: string;
  count: number;
  nodeId?: string;
  country?: string;
  type?: "consumer_distributed" | "hosted";
  sessionOptions?: Record<string, unknown>;
};
```

- Use `count` to pin how many sessions should exist for that target.
- Use `nodeId` when you want a specific Browser.cash node.
- Use `country` and `type` when you want the pool to maintain a regional mix.
- Use `sessionOptions` as a pass-through for newer Browser.cash session-create fields.

## <a id="contributing"></a>🤝 Contributing

Contributions are welcome! We appreciate your help in making Browser Pool better.

### How to Contribute

1.  **Fork the Project**: click the 'Fork' button at the top right of this page.
2.  **Create your Feature Branch**: `git checkout -b feature/AmazingFeature`
3.  **Commit your Changes**: `git commit -m 'Add some AmazingFeature'`
4.  **Push to the Branch**: `git push origin feature/AmazingFeature`
5.  **Open a Pull Request**: Submit your changes for review.

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.
