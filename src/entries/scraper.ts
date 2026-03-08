/**
 * Per-scraper entry point — reads OPENCROW_SCRAPER_ID env and runs one scraper.
 *
 * Usage:
 *   OPENCROW_SCRAPER_ID=hackernews bun src/entries/scraper.ts
 */
import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { createProcessSupervisor } from "../process/supervisor";
import { createLogger } from "../logger";
import type { ProcessName } from "../process/types";

const log = createLogger("scraper-entry");

const scraperId = process.env.OPENCROW_SCRAPER_ID;
if (!scraperId) {
  log.error("OPENCROW_SCRAPER_ID env var is required");
  process.exit(1);
}

/** Scrapers that don't need memory/embeddings */
const NO_MEMORY_SCRAPERS = new Set([
  "x-bookmarks",
  "x-autolike",
  "x-autofollow",
]);

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  const processName: ProcessName = `scraper:${scraperId}`;
  const needsMemory = !NO_MEMORY_SCRAPERS.has(scraperId!);

  const ctx = await bootstrap({
    config: baseConfig,
    processName,
    skipObservations: true,
    skipMemory: !needsMemory,
    dbPoolSize: 2,
  });

  // Reload with DB overrides now that DB is initialized
  const config = await loadConfigWithOverrides();

  const { memoryManager } = ctx;

  switch (scraperId) {
    case "hackernews": {
      const { createHNScraper } = await import("../sources/hackernews/scraper");
      const scraper = createHNScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "huggingface": {
      const { createHFScraper } =
        await import("../sources/huggingface/scraper");
      const scraper = createHFScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "reddit": {
      const { createRedditScraper } = await import("../sources/reddit/scraper");
      const scraper = createRedditScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "github": {
      const { createGithubScraper } = await import("../sources/github/scraper");
      const scraper = createGithubScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "producthunt": {
      const { createPHScraper } =
        await import("../sources/producthunt/scraper");
      const scraper = createPHScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "arxiv": {
      const { createArxivScraper } = await import("../sources/arxiv/scraper");
      const scraper = createArxivScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "news": {
      const { createNewsProcessor } = await import("../sources/news/processor");
      const processor = createNewsProcessor({
        memoryManager: memoryManager ?? undefined,
      });
      processor.start();
      break;
    }
    case "x-bookmarks": {
      const { createBookmarkProcessor } =
        await import("../sources/x/bookmarks/processor");
      const processor = createBookmarkProcessor();
      processor.start();
      break;
    }
    case "x-autolike": {
      const { createAutolikeProcessor } =
        await import("../sources/x/interactions/processor");
      const processor = createAutolikeProcessor();
      processor.start();
      break;
    }
    case "x-autofollow": {
      const { createAutofollowProcessor } =
        await import("../sources/x/follow/processor");
      const processor = createAutofollowProcessor();
      processor.start();
      break;
    }
    case "x-timeline": {
      const { createTimelineScrapeProcessor } =
        await import("../sources/x/timeline/processor");
      const processor = createTimelineScrapeProcessor({
        memoryManager: memoryManager ?? undefined,
      });
      processor.start();
      break;
    }
    case "appstore": {
      const { createAppStoreScraper } =
        await import("../sources/appstore/scraper");
      const scraper = createAppStoreScraper({
        memoryManager: memoryManager ?? undefined,
      });
      scraper.start();
      break;
    }
    case "playstore": {
      const { createPlayStoreScraper } = await import("../sources/playstore/scraper");
      const scraper = createPlayStoreScraper({ memoryManager: memoryManager ?? undefined });
      scraper.start();
      break;
    }
    default:
      log.error("Unknown scraper ID", { scraperId });
      process.exit(1);
  }

  log.info("Scraper started", { scraperId });

  const supervisor = createProcessSupervisor(processName, {
    type: "scraper",
    scraperId,
  });
  await supervisor.start();

  log.info("Scraper process started", { scraperId, processName });
}

process.on("unhandledRejection", (reason: unknown) => {
  log.error("Unhandled promise rejection (non-fatal)", { error: reason });
});

process.on("uncaughtException", (error: Error) => {
  log.error("Uncaught exception (non-fatal)", {
    error: error.message,
    stack: error.stack,
  });
});

main().catch((err) => {
  log.error("Scraper process failed to start", { scraperId, error: err });
  process.exit(1);
});
