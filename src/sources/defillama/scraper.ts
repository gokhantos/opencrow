import { createLogger } from "../../logger";
import type { MemoryManager, DefiProtocolForIndex } from "../../memory/types";
import {
  getUnindexedProtocols,
  markProtocolsIndexed,
  MAJOR_CHAINS,
} from "./store";
import { delay, REQUEST_DELAY_MS, DEFILLAMA_AGENT_ID } from "./api";
import { scrapeProtocols, protocolToDefiProtocolForIndex } from "./scrape-protocols";
import { scrapeChains, scrapeHistoricalTvl, scrapeChainMetrics } from "./scrape-chains";
import { scrapeOverviews } from "./scrape-overviews";
import { scrapeYieldPools } from "./scrape-yields";
import { scrapeBridges } from "./scrape-bridges";
import { scrapeMiscData } from "./scrape-misc";
import type { DefiLlamaScraper, ScrapeResult } from "./types";

const log = createLogger("defillama-scraper");

const TICK_INTERVAL_MS = 7_200_000; // 2 hours

// =============================================================================
// Scraper factory
// =============================================================================

export function createDefiLlamaScraper(config?: {
  memoryManager?: MemoryManager;
}): DefiLlamaScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function indexToMemory(): Promise<void> {
    if (!config?.memoryManager) return;

    try {
      const unindexed = await getUnindexedProtocols(200);
      if (unindexed.length === 0) return;

      const significant = unindexed.filter((p) => {
        const absChange = Math.abs(p.change_1d ?? 0);
        return absChange >= 5 || p.tvl >= 10_000_000;
      });

      if (significant.length === 0) {
        const ids = unindexed.map((p) => p.id);
        await markProtocolsIndexed(ids);
        return;
      }

      const forIndex: readonly DefiProtocolForIndex[] = significant.map(
        protocolToDefiProtocolForIndex,
      );

      const ids = unindexed.map((p) => p.id);

      await config.memoryManager.indexDefiProtocols(DEFILLAMA_AGENT_ID, forIndex);
      await markProtocolsIndexed(ids);
    } catch (err) {
      log.error("Failed to index protocols to memory", {
        error: err,
      });
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    const { protocols } = await scrapeProtocols();
    await delay(REQUEST_DELAY_MS * 2);
    const { chains } = await scrapeChains();
    await delay(REQUEST_DELAY_MS * 2);
    const historyPoints = await scrapeHistoricalTvl();
    await delay(REQUEST_DELAY_MS * 2);
    const metricsChains = await scrapeChainMetrics();
    await delay(REQUEST_DELAY_MS * 2);
    const { protocolDetails, categories } = await scrapeOverviews();

    // 6. Yield pools
    const yieldPools = await scrapeYieldPools();
    await delay(REQUEST_DELAY_MS * 2);

    // 7. Bridges
    const bridgeCount = await scrapeBridges();
    await delay(REQUEST_DELAY_MS * 2);

    // 8. Hacks, stablecoins, emissions, treasury
    const misc = await scrapeMiscData();

    await indexToMemory();
    log.info("DeFi Llama scrape complete", {
      protocols,
      chains,
      historyPoints,
      metricsChains,
      protocolDetails,
      categories,
      yieldPools,
      bridges: bridgeCount,
      hacks: misc.hacks,
      stablecoins: misc.stablecoins,
      emissions: misc.emissions,
      treasury: misc.treasury,
    });
    return {
      ok: true,
      protocols,
      chains,
      historyPoints,
      metricsChains,
      protocolDetails,
      categories,
      yieldPools,
      bridges: bridgeCount,
      hacks: misc.hacks,
      stablecoins: misc.stablecoins,
      emissions: misc.emissions,
      treasury: misc.treasury,
    };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("DeFi Llama scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      log.error("DeFi Llama scrape error", {
        error: err,
      });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("DeFi Llama scraper started", {
        tickMs: TICK_INTERVAL_MS,
        targetChains: MAJOR_CHAINS.join(", "),
      });
      tick().catch((err) =>
        log.error("DeFi Llama scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("DeFi Llama scraper stopped");
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
  };
}
