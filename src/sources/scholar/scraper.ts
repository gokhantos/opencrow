import { createLogger } from "../../logger";
import type { MemoryManager, ScholarPaperForIndex } from "../../memory/types";
import {
  upsertPapers,
  getPapers,
  getUnindexedPapers,
  markPapersIndexed,
  type ScholarPaperRow,
} from "./store";

const log = createLogger("scholar-scraper");

const TICK_INTERVAL_MS = 21_600_000; // 6 hours

const DEFAULT_KEYWORDS =
  "large language model,transformer,diffusion model,reinforcement learning";
const SCHOLAR_API_URL = "https://api.semanticscholar.org/graph/v1/paper/search";
const SCHOLAR_FIELDS =
  "paperId,title,abstract,authors,year,citationCount,referenceCount,url,venue,publicationDate,externalIds,tldr";

const SCHOLAR_AGENT_ID = "scholar";

export interface ScholarScraper {
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

interface RawScholarPaper {
  paperId: string;
  title?: string;
  abstract?: string;
  authors?: readonly { authorId?: string; name?: string }[];
  year?: number;
  citationCount?: number;
  referenceCount?: number;
  url?: string;
  venue?: string;
  publicationDate?: string;
  externalIds?: Record<string, string>;
  tldr?: { text?: string };
}

interface ScholarSearchResponse {
  total?: number;
  offset?: number;
  next?: number;
  data?: readonly RawScholarPaper[];
}

function rawToRow(raw: RawScholarPaper, feedSource: string): ScholarPaperRow {
  const now = Math.floor(Date.now() / 1000);
  const authors = (raw.authors ?? []).map((a) => a.name ?? "").filter(Boolean);

  return {
    id: raw.paperId,
    title: (raw.title ?? "").slice(0, 2000),
    authors_json: JSON.stringify(authors),
    abstract: (raw.abstract ?? "").slice(0, 5000),
    year: raw.year ?? 0,
    venue: (raw.venue ?? "").slice(0, 500),
    citation_count: raw.citationCount ?? 0,
    reference_count: raw.referenceCount ?? 0,
    publication_date: raw.publicationDate ?? "",
    url: raw.url ?? `https://www.semanticscholar.org/paper/${raw.paperId}`,
    external_ids_json: JSON.stringify(raw.externalIds ?? {}),
    tldr: (raw.tldr?.text ?? "").slice(0, 1000),
    feed_source: feedSource,
    first_seen_at: now,
    updated_at: now,
  };
}

function rowsToPapersForIndex(
  rows: readonly ScholarPaperRow[],
): readonly ScholarPaperForIndex[] {
  return rows.map((r) => {
    let authors: readonly string[] = [];
    try {
      authors = JSON.parse(r.authors_json);
    } catch {
      // ignore
    }
    return {
      id: r.id,
      title: r.title,
      authors,
      abstract: r.abstract,
      year: r.year,
      venue: r.venue,
      citationCount: r.citation_count,
      referenceCount: r.reference_count,
      url: r.url,
      tldr: r.tldr,
    };
  });
}

async function fetchKeyword(
  keyword: string,
  limit = 100,
  maxPages = 5,
): Promise<
  | { ok: true; papers: readonly RawScholarPaper[] }
  | { ok: false; error: string }
> {
  const headers: Record<string, string> = {
    "User-Agent": "OpenCrowBot/1.0 (research paper indexer)",
  };
  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const allPapers: RawScholarPaper[] = [];
  let offset = 0;
  const MAX_RETRIES = 3;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      query: keyword,
      limit: String(limit),
      offset: String(offset),
      fields: SCHOLAR_FIELDS,
    });
    const url = `${SCHOLAR_API_URL}?${params}`;

    let lastError = "";
    let fetched = false;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(30_000),
        });

        if (resp.status === 429) {
          const retryAfter = Number(resp.headers.get("retry-after") || "0");
          const backoffMs = Math.max(retryAfter * 1000, Math.pow(2, attempt + 1) * 1000);
          log.warn("Scholar API rate limited, backing off", {
            keyword,
            attempt: attempt + 1,
            backoffMs,
          });
          await sleep(backoffMs);
          continue;
        }

        if (!resp.ok) {
          return {
            ok: false,
            error: `Scholar API ${resp.status}: ${resp.statusText}`,
          };
        }

        const json = (await resp.json()) as ScholarSearchResponse;
        const papers = json.data ?? [];
        allPapers.push(...papers);
        fetched = true;

        // Follow pagination if more results exist
        if (json.next != null && papers.length > 0) {
          offset = json.next;
        } else {
          // No more pages
          return { ok: true, papers: allPapers };
        }
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(Math.pow(2, attempt + 1) * 1000);
        }
      }
    }

    if (!fetched) {
      return {
        ok: allPapers.length > 0,
        papers: allPapers,
        ...(allPapers.length === 0
          ? { error: `Scholar fetch error (${keyword}): ${lastError}` }
          : {}),
      } as any;
    }

    // Delay between pages to respect rate limits
    await sleep(apiKey ? 200 : 4_000);
  }

  return { ok: true, papers: allPapers };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createScholarScraper(config?: {
  memoryManager?: MemoryManager;
}): ScholarScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const keywords = (process.env.SCHOLAR_KEYWORDS ?? DEFAULT_KEYWORDS)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  const hasApiKey = Boolean(process.env.SEMANTIC_SCHOLAR_API_KEY);
  const delayMs = hasApiKey ? 100 : 3_500; // 100 req/s with key, conservative without

  async function scrape(): Promise<ScrapeResult> {
    let totalCount = 0;

    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i]!;

      if (i > 0) {
        await sleep(delayMs);
      }

      const result = await fetchKeyword(keyword);
      if (!result.ok) {
        log.warn("Scholar keyword scrape failed", {
          keyword,
          error: result.error,
        });
        continue;
      }

      const rows = result.papers
        .filter((p) => p.paperId && p.title)
        .map((p) => rawToRow(p, keyword));
      const count = await upsertPapers(rows);
      totalCount += count;
      log.info("Scholar keyword scraped", { keyword, papers: count });
    }

    if (config?.memoryManager) {
      const unindexed = await getUnindexedPapers(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToPapersForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);
        config.memoryManager
          .indexScholarPapers(SCHOLAR_AGENT_ID, forIndex)
          .then(() => markPapersIndexed(ids))
          .catch((err) =>
            log.error("Failed to index Scholar papers into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("Scholar scrape complete", { total: totalCount });
    return { ok: true, count: totalCount };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("Scholar scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Scholar scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("Scholar scraper started", {
        tickMs: TICK_INTERVAL_MS,
        keywords,
        hasApiKey,
      });
      tick().catch((err) =>
        log.error("Scholar scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Scholar scraper stopped");
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
          const papers = await getPapers(undefined, BATCH_SIZE, offset);
          if (papers.length === 0) break;

          const forIndex = rowsToPapersForIndex(papers);
          await config.memoryManager.indexScholarPapers(
            SCHOLAR_AGENT_ID,
            forIndex,
          );
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("Scholar RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("Scholar RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Scholar RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
