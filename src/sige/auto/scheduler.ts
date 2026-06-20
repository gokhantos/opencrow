/**
 * Autonomous SIGE scheduler.
 *
 * A thin, cadence-driven trigger that lives INSIDE the existing SIGE process
 * (no new process, no manifest change). On each tick it enqueues at most ONE
 * seedless `origin='auto'` session, guarded by a cross-process advisory-lock
 * slot and a single-flight check on already-runnable autonomous sessions.
 *
 * Default-OFF invariant: when `cfg.enabled` is false every tick short-circuits
 * to `reason: 'disabled'` and no session is ever created.
 */

import type { SigeAutoConfig } from "../../config/schema";
import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { getModelRoute } from "../../store/model-routing";
import { DEFAULT_SIGE_SESSION_CONFIG } from "../run";
import { createSession } from "../store";
import type { SigeSessionConfig } from "../types";
import { acquireSigeRunSlot, countRunnableSessions } from "./run-guard";

const log = createLogger("sige:scheduler");

/** Daily cadence interval in ms (24h). */
const DAILY_INTERVAL_MS = 86_400_000;

export type AutoTickResult = {
  readonly enqueued: boolean;
  readonly reason: "enqueued" | "disabled" | "already-active" | "too-soon" | "error";
  readonly sessionId?: string;
};

/**
 * Map a cadence to its auto-tick interval in ms. PURE.
 *
 * - 'daily'  → 86_400_000 (24h)
 * - 'manual' → Number.MAX_SAFE_INTEGER (effectively never auto-ticks; only the
 *   POST /pipelines/autonomous-sige/run endpoint triggers a run)
 */
export function cadenceToIntervalMs(cadence: SigeAutoConfig["cadence"]): number {
  if (cadence === "daily") return DAILY_INTERVAL_MS;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * The trimmed "fast profile" used for autonomous sessions: a cheap agent model
 * (resolved by the caller from the `sige.fast-agent` route) and reduced
 * expert/social rounds to keep the unattended cost bounded. PURE.
 */
function buildFastProfile(model: string): SigeSessionConfig {
  return {
    ...DEFAULT_SIGE_SESSION_CONFIG,
    agentModel: model,
    expertRounds: 2,
    socialRounds: 2,
  };
}

export interface AutonomousSigeScheduler {
  start(): void;
  stop(): void;
  tickOnce(): Promise<AutoTickResult>;
}

/**
 * Create the autonomous SIGE scheduler.
 *
 * @param deps.cfg    The `smart.sigeAuto` config block.
 * @param deps.signal Process-level abort signal; the scheduler stops ticking
 *                    once it aborts.
 * @param deps.now    Injectable clock for unit tests (defaults to Date.now).
 */
export function createAutonomousSigeScheduler(deps: {
  readonly cfg: SigeAutoConfig;
  readonly signal: AbortSignal;
  readonly now?: () => number;
}): AutonomousSigeScheduler {
  const { cfg, signal } = deps;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tickOnce(): Promise<AutoTickResult> {
    if (!cfg.enabled) return { enqueued: false, reason: "disabled" };

    const slot = await acquireSigeRunSlot(cfg.maxConcurrent);
    if (!slot.acquired) return { enqueued: false, reason: "already-active" };

    try {
      // Single-flight: never stack a second autonomous session while one is
      // queued or in flight.
      const { pending, inFlight } = await countRunnableSessions();
      if (pending + inFlight > 0) {
        return { enqueued: false, reason: "already-active" };
      }

      // Fast-agent model comes from the `sige.fast-agent` route (DB-backed, hot
      // reloaded per tick).
      const { model: fastAgentModel } = await getModelRoute("sige.fast-agent");

      const sessionId = crypto.randomUUID();
      try {
        await createSession({
          id: sessionId,
          seedInput: null,
          origin: "auto",
          status: "pending",
          configJson: JSON.stringify(buildFastProfile(fastAgentModel)),
        });
      } catch (err) {
        // A NOT NULL violation here means migration 020 (seed_input nullable)
        // has not been applied. Surface it loudly but never crash the process.
        const message = getErrorMessage(err);
        if (/not[- ]null|null value/i.test(message)) {
          log.error(
            "createSession rejected null seed_input — migration 020_sige_seed_nullable.sql is missing",
            { err: message },
          );
        } else {
          log.error("createSession failed during autonomous tick", { err: message });
        }
        return { enqueued: false, reason: "error" };
      }

      log.info("autonomous SIGE session enqueued", { sessionId });
      return { enqueued: true, reason: "enqueued", sessionId };
    } catch (err) {
      log.warn("autonomous tick failed (non-fatal)", { err: getErrorMessage(err) });
      return { enqueued: false, reason: "error" };
    } finally {
      await slot.release();
    }
  }

  function start(): void {
    if (timer !== null) return;
    if (signal.aborted) return;

    // Kick immediately, then on cadence.
    void tickOnce().catch((err) => {
      log.warn("initial autonomous tick threw (swallowed)", {
        err: getErrorMessage(err),
      });
    });

    const intervalMs = cadenceToIntervalMs(cfg.cadence);
    timer = setInterval(() => {
      if (signal.aborted) {
        stop();
        return;
      }
      void tickOnce().catch((err) => {
        log.warn("scheduled autonomous tick threw (swallowed)", {
          err: getErrorMessage(err),
        });
      });
    }, intervalMs);

    // Stop cleanly when the process is shutting down.
    signal.addEventListener("abort", stop, { once: true });
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tickOnce };
}
