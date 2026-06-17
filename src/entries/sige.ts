/**
 * Standalone entry point for the SIGE (Strategic Intelligence Game Engine) process.
 *
 * Polls for pending SIGE sessions and runs the full pipeline:
 *   knowledge construction → game formulation → expert game →
 *   social simulation → scoring → report generation
 *
 * The pipeline itself lives in `src/sige/run.ts` as reusable library functions;
 * this file is a thin polling wrapper around `runSession` that owns the
 * standalone-process lifecycle (bootstrap, supervisor, poll loop).
 *
 * Usage:
 *   bun src/entries/sige.ts
 */
import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { createProcessSupervisor } from "../process/supervisor";
import { Mem0Client } from "../sige/knowledge/mem0-client";
import { getPendingSessions, updateSessionStatus } from "../sige/store";
import type { SigeSession } from "../sige/types";
import { runSession } from "../sige/run";
import { createLogger } from "../logger";

const log = createLogger("sige-entry");

const POLL_INTERVAL_MS = 5_000;

// ─── Polling Loop ─────────────────────────────────────────────────────────────

async function pollAndProcess(
  mem0: Mem0Client,
  userId: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;

  let pendingSessions: readonly SigeSession[];

  try {
    pendingSessions = await getPendingSessions();
  } catch (err) {
    log.error("Failed to query pending sessions", { err });
    return;
  }

  if (pendingSessions.length === 0) return;

  // Process sessions sequentially — each is already highly parallel internally
  for (const session of pendingSessions) {
    if (signal.aborted) break;

    try {
      await runSession(session, mem0, userId, signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("SIGE session pipeline failed", { sessionId: session.id, err });

      try {
        await updateSessionStatus(session.id, "failed", { error: msg });
      } catch (updateErr) {
        log.error("Failed to mark session as failed", {
          sessionId: session.id,
          err: updateErr,
        });
      }
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "sige",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 5,
  });

  const config = await loadConfigWithOverrides();

  if (config.sige === undefined || !config.sige.enabled) {
    log.info("SIGE not configured or disabled, exiting");
    process.exit(0);
  }

  const sigeConfig = config.sige;
  const mem0 = new Mem0Client({ baseUrl: sigeConfig.mem0.baseUrl });
  const userId = sigeConfig.mem0.userId;

  log.info("SIGE process started", { mem0BaseUrl: sigeConfig.mem0.baseUrl, userId });

  const supervisor = createProcessSupervisor("sige", { type: "sige" });

  const controller = new AbortController();
  const { signal } = controller;

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  supervisor.onShutdown(() => {
    controller.abort();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  // Block until shutdown. `supervisor.start()` only wires up timers/handlers
  // and resolves immediately — it does NOT block — so we await an explicit
  // shutdown promise to keep the process alive and ensure the "stopped" log
  // fires on real shutdown rather than firing one tick after startup.
  const shutdownComplete = new Promise<void>((resolve) => {
    supervisor.onShutdown(() => resolve());
  });

  // Run an immediate first poll, then schedule subsequent polls
  await pollAndProcess(mem0, userId, signal);

  pollTimer = setInterval(() => {
    pollAndProcess(mem0, userId, signal).catch((err) => {
      log.error("Unexpected error in poll cycle", { err });
    });
  }, POLL_INTERVAL_MS);

  await supervisor.start();
  await shutdownComplete;

  log.info("SIGE process stopped");
}

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
  log.error("SIGE process failed to start", { error: err });
  process.exit(1);
});
