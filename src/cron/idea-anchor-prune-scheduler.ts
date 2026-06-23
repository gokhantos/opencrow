/**
 * idea-anchor-prune-scheduler.ts — the cron-side retention prune for the
 * `:IdeaAnchor` log written by the graph outcome-feedback loop (Phase 3).
 *
 * WHY a bespoke scheduler and NOT a CronPayload job: a CronPayload routes through
 * `runAgentIsolated` — it can only express an AGENT invocation. This work is a
 * pure maintenance job (DETACH DELETE aged `:IdeaAnchor` nodes via the WRITE
 * client); there is no agent, prompt, or tool surface, so it cannot be modeled as
 * a CronPayload. It mirrors {@link ../cron/deferred-outcome-scheduler}'s
 * start/stop/non-reentrant-tick SHAPE but runs its own tick body.
 *
 * WHY a prune is needed: each pipeline run MERGEs a NEW `:IdeaAnchor {runId}` node
 * (the MERGE is idempotent per runId, but every fresh run is a fresh runId → a new
 * node), so the anchor set grows unbounded once graphFeedback is enabled. This caps
 * it at `anchorRetentionDays`. SAFE — the read path (OPPORTUNITY_PATHS_CYPHER)
 * never traverses `:IdeaAnchor`; it ranks `:Entity.success_weight` projected from
 * the Postgres event log, so pruning anchors cannot regress reasoning.
 *
 * PLATFORM SAFETY (hard requirements):
 *   - NON-REENTRANT: a tick still running skips the next interval fire.
 *   - The whole tick body is wrapped in try/catch so a throw can never escalate
 *     into an unhandledRejection that crash-loops the cron child. The WRITE client
 *     is already never-throw, but the guard is belt-and-suspenders. We log only
 *     {err, deleted} — NEVER the Neo4j config / password / token.
 *   - The clock is injected (`nowSec`) — no Date.now() inside the pure tick logic
 *     surface; the scheduler stamps it at the call boundary.
 *   - stop()/drain() lets the supervisor shut it down within the ~10s window.
 */

import { createLogger } from "../logger";
import type { Neo4jWriteClient } from "../sige/knowledge/neo4j-write-client";

const log = createLogger("cron:idea-anchor-prune");

const SECONDS_PER_DAY = 86_400;

/** Config slice the prune scheduler needs — a focused slice, not the whole config. */
export interface IdeaAnchorPruneSchedulerConfig {
  /** How often the prune runs (ms). */
  readonly tickIntervalMs: number;
  /** Anchors older than this many days are DETACH DELETEd each tick. */
  readonly anchorRetentionDays: number;
}

export interface CreateIdeaAnchorPruneSchedulerDeps {
  /** The WRITE client (already never-throw) used to run the prune. */
  readonly writeClient: Neo4jWriteClient;
  readonly config: IdeaAnchorPruneSchedulerConfig;
}

export interface IdeaAnchorPruneScheduler {
  start(): void;
  stop(): void;
  /** Run one tick immediately (used by tests + drain). Never throws. */
  tickOnce(): Promise<void>;
  /** Await the in-flight tick (if any) so the supervisor can shut down cleanly. */
  drain(): Promise<void>;
}

export function createIdeaAnchorPruneScheduler(
  deps: CreateIdeaAnchorPruneSchedulerDeps,
): IdeaAnchorPruneScheduler {
  const { writeClient, config } = deps;

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let ticking = false;
  let inflight: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (ticking) return; // non-reentrant
    ticking = true;
    const run = (async () => {
      try {
        const nowSec = Math.floor(Date.now() / 1000);
        const cutoff = nowSec - config.anchorRetentionDays * SECONDS_PER_DAY;
        const deleted = await writeClient.pruneIdeaAnchors(cutoff);
        if (deleted > 0) {
          log.info("Pruned aged idea anchors", {
            deleted,
            anchorRetentionDays: config.anchorRetentionDays,
          });
        } else {
          log.debug("Idea-anchor prune tick — nothing to delete");
        }
      } catch (err) {
        // Top-level guard: a throw here must never become an unhandledRejection.
        // (pruneIdeaAnchors is already never-throw, but keep the guard regardless.)
        log.warn("Idea-anchor prune tick failed (non-fatal)", { err });
      } finally {
        ticking = false;
      }
    })();
    inflight = run;
    await run;
    inflight = null;
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        void tick();
      }, config.tickIntervalMs);
      log.info("Idea-anchor prune scheduler started", {
        tickIntervalMs: config.tickIntervalMs,
        anchorRetentionDays: config.anchorRetentionDays,
      });
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log.info("Idea-anchor prune scheduler stopped");
    },
    async tickOnce(): Promise<void> {
      await tick();
    },
    async drain(): Promise<void> {
      if (inflight) await inflight;
    },
  };
}
