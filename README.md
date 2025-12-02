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
    <a href="https://github.com/Mega-Tera/teracrawl"><strong>Teracrawl</strong></a> and 
    <a href="https://github.com/Mega-Tera/browser-serp"><strong>Browser SERP</strong></a>.
  </p>
</div>

---

## 🚀 What is Browser Pool?

**Browser Pool** is a specialized library designed to manage pools of remote browser sessions. It handles the lifecycle of Playwright browsers connected to **Browser.cash**, ensuring your application always has a healthy browser ready to perform tasks.

It abstracts away the complexity of connection management, error recovery, and session recycling, making it ideal for building high-concurrency scrapers and automation tools.

## <a id="features"></a>✨ Features

- **Automatic Pooling**: Maintains a fixed number of active browser sessions.
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
import { SessionPool } from "@browsercash/pool";

// 1. Create the pool
const pool = new SessionPool({
  apiKey: process.env.BROWSER_API_KEY,
  chromium: chromium, // Inject your preferred chromium instance
  size: 3, // Maintain 3 concurrent sessions
});

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

## <a id="configuration"></a>⚙️ Configuration

| Option                  | Type             | Default      | Description                                     |
| :---------------------- | :--------------- | :----------- | :---------------------------------------------- |
| `apiKey`                | `string`         | **Required** | Your Browser.cash API key.                      |
| `chromium`              | `ChromiumModule` | **Required** | The Playwright Chromium module.                 |
| `size`                  | `number`         | `1`          | Number of concurrent sessions to maintain.      |
| `maxUses`               | `number`         | `50`         | Max times a browser is reused before recycling. |
| `maxAgeMs`              | `number`         | `300000`     | Max age (ms) of a session (default: 5 mins).    |
| `enableHealthCheck`     | `boolean`        | `false`      | Enable background health pings.                 |
| `healthCheckIntervalMs` | `number`         | `30000`      | Interval for health checks (ms).                |
| `enableWaitQueue`       | `boolean`        | `true`       | Queue acquire requests if pool is full.         |
| `debug`                 | `boolean`        | `false`      | Enable verbose logging.                         |

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
