import { createLogger } from "../../logger";
import type { NewsSource, RawArticle } from "./types";
import type { MemoryManager, ArticleForIndex } from "../../memory/types";
import { runNewsScraper } from "./runner";
import {
  upsertArticles,
  upsertCalendarEvents,
  insertScraperRun,
  getArticles,
} from "./store";

const log = createLogger("news-processor");

const DEFAULT_INTERVALS: Record<NewsSource, number> = {
  cryptopanic: 15 * 60_000,
  cointelegraph: 30 * 60_000,
  reuters: 60 * 60_000,
  investing_news: 60 * 60_000,
  investing_calendar: 120 * 60_000,
};

const TICK_INTERVAL_MS = 60_000;

export interface NewsProcessor {
  start(): void;
  stop(): void;
  scrapeNow(source: NewsSource): Promise<{
    ok: boolean;
    found: number;
    inserted: number;
    error?: string;
  }>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

function parsePublishedAt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = new Date(raw).getTime();
  return isNaN(parsed) ? fallback : Math.floor(parsed / 1000);
}

function toArticlesForIndex(
  articles: readonly RawArticle[],
): readonly ArticleForIndex[] {
  const now = Math.floor(Date.now() / 1000);
  return articles.map((a) => ({
    id: a.source_id ?? crypto.randomUUID(),
    title: a.title,
    url: a.url,
    sourceName: a.source_name,
    category: a.category ?? "",
    content: a.body ?? a.summary ?? null,
    publishedAt: parsePublishedAt(a.published_at, now),
  }));
}

const SHARED_AGENT_ID = "shared";

export function createNewsProcessor(config?: {
  enabledSources?: readonly NewsSource[];
  intervals?: Partial<Record<NewsSource, number>>;
  memoryManager?: MemoryManager;
}): NewsProcessor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();
  const lastRun = new Map<string, number>();

  const enabledSources: readonly NewsSource[] = config?.enabledSources ?? [
    "cryptopanic",
    "cointelegraph",
    "reuters",
    "investing_news",
    "investing_calendar",
  ];

  const intervals: Record<string, number> = {
    ...DEFAULT_INTERVALS,
    ...config?.intervals,
  };

  async function runSource(source: NewsSource): Promise<{
    ok: boolean;
    found: number;
    inserted: number;
    error?: string;
  }> {
    if (running.has(source)) {
      return { ok: false, found: 0, inserted: 0, error: "Already running" };
    }
    running.add(source);

    const startedAt = Math.floor(Date.now() / 1000);
    const t0 = Date.now();

    try {
      const result = await runNewsScraper(source);

      if (!result.ok) {
        const durationMs = Date.now() - t0;
        await insertScraperRun({
          source_name: source,
          status: "error",
          articles_found: 0,
          articles_new: 0,
          duration_ms: durationMs,
          error: result.error,
          started_at: startedAt,
        }).catch((e) => log.error("Failed to record run", { error: e }));
        return { ok: false, found: 0, inserted: 0, error: result.error };
      }

      let found = 0;
      let inserted = 0;

      if (result.articles && result.articles.length > 0) {
        const upsertResult = await upsertArticles(result.articles);
        found = upsertResult.found;
        inserted = upsertResult.inserted;

        if (config?.memoryManager && upsertResult.insertedArticles.length > 0) {
          const forIndex = toArticlesForIndex(upsertResult.insertedArticles);
          config.memoryManager
            .indexArticles(SHARED_AGENT_ID, forIndex)
            .catch((err) =>
              log.error("Failed to index articles into RAG", {
                source,
                count: forIndex.length,
                error: err,
              }),
            );
        }
      }

      if (result.events && result.events.length > 0) {
        const upsertResult = await upsertCalendarEvents(result.events);
        found = upsertResult.found;
        inserted = upsertResult.inserted;
      }

      const durationMs = Date.now() - t0;
      await insertScraperRun({
        source_name: source,
        status: "ok",
        articles_found: found,
        articles_new: inserted,
        duration_ms: durationMs,
        started_at: startedAt,
      }).catch((e) => log.error("Failed to record run", { error: e }));

      log.info("Scrape completed", { source, found, inserted, durationMs });
      lastRun.set(source, Date.now());

      return { ok: true, found, inserted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - t0;
      log.error("Scraper error", { source, error: msg });

      await insertScraperRun({
        source_name: source,
        status: "error",
        articles_found: 0,
        articles_new: 0,
        duration_ms: durationMs,
        error: msg,
        started_at: startedAt,
      }).catch((e) => log.error("Failed to record run", { error: e }));

      return { ok: false, found: 0, inserted: 0, error: msg };
    } finally {
      running.delete(source);
    }
  }

  async function tick(): Promise<void> {
    const now = Date.now();

    for (const source of enabledSources) {
      const last = lastRun.get(source) ?? 0;
      const interval =
        intervals[source] ?? DEFAULT_INTERVALS[source] ?? 60 * 60_000;

      if (now - last >= interval) {
        runSource(source).catch((err) =>
          log.error("Unhandled scraper error", { source, error: err }),
        );
      }
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("News processor started", {
        sources: enabledSources,
        tickMs: TICK_INTERVAL_MS,
      });
      // First tick immediately
      tick().catch((err) => log.error("First tick error", { error: err }));
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("News processor stopped");
      }
    },

    scrapeNow: runSource,

    async backfillRag(): Promise<{ indexed: number; error?: string }> {
      if (!config?.memoryManager) {
        return { indexed: 0, error: "memoryManager not configured" };
      }

      const BATCH_SIZE = 50;
      let totalIndexed = 0;
      let offset = 0;

      try {
        while (true) {
          const articles = await getArticles({ limit: BATCH_SIZE, offset });
          if (articles.length === 0) break;

          const forIndex: ArticleForIndex[] = articles.map((a) => ({
            id: a.id,
            title: a.title,
            url: a.url,
            sourceName: a.source_name,
            category: a.category ?? "",
            content: a.summary || null,
            publishedAt: parsePublishedAt(a.published_at, a.scraped_at),
          }));

          await config.memoryManager.indexArticles(SHARED_AGENT_ID, forIndex);
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("RAG backfill batch indexed", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
