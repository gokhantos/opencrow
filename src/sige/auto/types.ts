/**
 * Shared readonly types for the autonomous-SIGE slice.
 *
 * Only types that are referenced across more than one autonomous-SIGE module
 * live here. Types that belong to a single module are declared (and exported)
 * by that module:
 *   - `Frontier`, `BroadCorpus`, `DiscoveryResult`, `FrontierScoringContext`,
 *     `DiscoverFrontiersOptions` → `src/sige/discovery/frontier-discovery.ts`
 *   - `AutoTickResult` (scheduler-internal) → `src/sige/auto/scheduler.ts`
 *   - `SigeRunSlot` → `src/sige/auto/run-guard.ts`
 *
 * Default-OFF invariant: nothing here changes behavior; these are pure shapes.
 */

import type { ScoredIdea, SigeSessionConfig } from "../types";

/**
 * A coarse, human-readable theme label plus its normalized n-gram keys.
 *
 * `themeKeys` are the same normalized n-gram keys used for saturation overlap
 * (see `extractThemesByNgrams` / `extractSaturatedThemeKeys`), so a frontier's
 * theme can be diffed against already-saturated `generated_ideas` themes
 * without re-tokenizing.
 */
export interface FrontierTheme {
  /** Human-readable cluster label (e.g. the most representative bigram). */
  readonly label: string;
  /** Normalized n-gram keys for saturation overlap. */
  readonly keys: readonly string[];
}

/**
 * Options for the seedless depth stage: running the EXISTING expert game over a
 * synthesized frontier seed without a `sige_sessions` DB lifecycle.
 *
 * Consumed by the autonomous pipeline (`pipeline-autonomous.ts`) and the run
 * adapter. Kept here so both the discovery stage and the pipeline can agree on
 * the contract without a circular import through `run.ts`.
 */
export interface RunSigeForCandidatesOptions {
  /** Synthetic enriched-seed text for the depth game (from `Frontier.seedText`). */
  readonly seedText: string;
  /** Mem0 graph namespace; defaults to "sige-global" downstream. */
  readonly userId?: string;
  /** SIGE session config (fast profile for autonomous runs). */
  readonly config?: SigeSessionConfig;
  /** Logging/keying id; a UUID is minted downstream if absent. */
  readonly sessionId?: string;
  /** Combined process + per-run timeout signal. */
  readonly signal?: AbortSignal;
}

/**
 * Result of a single depth-stage expert game over one frontier.
 *
 * `rankedIdeas` carry the expert game's own scoring; the back-half re-scores
 * them via GIANT, so these are treated as UNSCORED inputs by
 * `mapDeepGameRankedToCandidate`.
 */
export interface DeepGameResult {
  /** Frontier id this game was run for (for provenance/audit). */
  readonly frontierId: string;
  /** Ranked ideas from the expert game (re-scored by the back-half). */
  readonly rankedIdeas: readonly ScoredIdea[];
}

/**
 * Read-only snapshot of the broad-stage collectors used by the discovery stage.
 *
 * The autonomous pipeline runs the three existing collectors once and passes
 * the result down so discovery and the back-half share the same corpus rather
 * than re-scraping. `selected` carries the signal-consumption set so the
 * pipeline can `markConsumed` exactly once after the store step.
 */
export interface CollectorResult {
  /** Opaque collector context payload (signals selected for this run). */
  readonly selected: readonly string[];
}

/**
 * Outcome of one autonomous poll-and-process cycle at the SIGE-process level.
 *
 * Distinct from the scheduler-internal `AutoTickResult` (which describes whether
 * a session was *enqueued*): this describes whether a pending session was
 * *processed* by `pollAndProcess`, and is surfaced to the process supervisor
 * for logging. Named separately to avoid a misleading name collision.
 */
export interface AutoPollResult {
  readonly processed: boolean;
  readonly reason: "processed" | "no-slot" | "no-work" | "disabled" | "error";
  readonly sessionId?: string;
}
