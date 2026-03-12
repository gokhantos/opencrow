import { Hono } from "hono";
import { createLogger } from "../../logger";
import type { GithubScraper } from "../../sources/github/scraper";
import type { CoreClient } from "../core-client";
import type { MemoryManager, GithubRepoForIndex } from "../../memory/types";
import { getRepos, type GithubRepoRow, getRepoStats } from "../../sources/github/store";

const log = createLogger("github-api");

export function createGithubRoutes(opts: {
  scraper?: GithubScraper;
  coreClient?: CoreClient;
  memoryManager?: MemoryManager;
}): Hono {
  const app = new Hono();

  app.get("/github/repos", async (c) => {
    const language = c.req.query("language") || undefined;
    const period = c.req.query("period") || undefined;
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));

    const repos = await getRepos(language, period, limit);
    return c.json({ success: true, data: repos });
  });

  app.get("/github/stats", async (c) => {
    const stats = await getRepoStats();
    return c.json({ success: true, data: stats });
  });

  app.post("/github/scrape-now", async (c) => {
    log.info("Manual GitHub scrape triggered");
    if (opts.scraper) {
      const result = await opts.scraper.scrapeNow();
      return c.json({ success: true, data: result });
    }
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("github", "scrape-now");
      return c.json({ success: true, data: result.data });
    }
    return c.json({ success: false, error: "GitHub scraper not available" }, 503);
  });

  app.post("/github/search-scrape-now", async (c) => {
    log.info("Manual GitHub Search scrape triggered");
    if (opts.coreClient) {
      const result = await opts.coreClient.scraperAction("github-search", "scrape-now");
      return c.json({ success: true, data: result.data });
    }
    return c.json({ success: false, error: "GitHub Search scraper not available" }, 503);
  });

  app.post("/github/backfill-rag", async (c) => {
    log.info("GitHub RAG backfill triggered");
    try {
      if (opts.scraper) {
        const result = await opts.scraper.backfillRag();
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.memoryManager) {
        const result = await backfillRagDirect(opts.memoryManager);
        if (result.error) {
          return c.json({ success: false, error: result.error, data: result }, 500);
        }
        return c.json({ success: true, data: result });
      }
      if (opts.coreClient) {
        const result = await opts.coreClient.scraperAction("github", "backfill-rag");
        return c.json({ success: true, data: result.data });
      }
      return c.json({ success: false, error: "GitHub scraper not available" }, 503);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Backfill failed";
      log.error("GitHub RAG backfill error", { error: err });
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}

const GITHUB_AGENT_ID = "github";

function rowToRepoForIndex(r: GithubRepoRow): GithubRepoForIndex {
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
}

async function backfillRagDirect(
  memoryManager: MemoryManager,
): Promise<{ indexed: number; error?: string }> {
  const BATCH_SIZE = 50;
  let totalIndexed = 0;
  let offset = 0;

  try {
    while (true) {
      const repos = await getRepos(undefined, undefined, BATCH_SIZE, offset);
      if (repos.length === 0) break;

      const forIndex = repos.map(rowToRepoForIndex);
      await memoryManager.indexGithubRepos(GITHUB_AGENT_ID, forIndex);
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
    const msg = err instanceof Error ? err.message : String(err);
    log.error("GitHub RAG backfill failed", { error: msg, totalIndexed });
    return { indexed: totalIndexed, error: msg };
  }
}
