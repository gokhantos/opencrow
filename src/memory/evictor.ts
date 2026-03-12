import { createLogger } from "../logger";
import type { MemoryManager } from "./types";
import type { MemoryEvictionConfig } from "../config/schema";

const log = createLogger("memory:evictor");

export interface MemoryEvictor {
  start(): void;
  stop(): void;
}

export function createMemoryEvictor(
  config: MemoryEvictionConfig,
  memoryManager: MemoryManager,
): MemoryEvictor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const intervalMs = config.intervalMinutes * 60 * 1000;

  async function runEviction(): Promise<void> {
    try {
      const result = await memoryManager.evict({
        ttlDays: config.ttlDays,
        batchSize: config.batchSize,
      });

      if (result.sourcesDeleted > 0) {
        log.info("Memory eviction tick", {
          sourcesDeleted: result.sourcesDeleted,
          chunksDeleted: result.chunksDeleted,
        });
      } else {
        log.debug("Memory eviction tick — nothing to evict");
      }
    } catch (err) {
      log.error("Memory eviction tick failed", { err });
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(runEviction, intervalMs);
      log.info("Memory evictor started", {
        ttlDays: config.ttlDays,
        intervalMinutes: config.intervalMinutes,
        batchSize: config.batchSize,
      });
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Memory evictor stopped");
      }
    },
  };
}
