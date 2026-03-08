import { createLogger } from "../../logger";
import type { MemoryManager, ArxivPaperForIndex } from "../../memory/types";
import {
  upsertPapers,
  getPapers,
  getUnindexedPapers,
  markPapersIndexed,
  type ArxivPaperRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("arxiv-scraper");

const TICK_INTERVAL_MS = 3_600_000; // 60 minutes
const DELAY_BETWEEN_CATEGORIES_MS = 3_000; // 3s rate limit

const DEFAULT_CATEGORIES = "cs.AI,cs.LG,cs.CL,cs.CV,stat.ML";
const ARXIV_API_URL = "http://export.arxiv.org/api/query";

const ARXIV_AGENT_ID = "arxiv";

export interface ArxivScraper {
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

interface ParsedPaper {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly abstract: string;
  readonly categories: readonly string[];
  readonly primaryCategory: string;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly pdfUrl: string;
  readonly absUrl: string;
}

function parseAtomXml(xml: string): readonly ParsedPaper[] {
  const papers: ParsedPaper[] = [];

  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1]!;

    const idMatch = block.match(/<id>([\s\S]*?)<\/id>/);
    if (!idMatch) continue;
    const rawId = idMatch[1]!.trim();
    // Extract paper ID from URL like http://arxiv.org/abs/2401.12345v1
    const idParts = rawId.match(/abs\/(.+?)(?:v\d+)?$/);
    const id = idParts ? idParts[1]! : rawId;

    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch
      ? titleMatch[1]!.replace(/\s+/g, " ").trim()
      : "";

    const abstractMatch = block.match(/<summary>([\s\S]*?)<\/summary>/);
    const abstract = abstractMatch
      ? abstractMatch[1]!.replace(/\s+/g, " ").trim()
      : "";

    const authorMatches = [
      ...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g),
    ];
    const authors = authorMatches.map((m) => m[1]!.trim());

    const categoryMatches = [
      ...block.matchAll(/<category[^>]*term="([^"]+)"[^>]*\/>/g),
    ];
    const categories = categoryMatches.map((m) => m[1]!);

    const primaryCatMatch = block.match(
      /<arxiv:primary_category[^>]*term="([^"]+)"[^>]*\/>/,
    );
    const primaryCategory = primaryCatMatch
      ? primaryCatMatch[1]!
      : categories[0] ?? "";

    const publishedMatch = block.match(/<published>([\s\S]*?)<\/published>/);
    const publishedAt = publishedMatch ? publishedMatch[1]!.trim() : "";

    const updatedMatch = block.match(/<updated>([\s\S]*?)<\/updated>/);
    const updatedAt = updatedMatch ? updatedMatch[1]!.trim() : publishedAt;

    const pdfLink = block.match(
      /<link[^>]*title="pdf"[^>]*href="([^"]+)"[^>]*\/>/,
    );
    const pdfUrl = pdfLink ? pdfLink[1]! : `https://arxiv.org/pdf/${id}`;

    const absUrl = `https://arxiv.org/abs/${id}`;

    papers.push({
      id,
      title,
      authors,
      abstract,
      categories,
      primaryCategory,
      publishedAt,
      updatedAt,
      pdfUrl,
      absUrl,
    });
  }

  return papers;
}

function parsedToRow(
  parsed: ParsedPaper,
  feedCategory: string,
): ArxivPaperRow {
  const now = Math.floor(Date.now() / 1000);

  return {
    id: parsed.id,
    title: parsed.title.slice(0, 2000),
    authors_json: JSON.stringify(parsed.authors),
    abstract: parsed.abstract.slice(0, 5000),
    categories_json: JSON.stringify(parsed.categories),
    primary_category: parsed.primaryCategory,
    published_at: parsed.publishedAt,
    pdf_url: parsed.pdfUrl,
    abs_url: parsed.absUrl,
    feed_category: feedCategory,
    first_seen_at: now,
    updated_at: now,
  };
}

function rowsToPapersForIndex(
  rows: readonly ArxivPaperRow[],
): readonly ArxivPaperForIndex[] {
  return rows.map((r) => {
    let authors: readonly string[] = [];
    let categories: readonly string[] = [];
    try {
      authors = JSON.parse(r.authors_json);
    } catch {
      // ignore
    }
    try {
      categories = JSON.parse(r.categories_json);
    } catch {
      // ignore
    }
    return {
      id: r.id,
      title: r.title,
      authors,
      abstract: r.abstract,
      categories,
      primaryCategory: r.primary_category,
      publishedAt: r.published_at,
      pdfUrl: r.pdf_url,
      absUrl: r.abs_url,
    };
  });
}

async function fetchCategory(
  category: string,
  maxResults = 100,
): Promise<
  { ok: true; papers: readonly ParsedPaper[] } | { ok: false; error: string }
> {
  const url = `${ARXIV_API_URL}?search_query=cat:${category}&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "OpenCrowBot/1.0 (research paper indexer)",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      return {
        ok: false,
        error: `arXiv API ${resp.status}: ${resp.statusText}`,
      };
    }

    const xml = await resp.text();
    const papers = parseAtomXml(xml);
    return { ok: true, papers };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { ok: false, error: `arXiv fetch error (${category}): ${msg}` };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createArxivScraper(config?: {
  memoryManager?: MemoryManager;
}): ArxivScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const categories = (
    process.env.ARXIV_CATEGORIES ?? DEFAULT_CATEGORIES
  ).split(",").map((c) => c.trim()).filter(Boolean);

  async function scrape(): Promise<ScrapeResult> {
    let totalCount = 0;

    for (let i = 0; i < categories.length; i++) {
      const category = categories[i]!;

      if (i > 0) {
        await sleep(DELAY_BETWEEN_CATEGORIES_MS);
      }

      const result = await fetchCategory(category);
      if (!result.ok) {
        log.warn("arXiv category scrape failed", {
          category,
          error: result.error,
        });
        continue;
      }

      const rows = result.papers.map((p) => parsedToRow(p, category));
      const count = await upsertPapers(rows);
      totalCount += count;
      log.info("arXiv category scraped", { category, papers: count });
    }

    if (config?.memoryManager) {
      const unindexed = await getUnindexedPapers(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToPapersForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);
        config.memoryManager
          .indexArxivPapers(ARXIV_AGENT_ID, forIndex)
          .then(() => markPapersIndexed(ids))
          .catch((err) =>
            log.error("Failed to index arXiv papers into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("arXiv scrape complete", { total: totalCount });
    return { ok: true, count: totalCount };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("arXiv scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("arXiv scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("arXiv scraper started", {
        tickMs: TICK_INTERVAL_MS,
        categories,
      });
      tick().catch((err) =>
        log.error("arXiv scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("arXiv scraper stopped");
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
          await config.memoryManager.indexArxivPapers(
            ARXIV_AGENT_ID,
            forIndex,
          );
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("arXiv RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("arXiv RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("arXiv RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
