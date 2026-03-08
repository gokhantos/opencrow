import type { BrowserContext } from "playwright";
import { createLogger } from "../../../logger";
import { randomDelay } from "./delays";

const log = createLogger("news:extract-body");

const MAX_BODY_LENGTH = 15_000;
const NAVIGATE_TIMEOUT = 15_000;

/**
 * Navigate to each article URL and extract the main body text.
 * Returns a map of URL → body text. Failures are silently skipped.
 */
export async function extractBodies(
  context: BrowserContext,
  urls: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const results = new Map<string, string>();
  const page = await context.newPage();

  try {
    for (const url of urls) {
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

        const text = typeof body === "string" ? body.slice(0, MAX_BODY_LENGTH).trim() : "";
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
