import { createLogger } from "../../logger";
import type { MemoryManager, GithubRepoForIndex } from "../../memory/types";
import {
  upsertRepos,
  getRepos,
  getUnindexedRepos,
  markReposIndexed,
  type GithubRepoRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";

const log = createLogger("github-scraper");

const DEFAULT_INTERVAL_MINUTES = 720; // 12 hours

const TRENDING_URL = "https://github.com/trending";

export interface GithubScraper {
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

interface ParsedRepo {
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly language: string;
  readonly stars: number;
  readonly forks: number;
  readonly starsToday: number;
  readonly builtBy: readonly string[];
}

type Period = "daily" | "weekly" | "monthly";

const PERIODS: readonly Period[] = ["daily", "weekly"];

const GITHUB_AGENT_ID = "github";

function parseNumber(text: string): number {
  const cleaned = text.replace(/,/g, "").trim();
  return parseInt(cleaned, 10) || 0;
}

function parseTrendingHtml(html: string): readonly ParsedRepo[] {
  const repos: ParsedRepo[] = [];

  // Each repo is in an <article class="Box-row">
  const articleRegex =
    /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let match: RegExpExecArray | null;

  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1]!;

    // Extract owner/name from the h2 > a href
    const repoLinkMatch = block.match(
      /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"[^>]*>/,
    );
    if (!repoLinkMatch) continue;

    const fullName = repoLinkMatch[1]!.trim();
    const parts = fullName.split("/");
    if (parts.length < 2) continue;

    const owner = parts[0]!.trim();
    const name = parts[1]!.trim();

    // Extract description
    const descMatch = block.match(
      /<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const description = descMatch
      ? descMatch[1]!.replace(/<[^>]+>/g, "").trim()
      : "";

    // Extract language
    const langMatch = block.match(
      /<span[^>]*itemprop="programmingLanguage"[^>]*>([^<]+)<\/span>/,
    );
    const language = langMatch ? langMatch[1]!.trim() : "";

    // Extract total stars — look for SVG with octicon-star followed by a number
    const starsMatches = [
      ...block.matchAll(
        /href="\/[^"]*\/stargazers"[^>]*>[\s\S]*?([0-9,]+)\s*<\/a>/g,
      ),
    ];
    const stars =
      starsMatches.length > 0 ? parseNumber(starsMatches[0]![1]!) : 0;

    // Extract forks
    const forksMatches = [
      ...block.matchAll(
        /href="\/[^"]*\/forks"[^>]*>[\s\S]*?([0-9,]+)\s*<\/a>/g,
      ),
    ];
    const forks =
      forksMatches.length > 0 ? parseNumber(forksMatches[0]![1]!) : 0;

    // Extract stars today/this week/this month
    const starsTodayMatch = block.match(
      /([0-9,]+)\s+stars?\s+(today|this\s+week|this\s+month)/i,
    );
    const starsToday = starsTodayMatch ? parseNumber(starsTodayMatch[1]!) : 0;

    // Extract built by usernames
    const builtByMatches = [
      ...block.matchAll(
        /href="\/([^"]+)"[^>]*>\s*<img[^>]*class="[^"]*avatar[^"]*"/g,
      ),
    ];
    const builtBy = builtByMatches.map((m) => m[1]!.trim());

    repos.push({
      owner,
      name,
      description,
      language,
      stars,
      forks,
      starsToday,
      builtBy,
    });
  }

  return repos;
}

function parsedToRow(parsed: ParsedRepo, period: Period): GithubRepoRow {
  const now = Math.floor(Date.now() / 1000);
  const fullName = `${parsed.owner}/${parsed.name}`;

  return {
    id: `${fullName}:${period}`,
    owner: parsed.owner,
    name: parsed.name,
    full_name: fullName,
    description: parsed.description.slice(0, 2000),
    language: parsed.language,
    stars: parsed.stars,
    forks: parsed.forks,
    stars_today: parsed.starsToday,
    built_by_json: JSON.stringify(parsed.builtBy),
    url: `https://github.com/${fullName}`,
    period,
    first_seen_at: now,
    updated_at: now,
  };
}

function rowsToReposForIndex(
  rows: readonly GithubRepoRow[],
): readonly GithubRepoForIndex[] {
  return rows.map((r) => {
    let builtBy: readonly string[] = [];
    try {
      builtBy = JSON.parse(r.built_by_json);
    } catch {
      // ignore
    }
    return {
      id: r.full_name,
      owner: r.owner,
      name: r.name,
      description: r.description,
      language: r.language,
      stars: r.stars,
      forks: r.forks,
      starsToday: r.stars_today,
      builtBy,
      url: r.url,
      period: r.period,
    };
  });
}

async function fetchTrending(
  period: Period,
): Promise<
  { ok: true; repos: readonly ParsedRepo[] } | { ok: false; error: string }
> {
  const url = `${TRENDING_URL}?since=${period}`;

  try {
    const resp = await fetch(url, {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (compatible; OpenCrowBot/1.0; +https://github.com)",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      return {
        ok: false,
        error: `GitHub trending ${resp.status}: ${resp.statusText}`,
      };
    }

    const html = await resp.text();
    const repos = parseTrendingHtml(html);
    return { ok: true, repos };
  } catch (err) {
    const msg = getErrorMessage(err);
    return { ok: false, error: `GitHub fetch error (${period}): ${msg}` };
  }
}

export function createGithubScraper(config?: {
  memoryManager?: MemoryManager;
}): GithubScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function scrape(): Promise<ScrapeResult> {
    let totalCount = 0;

    for (const period of PERIODS) {
      const result = await fetchTrending(period);
      if (!result.ok) {
        log.warn("GitHub trending scrape failed", {
          period,
          error: result.error,
        });
        continue;
      }

      const rows = result.repos.map((r) => parsedToRow(r, period));
      const count = await upsertRepos(rows);
      totalCount += count;
      log.info("GitHub trending scraped", { period, repos: count });
    }

    if (config?.memoryManager) {
      const unindexed = await getUnindexedRepos(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToReposForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);
        config.memoryManager
          .indexGithubRepos(GITHUB_AGENT_ID, forIndex)
          .then(() => markReposIndexed(ids))
          .catch((err) =>
            log.error("Failed to index GitHub repos into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("GitHub scrape complete", { total: totalCount });
    return { ok: true, count: totalCount };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("GitHub scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("GitHub scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      if (timer) return;
      const intervalMs = await loadScraperIntervalMs("github", DEFAULT_INTERVAL_MINUTES);
      timer = setInterval(tick, intervalMs);
      log.info("GitHub scraper started", { tickMs: intervalMs });
      tick().catch((err) =>
        log.error("GitHub scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("GitHub scraper stopped");
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
          const repos = await getRepos(
            undefined,
            undefined,
            BATCH_SIZE,
            offset,
          );
          if (repos.length === 0) break;

          const forIndex = rowsToReposForIndex(repos);
          await config.memoryManager.indexGithubRepos(
            GITHUB_AGENT_ID,
            forIndex,
          );
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("GitHub RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("GitHub RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("GitHub RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
