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
import { getOverride } from "../../store/config-overrides";

const log = createLogger("github-search-scraper");

const TICK_INTERVAL_MS = 21_600_000; // 6 hours

const GITHUB_API_URL = "https://api.github.com/search/repositories";
const GITHUB_AGENT_ID = "github";
const SCRAPER_CONFIG_NAMESPACE = "scraper-config";
const SCRAPER_ID = "github-search";

interface GithubSearchConfig {
  readonly minStars: number;
  readonly pushedWithinDays: number;
  readonly maxPages: number;
}

const DEFAULT_CONFIG: GithubSearchConfig = {
  minStars: 500,
  pushedWithinDays: 7,
  maxPages: 4,
};

async function loadConfig(): Promise<GithubSearchConfig> {
  try {
    const override = (await getOverride(
      SCRAPER_CONFIG_NAMESPACE,
      SCRAPER_ID,
    )) as Partial<GithubSearchConfig> | null;
    if (!override) return DEFAULT_CONFIG;
    return {
      minStars: override.minStars ?? DEFAULT_CONFIG.minStars,
      pushedWithinDays: override.pushedWithinDays ?? DEFAULT_CONFIG.pushedWithinDays,
      maxPages: override.maxPages ?? DEFAULT_CONFIG.maxPages,
    };
  } catch (err) {
    log.warn("Failed to load scraper config, using defaults", {
      error: getErrorMessage(err),
    });
    return DEFAULT_CONFIG;
  }
}

export interface GithubSearchScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

interface ScrapeResult {
  readonly ok: boolean;
  readonly count?: number;
  readonly error?: string;
}

interface GitHubSearchItem {
  readonly full_name: string;
  readonly owner: { readonly login: string };
  readonly name: string;
  readonly description: string | null;
  readonly language: string | null;
  readonly stargazers_count: number;
  readonly forks_count: number;
  readonly html_url: string;
}

interface GitHubSearchResponse {
  readonly total_count: number;
  readonly incomplete_results: boolean;
  readonly items: readonly GitHubSearchItem[];
}

function buildPushedDate(pushedWithinDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - pushedWithinDays);
  return d.toISOString().split("T")[0]!;
}

function searchItemToRow(item: GitHubSearchItem): GithubRepoRow {
  const now = Math.floor(Date.now() / 1000);
  const fullName = item.full_name;

  return {
    id: `${fullName}:search`,
    owner: item.owner.login,
    name: item.name,
    full_name: fullName,
    description: (item.description ?? "").slice(0, 2000),
    language: item.language ?? "",
    stars: item.stargazers_count,
    forks: item.forks_count,
    stars_today: 0,
    built_by_json: "[]",
    url: item.html_url,
    period: "search",
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

async function fetchSearchPage(
  page: number,
  pushedAfter: string,
  minStars: number,
): Promise<
  { ok: true; items: readonly GitHubSearchItem[] } | { ok: false; error: string }
> {
  const query = `stars:>=${minStars} pushed:>=${pushedAfter}`;
  const params = new URLSearchParams({
    q: query,
    sort: "stars",
    order: "desc",
    per_page: "30",
    page: String(page),
  });

  const url = `${GITHUB_API_URL}?${params}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenCrow/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        error: `GitHub Search API ${resp.status}: ${resp.statusText} — ${body.slice(0, 200)}`,
      };
    }

    const data = (await resp.json()) as GitHubSearchResponse;
    return { ok: true, items: data.items };
  } catch (err) {
    return { ok: false, error: `GitHub Search fetch error: ${getErrorMessage(err)}` };
  }
}

export function createGithubSearchScraper(config?: {
  memoryManager?: MemoryManager;
}): GithubSearchScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function scrape(): Promise<ScrapeResult> {
    const cfg = await loadConfig();
    const pushedAfter = buildPushedDate(cfg.pushedWithinDays);
    let totalCount = 0;

    log.info("GitHub search scrape starting", {
      minStars: cfg.minStars,
      pushedWithinDays: cfg.pushedWithinDays,
      maxPages: cfg.maxPages,
    });

    for (let page = 1; page <= cfg.maxPages; page++) {
      const result = await fetchSearchPage(page, pushedAfter, cfg.minStars);

      if (!result.ok) {
        log.warn("GitHub search page failed", { page, error: result.error });
        break;
      }

      if (result.items.length === 0) break;

      const rows = result.items.map(searchItemToRow);
      const count = await upsertRepos(rows);
      totalCount += count;

      log.info("GitHub search page scraped", {
        page,
        repos: result.items.length,
        upserted: count,
      });

      // Respect rate limits — small delay between pages
      if (page < cfg.maxPages) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }

    // Index into RAG
    if (config?.memoryManager) {
      const unindexed = await getUnindexedRepos(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToReposForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);
        config.memoryManager
          .indexGithubRepos(GITHUB_AGENT_ID, forIndex)
          .then(() => markReposIndexed(ids))
          .catch((err) =>
            log.error("Failed to index GitHub search repos into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("GitHub search scrape complete", { total: totalCount });
    return { ok: true, count: totalCount };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("GitHub search scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      log.error("GitHub search scrape error", { error: getErrorMessage(err) });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("GitHub search scraper started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) =>
        log.error("GitHub search scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("GitHub search scraper stopped");
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
          const repos = await getRepos(undefined, "search", BATCH_SIZE, offset);
          if (repos.length === 0) break;

          const forIndex = rowsToReposForIndex(repos);
          await config.memoryManager.indexGithubRepos(GITHUB_AGENT_ID, forIndex);
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("GitHub search RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("GitHub search RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("GitHub search RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
