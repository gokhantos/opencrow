import type { BrowserContext } from "playwright";
import { createLogger } from "../../../logger";
import { randomDelay } from "./delays";
import { validateUrl, isPrivateIp } from "../../shared/ssrf-safe-fetch";

const log = createLogger("news:extract-body");

const MAX_BODY_LENGTH = 15_000;
const NAVIGATE_TIMEOUT = 15_000;

/**
 * Playwright route handler — aborts any sub-resource request whose resolved IP
 * falls in a private/loopback/link-local/reserved range.
 *
 * The browser is given a wildcard pattern "**\/*" so ALL network requests go
 * through this handler. We only block destinations with literal private IP
 * hostnames; DNS-based rebinding inside the browser process is an accepted
 * residual risk (mitigating it fully would require a custom DNS resolver at the
 * Chromium level, which is beyond scope here).
 */
async function installSsrfRouteGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const reqUrl = request.url();

    // Fast-path: validate structurally (no DNS). We block:
    //   - non-http(s) schemes (e.g. file://, data://)
    //   - literal private-IP hostnames
    // Normal public hostnames are allowed through; DNS-rebinding hardening at
    // the browser level is a separate concern.
    const rejection = validateUrl(reqUrl);
    if (rejection) {
      log.debug("Playwright route blocked (SSRF)", { url: reqUrl, reason: rejection });
      await route.abort("blockedbyclient");
      return;
    }

    // Also block literal IPv4/IPv6 private addresses that appear as hostnames.
    try {
      const parsed = new URL(reqUrl);
      const host = parsed.hostname;
      // Strip brackets from IPv6 literals like [::1]
      const bareHost =
        host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
      if (isPrivateIp(bareHost)) {
        log.debug("Playwright route blocked (private IP literal)", { url: reqUrl, host });
        await route.abort("blockedbyclient");
        return;
      }
    } catch {
      // URL parse failed — route through (the browser will handle the error)
    }

    await route.continue();
  });
}

/**
 * Navigate to each article URL and extract the main body text.
 * Returns a map of URL → body text. Failures are silently skipped.
 */
export async function extractBodies(
  context: BrowserContext,
  urls: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const results = new Map<string, string>();

  // Install a single route guard on the context so it applies to all pages.
  await installSsrfRouteGuard(context);

  const page = await context.newPage();

  try {
    for (const url of urls) {
      // Validate the article URL before navigating — prevents the browser from
      // being directed to internal network endpoints via scraped article URLs.
      const rejection = validateUrl(url);
      if (rejection) {
        log.debug("Skipping article extraction — SSRF rejected", { url, reason: rejection });
        continue;
      }

      try {
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATE_TIMEOUT,
        });
        await randomDelay(1.0, 2.0);

        const body = await page.evaluate(`(() => {
          const selectors = [
            'article',
            '[role="article"]',
            '.post-content',
            '.article-content',
            '.article__body',
            '.post__content',
            '.entry-content',
            'main',
          ];

          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim().length > 100) {
              return el.textContent.trim();
            }
          }

          const paragraphs = document.querySelectorAll('p');
          const texts = [];
          for (const p of paragraphs) {
            const t = p.textContent.trim();
            if (t.length > 30) texts.push(t);
          }
          return texts.join('\\n\\n');
        })()`);

        const text =
          typeof body === "string" ? body.slice(0, MAX_BODY_LENGTH).trim() : "";
        if (text.length > 100) {
          results.set(url, text);
        }
      } catch (err) {
        log.debug("Failed to extract body", {
          url,
          error: err,
        });
      }
    }
  } finally {
    await page.close();
  }

  log.info("Body extraction complete", {
    attempted: urls.length,
    extracted: results.size,
  });

  return results;
}
