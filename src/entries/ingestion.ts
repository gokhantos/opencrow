/**
 * Standalone entry point for the continuous data-ingestion process.
 *
 * Runs on a timer and incrementally ingests scraped project data (app reviews,
 * Reddit posts, HN stories, PH products, apps) into the mem0 knowledge graph via
 * the mem0 REST API. The corpus it populates is SHARED — read by BOTH the
 * generation pipeline (graph-reasoning) AND SIGE — so this is a first-class
 * top-level domain, independent of `config.sige`.
 *
 * The ingestion logic lives in `src/ingestion/`; this entry only wires config →
 * runtime and drives the re-entrancy-safe scheduler.
 *
 * Cursor positions and daily counts are persisted in config_overrides so each
 * run picks up exactly where the previous one stopped (see src/ingestion/cursor).
 *
 * Re-entrancy: a single boolean guard prevents overlapping cycles. The timer uses
 * run-then-reschedule (setTimeout after resolution) so the gap between cycles is
 * config.ingestion.pollIntervalMs regardless of cycle duration.
 *
 * Usage:
 *   bun src/entries/ingestion.ts
 */

import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { Mem0Client } from "../sige/knowledge/mem0-client";
import { type IngestionRuntime, runIngestionCycle } from "../ingestion";
import { createLogger } from "../logger";

const log = createLogger("ingestion");

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "ingestion",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 3,
  });

  const config = await loadConfigWithOverrides();

  // Ingestion is a first-class domain, fully INDEPENDENT of the SIGE idea engine.
  // It keeps the shared corpus fresh whether or not SIGE is enabled — and even
  // when the `sige` section is absent. Exit only when ingestion is explicitly
  // disabled.
  const ingestionConfig = config.ingestion;
  if (ingestionConfig.enabled === false) {
    log.info("Data ingestion disabled — exiting");
    process.exit(0);
  }

  const mem0 = new Mem0Client({
    baseUrl: ingestionConfig.mem0.baseUrl,
    apiToken: ingestionConfig.mem0.apiToken,
  });

  const runtime: IngestionRuntime = {
    mem0,
    userId: ingestionConfig.mem0.userId,
    batchSize: ingestionConfig.batchSize,
    maxRecordsPerDay: ingestionConfig.maxRecordsPerDay,
    minContentLength: ingestionConfig.minContentLength,
  };

  const pollIntervalMs = ingestionConfig.pollIntervalMs;

  log.info("Data ingestion process started", {
    mem0BaseUrl: ingestionConfig.mem0.baseUrl,
    userId: runtime.userId,
    batchSize: runtime.batchSize,
    intervalMs: pollIntervalMs,
    minContentLength: runtime.minContentLength,
    maxRecordsPerDay: runtime.maxRecordsPerDay,
  });

  // Re-entrancy: run-then-reschedule with a single in-flight guard. The gap
  // between cycles is pollIntervalMs regardless of cycle duration. try/finally
  // ensures a crashed cycle still reschedules.
  let running = false;

  async function scheduleNext(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    void tick();
  }

  async function tick(): Promise<void> {
    if (running) {
      log.warn("Ingestion cycle still in progress — skipping overlapping tick");
      void scheduleNext();
      return;
    }
    running = true;
    try {
      await runIngestionCycle(runtime);
    } catch (err) {
      log.warn("Ingestion cycle failed — will retry next interval", { err });
    } finally {
      running = false;
      void scheduleNext();
    }
  }

  // Run an immediate first cycle, then schedule subsequent cycles.
  try {
    await runIngestionCycle(runtime);
  } catch (err) {
    log.warn("First ingestion cycle failed — will retry next interval", { err });
  }
  void scheduleNext();
}

// Import-safe: only register process-level handlers and start the process when
// this file is executed directly (`bun run src/entries/ingestion.ts`), NOT when
// imported. (The pure ingestion helpers live in src/ingestion/ and are imported
// directly by tests, so importing this entry never triggers main().)
if (import.meta.main) {
  process.on("unhandledRejection", (reason: unknown) => {
    log.error("Unhandled promise rejection (non-fatal)", { error: reason });
  });

  process.on("uncaughtException", (error: Error) => {
    log.error("Uncaught exception — exiting", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  main().catch((err) => {
    log.error("Data ingestion process failed to start", { error: err });
    process.exit(1);
  });
}
