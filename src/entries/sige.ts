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
import { createAutonomousSigeScheduler } from "../sige/auto/scheduler";
import { acquireSigeRunSlot } from "../sige/auto/run-guard";
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

  // Cap to 1 session per poll cycle — each session is already highly parallel
  // internally, and processing multiple sessions concurrently would bypass the
  // advisory-lock cost guardrail for autonomous runs.
  const session = pendingSessions[0];
  if (session === undefined) return;

  // Acquire the cross-process run slot before starting the session.
  // If another process/cycle holds it, skip this cycle — the next poll will retry.
  const slot = await acquireSigeRunSlot(1);
  if (!slot.acquired) {
    log.info("SIGE run slot not available — skipping this poll cycle", {
      sessionId: session.id,
    });
    return;
  }

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
  } finally {
    await slot.release();
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

  // ── Autonomous scheduler (default-OFF) ──────────────────────────────────────
  // Only wired when smart.sigeAuto.enabled is explicitly true. With the default
  // config (enabled=false) this block is never entered and zero behavior changes.
  const smart = config.pipelines.ideas.smart;
  let autoSched: ReturnType<typeof createAutonomousSigeScheduler> | null = null;

  if (smart.sigeAuto.enabled) {
    autoSched = createAutonomousSigeScheduler({
      cfg: smart.sigeAuto,
      signal,
    });
    supervisor.onShutdown(() => autoSched?.stop());
    log.info("Autonomous SIGE scheduler created", {
      cadence: smart.sigeAuto.cadence,
      maxDeepFrontiers: smart.sigeAuto.maxDeepFrontiers,
    });
  }

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

  // Start autonomous scheduler AFTER the first poll so the process is
  // fully initialised before any auto-tick fires.
  if (autoSched !== null) {
    autoSched.start();
  }

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
