/** CryptoPanic scraper — Chromium with stealth, DOM row parsing. */

import type { BrowserContext } from "playwright";
import type { RawArticle } from "../types";
import { launchChromium } from "./browser";
import { randomDelay } from "./delays";
import { CRYPTOPANIC_URL } from "./constants";
import { createLogger } from "../../../logger";

const log = createLogger("scraper-cryptopanic");
const MAX_ARTICLES = 50;

export async function scrapeCryptopanic(): Promise<readonly RawArticle[]> {
  const session = await launchChromium();
  try {
    const articles = await scrapeRows(session.context);
    const { extractBodies } = await import("./extract-body");
    const urls = articles.map((a) => a.url);
    const bodies = await extractBodies(session.context, urls);
    return articles.map((a) => ({
      ...a,
      body: bodies.get(a.url),
    }));
  } finally {
    await session.cleanup();
  }
}

async function scrapeRows(
  context: BrowserContext,
): Promise<readonly RawArticle[]> {
  const page = await context.newPage();
  try {
    log.info("Navigating", { url: CRYPTOPANIC_URL });
    await page.goto(CRYPTOPANIC_URL, { waitUntil: "domcontentloaded" });
    await randomDelay(2.0, 4.0);

    try {
      await page.waitForSelector(".news-row", { timeout: 10_000 });
    } catch {
      log.warn("News rows not found", { url: CRYPTOPANIC_URL });
      return [];
    }

    await randomDelay(1.0, 2.0);

    const rawItems = await page.evaluate(`(() => {
      const rows = document.querySelectorAll('.news-row:not(.sponsored)');
      const results = [];

      for (const row of rows) {
        const titleEl = row.querySelector('.nc-title .title-text > span:first-child');
        if (!titleEl) continue;
        const title = (titleEl.textContent || '').trim();
        if (!title) continue;

        const titleLink = row.querySelector('a.nc-title');
        const href = titleLink ? (titleLink.getAttribute('href') || '') : '';
        const url = href.startsWith('http') ? href : 'https://cryptopanic.com' + href;

        const sourceEl = row.querySelector('.si-source-domain');
        const sourceDomain = sourceEl ? sourceEl.textContent.trim() : '';

        const timeEl = row.querySelector('.nc-date time');
        const publishedAt = timeEl
          ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim())
          : '';

        let sentiment = '';
        if (row.querySelector('.icon-bullish, .positive')) sentiment = 'bullish';
        else if (row.querySelector('.icon-bearish, .negative')) sentiment = 'bearish';

        const currencyEls = row.querySelectorAll('.nc-currency .colored-link');
        const currencies = [];
        for (const el of currencyEls) {
          const text = el.textContent.trim();
          if (text) currencies.push(text);
        }

        results.push({
          title,
          url,
          source_domain: sourceDomain,
          published_at: publishedAt,
          sentiment,
          currencies,
        });
      }

      return results;
    })()`);

    const items = rawItems as Array<{
      title: string;
      url: string;
      source_domain: string;
      published_at: string;
      sentiment: string;
      currencies: string[];
    }>;

    log.info("Scrape complete", { source: "cryptopanic", count: items.length });

    return items.slice(0, MAX_ARTICLES).map(
      (item): RawArticle => ({
        source_name: "cryptopanic",
        title: item.title,
        url: item.url,
        source_domain: item.source_domain,
        published_at: item.published_at,
        sentiment: item.sentiment,
        currencies: item.currencies,
      }),
    );
  } finally {
    await page.close();
  }
}
