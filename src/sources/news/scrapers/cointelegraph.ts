/** CoinTelegraph scraper — Chromium with stealth, DOM card parsing. */

import type { BrowserContext } from "playwright";
import type { RawArticle } from "../types";
import { launchChromium } from "./browser";
import { randomDelay } from "./delays";
import { COINTELEGRAPH_URL } from "./constants";
import { createLogger } from "../../../logger";

const log = createLogger("scraper-cointelegraph");
const MAX_ARTICLES = 50;

export async function scrapeCointelegraph(): Promise<readonly RawArticle[]> {
  const session = await launchChromium();
  try {
    const articles = await scrapeCards(session.context);
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

async function scrapeCards(
  context: BrowserContext,
): Promise<readonly RawArticle[]> {
  const page = await context.newPage();
  try {
    log.info("Navigating", { url: COINTELEGRAPH_URL });
    await page.goto(COINTELEGRAPH_URL, { waitUntil: "domcontentloaded" });
    await randomDelay(3.0, 5.0);

    try {
      await page.waitForSelector(".post-card", { timeout: 15_000 });
    } catch {
      log.warn("Post cards not found", { url: COINTELEGRAPH_URL });
      return [];
    }

    await randomDelay(1.0, 2.0);

    const rawItems = await page.evaluate(`(() => {
      const cards = document.querySelectorAll('.post-card');
      const results = [];

      for (const card of cards) {
        const linkEl = card.querySelector('a[data-testid="post-cad__link"]')
          || card.querySelector('a[href*="/news/"]')
          || card.querySelector('a[href*="/magazine/"]')
          || card.querySelector('a');
        if (!linkEl) continue;

        const url = linkEl.getAttribute('href') || '';

        const titleEl = card.querySelector('[data-testid="post-card-title"]')
          || card.querySelector('.post-card__title')
          || card.querySelector('h2, h3');
        const title = titleEl ? titleEl.textContent.trim() : '';
        if (!title) continue;

        const previewEl = card.querySelector('[data-testid="post-card-preview"]')
          || card.querySelector('.post-card__text')
          || card.querySelector('p');
        const summary = previewEl ? previewEl.textContent.trim() : '';

        const imgEl = card.querySelector('img');
        const imageUrl = imgEl
          ? (imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '')
          : '';

        const timeEl = card.querySelector('time');
        const publishedAt = timeEl
          ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim())
          : '';

        results.push({
          title,
          url: url.startsWith('http') ? url : 'https://cointelegraph.com' + url,
          summary,
          image_url: imageUrl,
          published_at: publishedAt,
        });
      }

      return results;
    })()`);

    const items = rawItems as Array<{
      title: string;
      url: string;
      summary: string;
      image_url: string;
      published_at: string;
    }>;

    log.info("Scrape complete", { source: "cointelegraph", count: items.length });

    return items.slice(0, MAX_ARTICLES).map(
      (item): RawArticle => ({
        source_name: "cointelegraph",
        title: item.title,
        url: item.url,
        summary: item.summary,
        image_url: item.image_url,
        published_at: item.published_at,
        source_domain: "cointelegraph.com",
      }),
    );
  } finally {
    await page.close();
  }
}
