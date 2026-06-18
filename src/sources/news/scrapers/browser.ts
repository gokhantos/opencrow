/** Browser lifecycle, stealth configuration, and anti-bot helpers. */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { createLogger } from "../../../logger";
import { randomDelay } from "./delays";

const log = createLogger("news-browser");

/**
 * Returns true when a Chromium executable is available for Playwright to use.
 *
 * On Docker builds with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 the browser is not
 * installed and `chromium.executablePath()` will throw. Callers should check
 * this before attempting to launch and skip the scrape cycle gracefully.
 */
export function isBrowserAvailable(): boolean {
  try {
    chromium.executablePath();
    return true;
  } catch {
    return false;
  }
}

const CHROMIUM_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
] as const;

const CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 1080 },
  locale: "en-US",
  timezoneId: "America/New_York",
  colorScheme: "dark" as const,
};

// Hard cap on page navigations so a wedged page can't stall a scrape forever.
export const NAVIGATION_TIMEOUT_MS = 45_000;

export interface BrowserSession {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly cleanup: () => Promise<void>;
}

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (params) =>
    params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(params);
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
`;

export async function launchChromium(): Promise<BrowserSession> {
  if (!isBrowserAvailable()) {
    log.warn(
      "Chromium is not installed — skipping browser scrape. " +
        "Run 'bun run setup:browser' to enable browser-based scrapers, " +
        "or set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 to suppress this message on non-browser deploys.",
    );
    throw new Error(
      "Chromium not available: browser scraping is disabled on this deploy. " +
        "Run 'bun run setup:browser' to install Chromium.",
    );
  }

  const browser = await chromium.launch({ headless: true });
  const userAgent =
    CHROMIUM_USER_AGENTS[
      Math.floor(Math.random() * CHROMIUM_USER_AGENTS.length)
    ];
  const context = await browser.newContext({ ...CONTEXT_OPTIONS, userAgent });
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  await context.addInitScript(STEALTH_SCRIPT);
  log.info("Chromium session started");

  return {
    browser,
    context,
    cleanup: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/**
 * Poll page title waiting for anti-bot challenge (Cloudflare/DataDome) to pass.
 * Returns true if challenge passed, false if still blocked after max attempts.
 */
export async function waitForChallengePage(
  page: Page,
  label: string,
  blockedTerms: readonly string[] = ["moment", "captcha"],
  maxAttempts: number = 20,
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const title = (await page.title()).toLowerCase();
    if (!blockedTerms.some((term) => title.includes(term))) {
      log.info("Challenge passed", { label, title, attempts: attempt });
      return true;
    }
    await randomDelay(0.8, 1.5);
  }
  log.warn("Blocked by challenge", { label });
  return false;
}
