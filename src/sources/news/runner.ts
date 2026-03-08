/** Runs a news scraper by source name using native TypeScript Playwright. */

import { createLogger } from "../../logger";
import type { NewsSource, RawArticle, RawCalendarEvent } from "./types";
import { getArticleScraper, getCalendarScraper } from "./scrapers";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("news-runner");

interface RunResult {
  readonly ok: boolean;
  readonly articles?: readonly RawArticle[];
  readonly events?: readonly RawCalendarEvent[];
  readonly error?: string;
}

export async function runNewsScraper(source: NewsSource): Promise<RunResult> {
  log.info("Running news scraper", { source });

  try {
    if (source === "investing_calendar") {
      const scraper = await getCalendarScraper();
      const events = await scraper();
      return { ok: true, events };
    }

    const scraper = await getArticleScraper(source);
    const articles = await scraper();
    return { ok: true, articles };
  } catch (err) {
    const msg = getErrorMessage(err);
    log.warn("Scraper failed", { source, error: msg });
    return { ok: false, error: msg };
  }
}
