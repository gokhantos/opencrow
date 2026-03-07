import { createLogger } from "../logger";
import { refreshOutcomeCaches } from "../agent/outcome-orchestrator";

const log = createLogger("cron-outcome-cache");

/**
 * Cron job handler for refreshing outcome caches
 * Runs every 30 minutes to update outcome routing caches
 */
export async function runOutcomeCacheRefresh(): Promise<{
  cachesUpdated: number;
  success: boolean;
}> {
  try {
    log.info("Running outcome cache refresh cron job");

    const cachesUpdated = await refreshOutcomeCaches();

    log.info("Outcome cache refresh completed", { cachesUpdated });

    return {
      cachesUpdated,
      success: true,
    };
  } catch (err) {
    log.warn("Outcome cache refresh failed", { error: String(err) });
    return {
      cachesUpdated: 0,
      success: false,
    };
  }
}
