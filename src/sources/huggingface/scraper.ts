import { createLogger } from "../../logger";
import type { MemoryManager, HFModelForIndex } from "../../memory/types";
import {
  upsertModels,
  getModels,
  getUnindexedModels,
  markModelsIndexed,
  type HFModelRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("hf-scraper");

const TICK_INTERVAL_MS = 1_800_000; // 30 minutes

const HF_API_BASE = "https://huggingface.co/api";

export interface HFScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

interface ScrapeResult {
  ok: boolean;
  count?: number;
  error?: string;
}

interface RawHFModel {
  _id: string;
  id: string;
  modelId?: string;
  author?: string;
  sha?: string;
  pipeline_tag?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  trendingScore?: number;
  library_name?: string;
  createdAt?: string;
  lastModified?: string;
  description?: string;
  cardData?: { description?: string };
}

type FeedSource = "trending" | "likes" | "modified";

const FEEDS: readonly {
  source: FeedSource;
  sort: string;
  direction?: string;
}[] = [
  { source: "trending", sort: "trendingScore", direction: "-1" },
  { source: "likes", sort: "likes", direction: "-1" },
  { source: "modified", sort: "lastModified", direction: "-1" },
];

const HF_AGENT_ID = "hf";

function rawToRow(raw: RawHFModel, feedSource: FeedSource): HFModelRow {
  const now = Math.floor(Date.now() / 1000);
  const modelId = raw.id || raw.modelId || raw._id || "";
  const author = raw.author ?? modelId.split("/")[0] ?? "";
  const description = raw.description ?? raw.cardData?.description ?? "";

  return {
    id: modelId,
    author,
    pipeline_tag: raw.pipeline_tag ?? "",
    tags_json: JSON.stringify(raw.tags ?? []),
    downloads: raw.downloads ?? 0,
    likes: raw.likes ?? 0,
    trending_score: raw.trendingScore ?? 0,
    library_name: raw.library_name ?? "",
    model_created_at: raw.createdAt ?? "",
    last_modified: raw.lastModified ?? "",
    description: description.slice(0, 2000),
    feed_source: feedSource,
    first_seen_at: now,
    updated_at: now,
  };
}

function rowsToModelsForIndex(
  rows: readonly HFModelRow[],
): readonly HFModelForIndex[] {
  return rows.map((m) => {
    let tags: readonly string[] = [];
    try {
      tags = JSON.parse(m.tags_json);
    } catch {
      // ignore
    }
    return {
      id: m.id,
      author: m.author,
      pipelineTag: m.pipeline_tag,
      tags,
      downloads: m.downloads,
      likes: m.likes,
      trendingScore: m.trending_score,
      description: m.description,
      libraryName: m.library_name,
    };
  });
}

async function fetchFeed(
  source: FeedSource,
  sort: string,
  direction?: string,
  limit = 50,
): Promise<{ ok: true; models: RawHFModel[] } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    sort,
    limit: String(limit),
  });
  if (direction) params.set("direction", direction);

  const token = process.env.HF_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const url = `${HF_API_BASE}/models?${params}`;

  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      return { ok: false, error: `HF API ${resp.status}: ${resp.statusText}` };
    }
    const data = (await resp.json()) as RawHFModel[];
    return { ok: true, models: data };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { ok: false, error: `HF fetch error (${source}): ${msg}` };
  }
}

export function createHFScraper(config?: {
  memoryManager?: MemoryManager;
}): HFScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function scrape(): Promise<ScrapeResult> {
    let totalCount = 0;

    for (const feed of FEEDS) {
      const result = await fetchFeed(feed.source, feed.sort, feed.direction);
      if (!result.ok) {
        log.warn("HF feed scrape failed", {
          feed: feed.source,
          error: result.error,
        });
        continue;
      }

      const rows = result.models.map((m) => rawToRow(m, feed.source));
      const count = await upsertModels(rows);
      totalCount += count;
      log.info("HF feed scraped", { feed: feed.source, models: count });
    }

    if (config?.memoryManager) {
      const unindexed = await getUnindexedModels(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToModelsForIndex(unindexed);
        const ids = unindexed.map((m) => m.id);
        config.memoryManager
          .indexHFModels(HF_AGENT_ID, forIndex)
          .then(() => markModelsIndexed(ids))
          .catch((err) =>
            log.error("Failed to index HF models into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("HF scrape complete", { total: totalCount });
    return { ok: true, count: totalCount };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("HF scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("HF scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("HF scraper started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) =>
        log.error("HF scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("HF scraper stopped");
      }
    },

    async scrapeNow(): Promise<ScrapeResult> {
      if (running) {
        return { ok: false, error: "Already running" };
      }

      running = true;
      try {
        return await scrape();
      } finally {
        running = false;
      }
    },

    async backfillRag(): Promise<{ indexed: number; error?: string }> {
      if (!config?.memoryManager) {
        return { indexed: 0, error: "memoryManager not configured" };
      }

      const BATCH_SIZE = 50;
      let totalIndexed = 0;
      let offset = 0;

      try {
        while (true) {
          const models = await getModels(
            undefined,
            undefined,
            BATCH_SIZE,
            offset,
          );
          if (models.length === 0) break;

          const forIndex = rowsToModelsForIndex(models);
          await config.memoryManager.indexHFModels(HF_AGENT_ID, forIndex);
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("HF RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("HF RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("HF RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
