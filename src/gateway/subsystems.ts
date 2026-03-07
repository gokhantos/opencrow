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

export interface SubsystemRegistry {
  startAll(): Promise<SubsystemInstances>;
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
    async startAll(): Promise<SubsystemInstances> {
      try {
        if (config.market.enabled) {
          liveHub = createLiveKlineHub();
          marketPipeline = createMarketPipeline(config.market, liveHub);
          await marketPipeline.start();
          log.info("Market pipeline started", {
            marketTypes: config.market.marketTypes,
            symbols: config.market.symbols,
          });
        }
      } catch (err) {
        log.error("Market pipeline failed to start (non-fatal)", { error: err });
      }

      try {
        bookmarkProcessor = createBookmarkProcessor();
        bookmarkProcessor.start();
        log.info("Bookmark processor started");
      } catch (err) {
        log.error("Bookmark processor failed to start (non-fatal)", { error: err });
      }

      try {
        autolikeProcessor = createAutolikeProcessor();
        autolikeProcessor.start();
        log.info("Autolike processor started");
      } catch (err) {
        log.error("Autolike processor failed to start (non-fatal)", { error: err });
      }

      try {
        autofollowProcessor = createAutofollowProcessor();
        autofollowProcessor.start();
        log.info("Autofollow processor started");
      } catch (err) {
        log.error("Autofollow processor failed to start (non-fatal)", { error: err });
      }

      try {
        timelineScrapeProcessor = createTimelineScrapeProcessor({ memoryManager: mm });
        timelineScrapeProcessor.start();
        log.info("Timeline scrape processor started");
      } catch (err) {
        log.error("Timeline processor failed to start (non-fatal)", { error: err });
      }

      try {
        phScraper = createPHScraper({ memoryManager: mm });
        phScraper.start();
        log.info("PH scraper started");
      } catch (err) {
        log.error("PH scraper failed to start (non-fatal)", { error: err });
      }

      try {
        hnScraper = createHNScraper({ memoryManager: mm });
        hnScraper.start();
        log.info("HN scraper started");
      } catch (err) {
        log.error("HN scraper failed to start (non-fatal)", { error: err });
      }

      try {
        hfScraper = createHFScraper({ memoryManager: mm });
        hfScraper.start();
        log.info("HF scraper started");
      } catch (err) {
        log.error("HF scraper failed to start (non-fatal)", { error: err });
      }

      try {
        redditScraper = createRedditScraper({ memoryManager: mm });
        redditScraper.start();
        log.info("Reddit scraper started");
      } catch (err) {
        log.error("Reddit scraper failed to start (non-fatal)", { error: err });
      }

      try {
        githubScraper = createGithubScraper({ memoryManager: mm });
        githubScraper.start();
        log.info("GitHub scraper started");
      } catch (err) {
        log.error("GitHub scraper failed to start (non-fatal)", { error: err });
      }

      try {
        arxivScraper = createArxivScraper({ memoryManager: mm });
        arxivScraper.start();
        log.info("arXiv scraper started");
      } catch (err) {
        log.error("arXiv scraper failed to start (non-fatal)", { error: err });
      }

      try {
        scholarScraper = createScholarScraper({ memoryManager: mm });
        scholarScraper.start();
        log.info("Scholar scraper started");
      } catch (err) {
        log.error("Scholar scraper failed to start (non-fatal)", { error: err });
      }

      try {
        newsProcessor = createNewsProcessor({ memoryManager: mm });
        newsProcessor.start();
        log.info("News processor started");
      } catch (err) {
        log.error("News processor failed to start (non-fatal)", { error: err });
      }

      try {
        dexScreenerProcessor = createDexScreenerProcessor({ memoryManager: mm });
        dexScreenerProcessor.start();
        log.info("DexScreener processor started");
      } catch (err) {
        log.error("DexScreener processor failed to start (non-fatal)", { error: err });
      }

      return {
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
