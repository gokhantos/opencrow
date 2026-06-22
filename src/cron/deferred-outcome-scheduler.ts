/**
 * deferred-outcome-scheduler.ts — the cron-side driver of the deferred outcome
 * re-probe (Phase 2 of the idea-learning loop).
 *
 * WHY a bespoke scheduler and NOT a CronPayload job: a CronPayload routes through
 * `runAgentIsolated` — it can only express an AGENT invocation. This work is a
 * pure data job (claim due rows → re-run demand probes → diff vs baseline →
 * supersede a mem0 memory); there is no agent, prompt, or tool surface, so it
 * cannot be modeled as a CronPayload. It therefore mirrors createCronScheduler's
 * start/stop/non-reentrant-tick SHAPE but runs its own tick body.
 *
 * PLATFORM SAFETY (hard requirements):
 *   - Per tick: claim <= batchSize due rows and process them ONE AT A TIME (await
 *     sequentially — NEVER Promise.all; each enrichDemand fans out ~6 DB-bound
 *     probes against the SHARED Postgres and would stampede it under parallelism).
 *   - NON-REENTRANT: a tick that is still running skips the next interval fire.
 *   - The whole tick body is wrapped in try/catch so a throw (mem0 down, probe
 *     error) can never escalate into an unhandledRejection that crash-loops the
 *     cron child. We log {err, ideaId} only — NEVER the mem0/Neo4j config / tokens.
 *   - SUPERSEDE uses ADD-BEFORE-DELETE: write the new reprobe memory FIRST, THEN
 *     delete the prior memories for that idea, so a crash mid-way leaves a harmless
 *     duplicate (deduped by the P1 ranking) rather than a hole. The supersede
 *     INTENT (claimed_at) is already stamped in the table by claimDueReprobes
 *     BEFORE the mem0 mutation, so a re-run won't re-claim the same row.
 *   - stop()/drain() lets the supervisor shut it down within the ~10s window.
 */

import { createLogger } from "../logger";
import type { Mem0Client } from "../sige/knowledge/mem0-client";
import {
  DEFAULT_DEMAND_PROBES,
  enrichDemand,
} from "../pipelines/ideas/demand-probes";
import { buildEnrichDemandConfig } from "../pipelines/ideas/pipeline-stamps";
import type { DemandConfig } from "../config/schema";
import { ARCHETYPES, type Archetype } from "../pipelines/ideas/giant";
import {
  deletePriorOutcomeMemories,
  renderOutcomeSentence,
  toOutcomeMemory,
  writeOutcomeMemories,
} from "../pipelines/ideas/outcome-memory";
import {
  reprobeLabelFromDelta,
  type ReprobeDeltaOptions,
} from "../pipelines/ideas/deferred-outcome-reprobe";
import type {
  ClaimedReprobe,
  DeferredOutcomeStore,
} from "../pipelines/ideas/deferred-outcome-store";

const log = createLogger("cron:deferred-outcome");

// Provenance stamped onto reprobe outcome memories. A re-probe has no synthesis
// run/prompt; these stable sentinels mirror the human-verdict path. The
// verdictSource ("reprobe:*") carries the real meaning.
const REPROBE_RUN_ID = "deferred-reprobe";
const REPROBE_PROMPT_VERSION = "deferred-reprobe";
const REPROBE_MODEL = "deferred-reprobe";

/** Config the scheduler needs — a focused slice, not the whole OpenCrowConfig. */
export interface DeferredOutcomeSchedulerConfig {
  readonly reprobe: ReprobeDeltaOptions & {
    readonly tickIntervalMs: number;
    readonly batchSize: number;
  };
  /** Demand config used to rebuild the enrichDemand cfg (same probes as synthesis). */
  readonly demand: DemandConfig;
  /** mem0 userId the outcome memories live under (sige-ideas). */
  readonly ideasUserId: string;
}

export interface CreateDeferredOutcomeSchedulerDeps {
  readonly deferredStore: DeferredOutcomeStore;
  /** Lazily construct a mem0 client per tick (so a config/down sidecar is contained). */
  readonly mem0Factory: () => Mem0Client;
  readonly config: DeferredOutcomeSchedulerConfig;
}

export interface DeferredOutcomeScheduler {
  start(): void;
  stop(): void;
  /** Run one tick immediately (used by tests + drain). Never throws. */
  tickOnce(): Promise<void>;
  /** Await the in-flight tick (if any) so the supervisor can shut down cleanly. */
  drain(): Promise<void>;
}

/** Coerce a stored archetype string back to the Archetype enum, or null. PURE. */
function asArchetype(value: string | null): Archetype | null {
  return value !== null && (ARCHETYPES as readonly string[]).includes(value)
    ? (value as Archetype)
    : null;
}

export function createDeferredOutcomeScheduler(
  deps: CreateDeferredOutcomeSchedulerDeps,
): DeferredOutcomeScheduler {
  const { deferredStore, mem0Factory, config } = deps;
  const deltaOpts: ReprobeDeltaOptions = {
    scoreDeltaGrew: config.reprobe.scoreDeltaGrew,
    scoreDeltaDecayed: config.reprobe.scoreDeltaDecayed,
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let ticking = false;
  let inflight: Promise<void> | null = null;

  /** Process ONE claimed re-probe. Never throws — logs {err, ideaId} only. */
  async function processOne(mem0: Mem0Client, claimed: ClaimedReprobe): Promise<void> {
    try {
      const demandCfg = buildEnrichDemandConfig(config.demand);
      const current = await enrichDemand(
        { title: claimed.title },
        DEFAULT_DEMAND_PROBES,
        demandCfg,
      );

      const classification = reprobeLabelFromDelta(claimed.baselineDemand, current, deltaOpts);
      const recordedAt = Math.floor(Date.now() / 1000);

      // Inconclusive → record the row only; the original verdict stands, no mem0 write.
      if (classification.verdict === null || classification.verdictSource === null) {
        await deferredStore.recordReprobeOutcome({
          id: claimed.id,
          label: classification.label,
          reprobeDemand: current,
          scoreDelta: classification.scoreDelta,
          recordedAt,
        });
        log.info("Re-probe inconclusive — verdict left intact", {
          ideaId: claimed.ideaId,
          scoreDelta: Number(classification.scoreDelta.toFixed(2)),
        });
        return;
      }

      // Build the superseding outcome memory from the re-probe demand artifact.
      const memory = toOutcomeMemory(
        {
          ideaId: claimed.ideaId,
          segment: claimed.segment,
          archetype: asArchetype(claimed.archetype),
          giantComposite: null,
        },
        { verdict: classification.verdict, verdictSource: classification.verdictSource },
        { gate: null, sigeDissent: null, convergenceVeto: null, demand: current },
        {
          runId: REPROBE_RUN_ID,
          promptVersion: REPROBE_PROMPT_VERSION,
          model: REPROBE_MODEL,
          createdAtSec: recordedAt,
        },
      );

      // ADD-BEFORE-DELETE: write the new memory FIRST, then delete priors. A crash
      // between the two leaves a harmless duplicate (P1 ranking dedups by ideaId),
      // never a hole that erases the prior verdict.
      await writeOutcomeMemories(
        mem0,
        [{ sentence: renderOutcomeSentence(memory, claimed.title), metadata: memory }],
        config.ideasUserId,
      );
      await deletePriorOutcomeMemories(mem0, config.ideasUserId, claimed.ideaId);

      await deferredStore.recordReprobeOutcome({
        id: claimed.id,
        label: classification.label,
        reprobeDemand: current,
        scoreDelta: classification.scoreDelta,
        recordedAt,
      });

      log.info("Re-probe superseded verdict", {
        ideaId: claimed.ideaId,
        label: classification.label,
        verdict: classification.verdict,
        scoreDelta: Number(classification.scoreDelta.toFixed(2)),
      });
    } catch (err) {
      // Contain ALL per-idea failures (mem0 down, probe error) — never re-throw.
      log.warn("Re-probe processing failed (non-fatal)", { err, ideaId: claimed.ideaId });
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return; // non-reentrant
    ticking = true;
    const run = (async () => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const due = await deferredStore.claimDueReprobes(config.reprobe.batchSize, now);
        if (due.length === 0) return;

        const mem0 = mem0Factory();
        // Sequential — NEVER Promise.all: each enrichDemand fans out DB-bound probes.
        for (const claimed of due) {
          await processOne(mem0, claimed);
        }
      } catch (err) {
        // Top-level guard: a throw here must never become an unhandledRejection.
        log.warn("Deferred-outcome tick failed (non-fatal)", { err });
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
      }, config.reprobe.tickIntervalMs);
      log.info("Deferred-outcome scheduler started", {
        tickIntervalMs: config.reprobe.tickIntervalMs,
        batchSize: config.reprobe.batchSize,
      });
    },
    stop(): void {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log.info("Deferred-outcome scheduler stopped");
    },
    async tickOnce(): Promise<void> {
      await tick();
    },
    async drain(): Promise<void> {
      if (inflight) await inflight;
    },
  };
}
