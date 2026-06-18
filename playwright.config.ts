import { defineConfig, devices } from "playwright/test";

/**
 * Playwright configuration for OpenCrow dashboard E2E tests.
 *
 * The suite assumes the web process is running with a known token.
 * Two modes are supported:
 *
 *   1. CI / full-stack: set E2E_BASE_URL + E2E_TOKEN; the webServer block is
 *      skipped when E2E_BASE_URL is already reachable.
 *   2. Local dev: `bun run test:e2e` starts `bun run start:web` via the
 *      webServer block and waits for port 48080 to be ready.
 *
 * Required environment variables:
 *   E2E_BASE_URL  - override base URL (default: http://localhost:48080)
 *   E2E_TOKEN     - OPENCROW_WEB_TOKEN value (required; tests skip gracefully
 *                   when absent but will not pass against an auth-gated server)
 *
 * To install chromium: bunx playwright install chromium
 * To run:              bun run test:e2e
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:48080";

export default defineConfig({
  testDir: "./e2e",
  /* Give each test up to 60 s — pipelines poll every few seconds */
  timeout: 60_000,
  /* Assertion timeout */
  expect: {
    timeout: 10_000,
  },
  /* Run tests sequentially (the server is shared; concurrency would require
     separate DB isolation per worker, which is out of scope here). */
  fullyParallel: false,
  workers: 1,
  /* Retry once on CI */
  retries: process.env.CI ? 1 : 0,
  /* Reporters */
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "playwright-report",
        open: "never",
      },
    ],
  ],
  /* Shared settings for all projects */
  use: {
    baseURL: BASE_URL,
    /* Capture screenshot + trace on failure */
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "off",
    /* Hash-router navigation is fast; still give page loads 30 s */
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Allow overriding the browser channel via env var.
        // E2E_BROWSER_CHANNEL=chrome uses the installed Chrome for Testing
        // when the headless shell is unavailable.
        // E.g.: E2E_BROWSER_CHANNEL=chrome bun run test:e2e
        ...(process.env.E2E_BROWSER_CHANNEL
          ? { channel: process.env.E2E_BROWSER_CHANNEL }
          : {}),
      },
    },
  ],

  /*
   * webServer: boot the dashboard when no running server is detected.
   * Requires DATABASE_URL + OPENCROW_WEB_TOKEN to be set in the environment.
   * Set E2E_SKIP_SERVER=1 to suppress the webServer block entirely (e.g. when
   * pointing at a pre-started stack).
   */
  webServer:
    process.env.E2E_SKIP_SERVER === "1"
      ? undefined
      : {
          command: "bun run start:web",
          url: BASE_URL,
          timeout: 60_000,
          reuseExistingServer: true,
          stdout: "pipe",
          stderr: "pipe",
        },
});
