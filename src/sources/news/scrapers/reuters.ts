/** Reuters scraper — Chromium, multi-section, DataDome title-polling bypass. */

import type { BrowserContext } from "playwright";
import type { RawArticle } from "../types";
import {
  launchChromium,
  waitForChallengePage,
  NAVIGATION_TIMEOUT_MS,
} from "./browser";
import { randomDelay } from "./delays";
import { REUTERS_SECTIONS } from "./constants";
import { createLogger } from "../../../logger";

const log = createLogger("scraper-reuters");
const MAX_ARTICLES = 50;

export async function scrapeReuters(): Promise<readonly RawArticle[]> {
  const session = await launchChromium();
  try {
    const allArticles: RawArticle[] = [];
    for (const [section, url] of Object.entries(REUTERS_SECTIONS)) {
      const articles = await scrapeSection(session.context, section, url);
      allArticles.push(...articles);
      await randomDelay(1.0, 2.0);
    }
    log.info("Scrape complete", {
      source: "reuters",
      count: allArticles.length,
    });
    return allArticles.slice(0, MAX_ARTICLES);
  } finally {
    await session.cleanup();
  }
}

async function scrapeSection(
  context: BrowserContext,
  section: string,
  url: string,
): Promise<readonly RawArticle[]> {
  const page = await context.newPage();
  try {
    log.info("Navigating", { url, section });
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await randomDelay(2.0, 3.0);

    const passed = await waitForChallengePage(page, `reuters-${section}`, [
      "moment",
      "captcha",
    ]);
    if (!passed) return [];

    await randomDelay(1.0, 2.0);

    const rawItems = await page.evaluate(`(() => {
      const cards = document.querySelectorAll(
        '[data-testid="MediaStoryCard"], article, ' +
        '[class*="story-card"], [class*="media-story"], ' +
        'li[class*="story"]'
      );
      const results = [];

      for (const card of cards) {
        const linkEl = card.querySelector('a[href*="/"]');
        if (!linkEl) continue;

        const url = linkEl.getAttribute('href') || '';

        const titleEl = card.querySelector(
          'h3, h2, [data-testid="Heading"], [class*="heading"], ' +
          '[class*="title"]'
        );
        const title = titleEl ? titleEl.textContent.trim() : '';
        if (!title) continue;

        const summaryEl = card.querySelector(
          'p, [class*="description"], [class*="summary"]'
        );
        const summary = summaryEl ? summaryEl.textContent.trim() : '';

        const timeEl = card.querySelector(
          'time, [class*="date"], [data-testid="Label"]'
        );
        const publishedAt = timeEl
          ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim())
          : '';

        results.push({
          title,
          url: url.startsWith('http') ? url : 'https://www.reuters.com' + url,
          summary,
          published_at: publishedAt,
        });
      }

      return results;
    })()`);

    const items = rawItems as Array<{
      title: string;
      url: string;
      summary: string;
      published_at: string;
    }>;

    // Zero-result sentinel: the anti-bot challenge passed (page loaded) yet the
    // CSS selectors matched nothing — a strong signal Reuters changed its DOM.
    if (items.length === 0) {
      log.warn("Reuters parsed 0 articles from a loaded section page", {
        section,
        url,
      });
    }

    return items.map(
      (item): RawArticle => ({
        source_name: "reuters",
        title: item.title,
        url: item.url,
        summary: item.summary,
        published_at: item.published_at,
        section,
        source_domain: "reuters.com",
      }),
    );
  } finally {
    await page.close();
  }
}
