import type { OpenCrowConfig } from "../config/schema";
import type { MemoryManager } from "../memory/types";
import { createLogger } from "../logger";
import {
  createMarketPipeline,
  type MarketPipeline,
} from "../sources/markets/pipeline";
import {
  createBookmarkProcessor,
  type BookmarkProcessor,
} from "../sources/x/bookmarks/processor";
import {
  createAutolikeProcessor,
  type AutolikeProcessor,
} from "../sources/x/interactions/processor";
import {
  createAutofollowProcessor,
  type AutofollowProcessor,
} from "../sources/x/follow/processor";
import {
  createTimelineScrapeProcessor,
  type TimelineScrapeProcessor,
} from "../sources/x/timeline/processor";
import { createPHScraper, type PHScraper } from "../sources/producthunt/scraper";
import { createHNScraper, type HNScraper } from "../sources/hackernews/scraper";
import { createHFScraper, type HFScraper } from "../sources/huggingface/scraper";
import {
  createRedditScraper,
  type RedditScraper,
} from "../sources/reddit/scraper";
import {
  createGithubScraper,
  type GithubScraper,
} from "../sources/github/scraper";
import {
  createArxivScraper,
  type ArxivScraper,
} from "../sources/arxiv/scraper";
import {
  createScholarScraper,
  type ScholarScraper,
} from "../sources/scholar/scraper";
import {
  createNewsProcessor,
  type NewsProcessor,
} from "../sources/news/processor";
import {
  createDexScreenerProcessor,
  type DexScreenerProcessor,
} from "../sources/dexscreener/processor";
import { createLiveKlineHub, type LiveKlineHub } from "../sources/markets/ws-hub";

const log = createLogger("gateway:subsystems");

export interface SubsystemInstances {
  readonly liveHub: LiveKlineHub | undefined;
  readonly marketPipeline: MarketPipeline | undefined;
  readonly bookmarkProcessor: BookmarkProcessor | undefined;
  readonly autolikeProcessor: AutolikeProcessor | undefined;
  readonly autofollowProcessor: AutofollowProcessor | undefined;
  readonly timelineScrapeProcessor: TimelineScrapeProcessor | undefined;
  readonly phScraper: PHScraper | undefined;
  readonly hnScraper: HNScraper | undefined;
  readonly hfScraper: HFScraper | undefined;
  readonly redditScraper: RedditScraper | undefined;
  readonly githubScraper: GithubScraper | undefined;
  readonly arxivScraper: ArxivScraper | undefined;
  readonly scholarScraper: ScholarScraper | undefined;
  readonly newsProcessor: NewsProcessor | undefined;
  readonly dexScreenerProcessor: DexScreenerProcessor | undefined;
}

export interface SubsystemStartResult {
  readonly instances: SubsystemInstances;
  readonly failed: readonly string[];
  readonly started: readonly string[];
}

export interface SubsystemRegistry {
  startAll(): Promise<SubsystemStartResult>;
  stopAll(): Promise<void>;
}

export function createSubsystemRegistry(opts: {
  config: OpenCrowConfig;
  memoryManager: MemoryManager | null | undefined;
}): SubsystemRegistry {
  const { config, memoryManager } = opts;
  const mm = memoryManager ?? undefined;

  let liveHub: LiveKlineHub | undefined;
  let marketPipeline: MarketPipeline | undefined;
  let bookmarkProcessor: BookmarkProcessor | undefined;
  let autolikeProcessor: AutolikeProcessor | undefined;
  let autofollowProcessor: AutofollowProcessor | undefined;
  let timelineScrapeProcessor: TimelineScrapeProcessor | undefined;
  let phScraper: PHScraper | undefined;
  let hnScraper: HNScraper | undefined;
  let hfScraper: HFScraper | undefined;
  let redditScraper: RedditScraper | undefined;
  let githubScraper: GithubScraper | undefined;
  let arxivScraper: ArxivScraper | undefined;
  let scholarScraper: ScholarScraper | undefined;
  let newsProcessor: NewsProcessor | undefined;
  let dexScreenerProcessor: DexScreenerProcessor | undefined;

  return {
    async startAll(): Promise<SubsystemStartResult> {
      const failed: string[] = [];
      const started: string[] = [];

      async function tryStart(
        name: string,
        fn: () => void | Promise<void>,
      ): Promise<boolean> {
        try {
          await fn();
          started.push(name);
          log.info(`${name} started`);
          return true;
        } catch (err) {
          failed.push(name);
          log.error(`${name} failed to start`, {
            error: err,
          });
          return false;
        }
      }

      if (config.market !== undefined) {
        await tryStart("market-pipeline", async () => {
          liveHub = createLiveKlineHub();
          marketPipeline = createMarketPipeline(config.market!, liveHub);
          await marketPipeline.start();
        });
      }

      await tryStart("bookmark-processor", () => {
        bookmarkProcessor = createBookmarkProcessor();
        bookmarkProcessor.start();
      });

      await tryStart("autolike-processor", () => {
        autolikeProcessor = createAutolikeProcessor();
        autolikeProcessor.start();
      });

      await tryStart("autofollow-processor", () => {
        autofollowProcessor = createAutofollowProcessor();
        autofollowProcessor.start();
      });

      await tryStart("timeline-processor", () => {
        timelineScrapeProcessor = createTimelineScrapeProcessor({ memoryManager: mm });
        timelineScrapeProcessor.start();
      });

      await tryStart("ph-scraper", () => {
        phScraper = createPHScraper({ memoryManager: mm });
        phScraper.start();
      });

      await tryStart("hn-scraper", () => {
        hnScraper = createHNScraper({ memoryManager: mm });
        hnScraper.start();
      });

      await tryStart("hf-scraper", () => {
        hfScraper = createHFScraper({ memoryManager: mm });
        hfScraper.start();
      });

      await tryStart("reddit-scraper", () => {
        redditScraper = createRedditScraper({ memoryManager: mm });
        redditScraper.start();
      });

      await tryStart("github-scraper", () => {
        githubScraper = createGithubScraper({ memoryManager: mm });
        githubScraper.start();
      });

      await tryStart("arxiv-scraper", () => {
        arxivScraper = createArxivScraper({ memoryManager: mm });
        arxivScraper.start();
      });

      await tryStart("scholar-scraper", () => {
        scholarScraper = createScholarScraper({ memoryManager: mm });
        scholarScraper.start();
      });

      await tryStart("news-processor", () => {
        newsProcessor = createNewsProcessor({ memoryManager: mm });
        newsProcessor.start();
      });

      await tryStart("dexscreener-processor", () => {
        dexScreenerProcessor = createDexScreenerProcessor({ memoryManager: mm });
        dexScreenerProcessor.start();
      });

      // Log aggregate result
      if (failed.length > 0) {
        log.error("Subsystem startup completed with failures", {
          started: started.length,
          failed: failed.length,
          failedNames: failed,
        });
      } else {
        log.info("All subsystems started successfully", {
          count: started.length,
        });
      }

      // If ALL subsystems failed, the process is useless — crash hard
      const total = started.length + failed.length;
      if (total > 0 && started.length === 0) {
        throw new Error(
          `All ${failed.length} subsystems failed to start: ${failed.join(", ")}`,
        );
      }

      return {
        instances: {
          liveHub,
          marketPipeline,
          bookmarkProcessor,
          autolikeProcessor,
          autofollowProcessor,
          timelineScrapeProcessor,
          phScraper,
          hnScraper,
          hfScraper,
          redditScraper,
          githubScraper,
          arxivScraper,
          scholarScraper,
          newsProcessor,
          dexScreenerProcessor,
        },
        failed,
        started,
      };
    },

    async stopAll(): Promise<void> {
      if (hnScraper) {
        hnScraper.stop();
        hnScraper = undefined;
        log.info("HN scraper stopped");
      }

      if (hfScraper) {
        hfScraper.stop();
        hfScraper = undefined;
        log.info("HF scraper stopped");
      }

      if (redditScraper) {
        redditScraper.stop();
        redditScraper = undefined;
        log.info("Reddit scraper stopped");
      }

      if (phScraper) {
        phScraper.stop();
        phScraper = undefined;
        log.info("PH scraper stopped");
      }

      if (githubScraper) {
        githubScraper.stop();
        githubScraper = undefined;
        log.info("GitHub scraper stopped");
      }

      if (arxivScraper) {
        arxivScraper.stop();
        arxivScraper = undefined;
        log.info("arXiv scraper stopped");
      }

      if (scholarScraper) {
        scholarScraper.stop();
        scholarScraper = undefined;
        log.info("Scholar scraper stopped");
      }

      if (bookmarkProcessor) {
        bookmarkProcessor.stop();
        bookmarkProcessor = undefined;
        log.info("Bookmark processor stopped");
      }

      if (autolikeProcessor) {
        autolikeProcessor.stop();
        autolikeProcessor = undefined;
        log.info("Autolike processor stopped");
      }

      if (autofollowProcessor) {
        autofollowProcessor.stop();
        autofollowProcessor = undefined;
        log.info("Autofollow processor stopped");
      }

      if (timelineScrapeProcessor) {
        timelineScrapeProcessor.stop();
        timelineScrapeProcessor = undefined;
        log.info("Timeline scrape processor stopped");
      }

      if (newsProcessor) {
        newsProcessor.stop();
        newsProcessor = undefined;
        log.info("News processor stopped");
      }

      if (dexScreenerProcessor) {
        dexScreenerProcessor.stop();
        dexScreenerProcessor = undefined;
        log.info("DexScreener processor stopped");
      }

      if (marketPipeline) {
        await marketPipeline.stop();
        marketPipeline = undefined;
        log.info("Market pipeline stopped");
      }
    },
  };
}
