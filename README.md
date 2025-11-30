# @browsercash/pool

Shared browser session pool for Browser.cash services.

## Installation

```bash
# From another package in the monorepo
npm install @browsercash/pool@file:../browsercash-pool
```

## Usage

```typescript
import { chromium } from 'playwright-core';
import { SessionPool } from '@browsercash/pool';

const pool = new SessionPool({
  apiKey: process.env.BROWSER_API_KEY,
  chromium: chromium,
  size: 3,
  
  // Optional configuration
  maxUses: 50,                    // Max uses per session before recycling
  maxAgeMs: 5 * 60 * 1000,        // Max age before recycling (5 min)
  enableHealthCheck: true,        // Periodic health checks
  healthCheckIntervalMs: 30_000,  // Health check interval
  enableWaitQueue: true,          // Queue requests when pool exhausted
  enableDisconnectHandling: true, // Handle CDP disconnects
  debug: true,                    // Enable logging
});

await pool.init();

// Acquire a session
const session = await pool.acquire();

// Use the browser
const context = session.browser.contexts()[0] || await session.browser.newContext();
const page = await context.newPage();
// ...

// Release back to pool
pool.release(session);

// Shutdown
await pool.shutdown();
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | required | Browser.cash API key |
| `chromium` | ChromiumModule | required | Chromium instance (playwright-core or patchright-core) |
| `size` | number | required | Number of sessions to maintain |
| `maxUses` | number | 50 | Max uses per session |
| `maxAgeMs` | number | 300000 | Max session age (5 min) |
| `enableHealthCheck` | boolean | false | Enable periodic health checks |
| `healthCheckIntervalMs` | number | 30000 | Health check interval |
| `enableWaitQueue` | boolean | true | Queue when pool exhausted |
| `enableDisconnectHandling` | boolean | true | Handle CDP disconnects |
| `debug` | boolean | false | Enable debug logging |
| `logger` | function | console.log | Custom logger function |

