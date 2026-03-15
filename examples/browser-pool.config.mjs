import { chromium } from "playwright-core";

/**
 * Dedicated example Browser Pool config.
 *
 * Copy this file into your app and adjust the targets for your mix of
 * Browser.cash nodes, countries, and browser types.
 */
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

export default browserPoolCfg;
