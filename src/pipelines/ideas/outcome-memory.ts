/**
 * outcome-memory.ts — the idea-learning loop's memory layer.
 *
 * After a pipeline run terminally labels its ideas (validated / archived /
 * stored-pending / dedup-rejected), this module distils each verdict into a
 * single natural-language SENTENCE and writes it back to mem0 under a dedicated
 * `sige-ideas` userId. At the next synthesis round those sentences are read back
 * and injected into the generation prompt as semantic GUIDANCE — "reinforce this
 * rigor" / "do not regenerate this pattern" — never as few-shot exemplars.
 *
 * Control-flow (which bucket a memory lands in, reinforce vs avoid) is driven
 * ONLY by the structured Zod metadata on each memory, NEVER by the free-text
 * body. Every body string is sanitizeScrapedField'd AGAIN on read (mem0
 * consolidation can reshape text) and wrapUntrusted before it touches a prompt,
 * because mem0 contents are untrusted by the time they come back.
 *
 * Pure core (toOutcomeMemory / renderOutcomeSentence / buildOutcomeMemoryBlock)
 * has no I/O; writeOutcomeMemories / fetchOutcomeMemoryBlock are best-effort and
 * degrade silently when the mem0 sidecar is down (the client's circuit breaker
 * handles the unavailable case; we log.warn and continue).
 */

import { z } from "zod";
import { createLogger } from "../../logger";
import type { Mem0Client, Mem0Memory } from "../../sige/knowledge/mem0-client";
import { sanitizeScrapedField, wrapUntrusted } from "../../sige/untrusted";
import type { CandidateCompetabilityFields } from "./competability";
import type { DemandArtifact } from "./demand";
import { buildMoatLearningsDirective, highMoats } from "./outcome-competability-correlation";
import {
  type BlockRankOptions,
  selectRankedOutcomes,
  selectTrustRankedOutcomes,
} from "./outcome-memory-rank";
export {
  type BlockRankOptions,
  buildRecallQuery,
  outcomeTrustTier,
  type OutcomeTrustTier,
  type RecallQueryInputs,
} from "./outcome-memory-rank";
import { buildSegmentDiversityDirective } from "./outcome-memory-segments";
export { buildSegmentDiversityDirective } from "./outcome-memory-segments";
import { GIANT_AXIS_KEYS } from "./giant";
import type { Archetype, GiantAggregate, GiantAxisKey } from "./giant";

const log = createLogger("pipeline:outcome-memory");

// ─── Schema ─────────────────────────────────────────────────────────────────

/** Verdict buckets a terminally-resolved idea can land in. */
export const OUTCOME_VERDICTS = [
  "validated",
  "archived",
  "stored-pending",
  "dedup-rejected",
] as const;

/**
 * Competability slice stamped onto an outcome memory when the moat gate scored the
 * idea. EFFECTIVE (profile-adjusted) per-moat dimensions + overall, the RAW
 * (pre-profile) overall for audit, whether the gate would/did reject, and the
 * builder-expertise domain that matched (discounting the dominant moat). Entirely
 * OPTIONAL: absent when an idea was never competability-scored (dedup-rejected
 * themes, pre-feature rows), so a memory with no competability behaves exactly as
 * today. Mirrors {@link CompetabilityPersistedJson} but flattened into mem0 metadata.
 */
export const outcomeCompetabilitySchema = z.object({
  /** EFFECTIVE (profile-adjusted, decided) per-moat dimensions, each 0..5. */
  dimensions: z.object({
    capital: z.number(),
    networkEffect: z.number(),
    logistics: z.number(),
    regulated: z.number(),
  }),
  /** EFFECTIVE "a small builder can win v1" overall (0..5; 5 = wide open). */
  overall: z.number(),
  /** RAW (pre-profile) overall, when a builder profile discounted the score. */
  rawOverall: z.number().nullable(),
  /** Whether the competability gate would/did reject this idea. */
  gated: z.boolean(),
  /** Builder expertise domain that matched (discounted the moat), or null. */
  matchedExpertiseDomain: z.string().nullable(),
});

export type OutcomeCompetability = Readonly<z.infer<typeof outcomeCompetabilitySchema>>;

/**
 * Structured metadata stamped on every outcome memory. This is the ONLY thing
 * the reinforce/avoid control-flow reads — the body sentence is presentation.
 */
export const outcomeMemorySchema = z.object({
  kind: z.literal("idea-outcome"),
  verdict: z.enum(OUTCOME_VERDICTS),
  /** "human" | "proxy:<reason>" | "dedup" | "none". */
  verdictSource: z.string(),
  ideaId: z.string().nullable(),
  segment: z.string().nullable(),
  archetype: z.enum(["hair-on-fire", "hard-fact", "future-vision"]).nullable(),
  giantComposite: z.number().nullable(),
  failingAxes: z.array(z.string()).default([]),
  juryDissent: z.number().nullable(),
  convergenceVeto: z.boolean(),
  demandScore: z.number().nullable(),
  whitespace: z.number().nullable(),
  /**
   * Competability/moat signal for this idea, or absent/null when it was never
   * scored. Optional + nullable so a memory written before this field existed (or
   * for an un-scored idea) parses cleanly and the read side behaves as today. Kept
   * OPTIONAL (not `.default(null)`) so the inferred type stays `T | null |
   * undefined`, matching pre-existing fixtures that omit the field entirely.
   */
  competability: outcomeCompetabilitySchema.nullable().optional(),
  runId: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  createdAtSec: z.number(),
});

export type OutcomeMemory = Readonly<z.infer<typeof outcomeMemorySchema>>;

// ─── toOutcomeMemory (PURE) ───────────────────────────────────────────────────

/**
 * Minimal candidate shape needed to build an outcome memory. Carries the loose
 * per-candidate competability fields ({@link CandidateCompetabilityFields}) so the
 * moat signal can be folded into the memory without an extra DB read — the same
 * fields the pipeline already persists onto the generated_ideas row. All
 * competability fields are optional; absent ⇒ the memory carries no moat slice.
 */
export interface OutcomeCandidate extends CandidateCompetabilityFields {
  readonly ideaId: string | null;
  readonly segment?: string | null;
  readonly archetype?: Archetype | null;
  readonly giantComposite?: number | null;
}

/**
 * Derive the {@link OutcomeCompetability} slice from the loose per-candidate
 * competability fields. Returns null when the candidate was never scored (no
 * `competability` dims), so an un-scored idea carries no moat slice and the
 * read/write paths behave exactly as before. PURE — clamps defensively via the
 * gate's shared bounds (re-using COMPETABILITY_DIMENSIONS), never throws.
 */
export function competabilityFromCandidate(
  fields: CandidateCompetabilityFields,
): OutcomeCompetability | null {
  const dims = fields.competability;
  if (!dims) return null;
  const dimensions = {
    capital: dims.capital,
    networkEffect: dims.networkEffect,
    logistics: dims.logistics,
    regulated: dims.regulated,
  };
  return {
    dimensions,
    overall: typeof fields.competabilityOverall === "number" ? fields.competabilityOverall : 0,
    rawOverall:
      typeof fields.competabilityRawOverall === "number" ? fields.competabilityRawOverall : null,
    gated: fields.competabilityGated === true,
    matchedExpertiseDomain: fields.competabilityMatchedExpertiseDomain ?? null,
  };
}

/** Verdict assignment for a single idea/theme. */
export interface OutcomeVerdict {
  readonly verdict: (typeof OUTCOME_VERDICTS)[number];
  readonly verdictSource: string;
}

/** Run-level provenance stamped onto every memory in a batch. */
export interface OutcomeContext {
  readonly runId: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly createdAtSec: number;
}

/** Optional structured inputs distilled from the GIANT gate / SIGE / demand passes. */
export interface OutcomeSignals {
  readonly gate?: GiantAggregate | null;
  readonly sigeDissent?: number | null;
  readonly convergenceVeto?: boolean | null;
  readonly demand?: DemandArtifact | null;
}

/**
 * Derive the failing GIANT axis KEYS from a gate's `gateReasons`. Reasons look
 * like `hard-gate:acuteProblem score 0 <= 1` or
 * `demand-evidence-gate: demand 3 capped to 1 ...`; we extract the canonical
 * axis token from each so the metadata carries machine-readable keys, not prose.
 * Order-preserving and de-duplicated. PURE.
 */
function deriveFailingAxes(gateReasons: readonly string[]): string[] {
  const keySet = new Set<GiantAxisKey>(GIANT_AXIS_KEYS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reason of gateReasons) {
    for (const token of reason.split(/[\s:]+/)) {
      if (keySet.has(token as GiantAxisKey) && !seen.has(token)) {
        seen.add(token);
        out.push(token);
      }
    }
  }
  return out;
}

/**
 * Build a structured {@link OutcomeMemory} from a terminally-resolved idea. PURE —
 * no I/O, no clock (createdAtSec is supplied via context). Score fields collapse
 * to `null` when absent; `failingAxes` are derived from the gate reasons; the
 * GIANT composite prefers the gate's value and falls back to the candidate's.
 * Omit-undefined: every nullable field is explicitly set to a value or `null`,
 * never left undefined.
 */
export function toOutcomeMemory(
  candidate: OutcomeCandidate,
  verdict: OutcomeVerdict,
  signals: OutcomeSignals,
  context: OutcomeContext,
): OutcomeMemory {
  const gate = signals.gate ?? null;
  const composite =
    gate && Number.isFinite(gate.composite) ? gate.composite : (candidate.giantComposite ?? null);

  const demand = signals.demand ?? null;

  return {
    kind: "idea-outcome",
    verdict: verdict.verdict,
    verdictSource: verdict.verdictSource,
    ideaId: candidate.ideaId,
    segment: candidate.segment ?? null,
    archetype: candidate.archetype ?? null,
    giantComposite: typeof composite === "number" ? composite : null,
    failingAxes: gate ? deriveFailingAxes(gate.gateReasons) : [],
    juryDissent: typeof signals.sigeDissent === "number" ? signals.sigeDissent : null,
    convergenceVeto: signals.convergenceVeto === true,
    demandScore: demand && Number.isFinite(demand.score) ? demand.score : null,
    whitespace: demand && Number.isFinite(demand.whitespace) ? demand.whitespace : null,
    competability: competabilityFromCandidate(candidate),
    runId: context.runId,
    promptVersion: context.promptVersion,
    model: context.model,
    createdAtSec: context.createdAtSec,
  };
}

// ─── renderOutcomeSentence (PURE) ─────────────────────────────────────────────

/** Render a nullable score as a fixed display, "n/a" when null. */
function num(value: number | null, digits = 1): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

/**
 * Render the moat clause for a sentence: the overall "can-win" score, the named
 * high moats (if any), and the matched builder-expertise domain (if any). Returns
 * "" when the memory carries no competability slice, so an un-scored idea's
 * sentence is byte-identical to today. PURE — the matched domain is sanitized
 * (it can be free text) before it enters the sentence.
 */
function moatClause(memory: OutcomeMemory): string {
  const c = memory.competability;
  if (!c) return "";
  const high = highMoats(c);
  const moats = high.length > 0 ? `high moats: ${high.join(", ")}` : "no high moats";
  const domain = c.matchedExpertiseDomain
    ? `; builder-fit domain: ${sanitizeScrapedField(c.matchedExpertiseDomain, 40)}`
    : "";
  return ` Competability can-win ${c.overall.toFixed(1)}/5 (${moats})${domain}.`;
}

/**
 * Render one outcome memory as a single natural-language SENTENCE. The body is
 * presentation only — never parsed for control flow. The title is sanitized
 * (160 chars) so a scraped/LLM-authored title can't smuggle markup into the
 * sentence. Null scores render "n/a". PURE.
 */
export function renderOutcomeSentence(memory: OutcomeMemory, title: string): string {
  // Collapse double-quotes so the title sits cleanly inside the double-quoted
  // sentence below and the natural-language output is always well-formed. Purely
  // cosmetic — the round-trip is still defended by re-sanitize + wrapUntrusted on
  // read.
  const t = sanitizeScrapedField(title, 160).replace(/"/g, "'");
  const s = memory.segment ?? "n/a";
  const a = memory.archetype ?? "n/a";
  const g = num(memory.giantComposite);
  const d = num(memory.demandScore);
  const vs = memory.verdictSource;

  switch (memory.verdict) {
    case "archived": {
      const axes = memory.failingAxes.length > 0 ? memory.failingAxes.join(", ") : "n/a";
      const veto = memory.convergenceVeto ? "; jury convergence-veto fired" : "";
      return (
        `Idea "${t}" (segment: ${s}, archetype: ${a}) was ARCHIVED. ` +
        `GIANT composite ${g}/5 with failing axes: ${axes}; demand ${d}/5${veto}.` +
        `${moatClause(memory)} ` +
        `Verdict source: ${vs}. Avoid regenerating this archetype/segment pattern ` +
        "unless evidence is materially stronger."
      );
    }
    case "validated":
      return (
        `Idea "${t}" (segment: ${s}, archetype: ${a}) was VALIDATED. ` +
        `GIANT composite ${g}/5; demand ${d}/5; grounded.` +
        `${moatClause(memory)} ` +
        `Verdict source: ${vs}. Reinforce the rigor of this archetype/segment pattern.`
      );
    case "stored-pending":
      return (
        `Idea "${t}" (segment: ${s}, archetype: ${a}) was STORED pending validation. ` +
        `GIANT composite ${g}/5; demand ${d}/5. Verdict source: none. (Neutral.)`
      );
    case "dedup-rejected":
      return (
        `Theme "${t}" was REJECTED AS A DUPLICATE of an existing idea. ` +
        "Verdict source: dedup. Avoid regenerating near-duplicate themes."
      );
  }
}

// ─── buildOutcomeMemoryBlock (PURE) ───────────────────────────────────────────

const HEADER = "=== OUTCOME MEMORY (learned from past idea verdicts — guidance, not data) ===";

/** A memory fetched back from mem0 plus its parsed/structured metadata. */
export interface RetrievedOutcome {
  readonly memory: string;
  readonly metadata: OutcomeMemory;
  /** Raw mem0 relevance score for this hit (0 when the server omits it). */
  readonly relevance: number;
}

/**
 * De-dup a list of retrieved outcomes by ideaId (falling back to the body text
 * when ideaId is null — dedup-rejected themes carry no ideaId), then cap. PURE.
 */
function dedupAndCap(items: readonly RetrievedOutcome[], cap: number): readonly RetrievedOutcome[] {
  const seen = new Set<string>();
  const out: RetrievedOutcome[] = [];
  for (const item of items) {
    if (out.length >= cap) break;
    const key = item.metadata.ideaId ?? item.memory;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Render one bullet: each body string is re-sanitized and untrusted-fenced. */
function bullet(memory: string): string {
  return `- ${wrapUntrusted("outcome-memory", sanitizeScrapedField(memory, 240))}`;
}

/**
 * Trust-tiering options for {@link buildOutcomeMemoryBlock} (Phase 2). Absent or
 * `weighting:false` → the block is byte-identical to the pre-Phase-2 behavior.
 */
export interface TrustOptions {
  /** When true, stable-sort ranked items by trust tier and proxy-cap AVOID. */
  readonly weighting: boolean;
  /** Max PROXY-tier AVOID bullets when weighting is on. */
  readonly proxyAvoidCap: number;
}

/**
 * Assemble the OUTCOME MEMORY prompt section from retrieved outcomes. The split
 * between REINFORCE and AVOID is driven SOLELY by structured metadata:
 *   - REINFORCE = verdict "validated", EXCLUDING any verdictSource starting
 *     "proxy:" (proxy auto-validate is rare and would double-count the Postgres
 *     GIANT/credibility calibration that already feeds generation). This admits
 *     "reprobe:grew" (a real deferred re-probe), since it is NOT "proxy:".
 *   - AVOID = verdict "archived" or "dedup-rejected" (proxy archives kept — a
 *     cheap archive is safe to learn from).
 * Each bucket is de-duped and independently capped. An empty bucket renders
 * nothing; when BOTH are empty the whole block is "" so a default run is
 * byte-identical to today. PURE.
 *
 * TRUST WEIGHTING (Phase 2, `trust.weighting`): when ON the ranked REINFORCE/AVOID
 * lists are stable-sorted so GOLD (human) / REPROBE (deferred re-probe) tiers lead
 * PROXY (same-run self-grades) lead NONE BEFORE the final cap, and proxy-tier AVOID
 * bullets are capped at `trust.proxyAvoidCap`. dedup-rejected entries are split OUT
 * of AVOID and rendered as a "crowded title space" novelty HINT (a near-dup existed
 * this run — a novelty signal, not an outcome-quality verdict). When OFF the
 * wording and ordering are unchanged.
 */
export function buildOutcomeMemoryBlock(
  retrieved: readonly RetrievedOutcome[],
  reinforceCap: number,
  avoidCap: number,
  rankOpts?: BlockRankOptions,
  trust?: TrustOptions,
): string {
  const trustOn = trust?.weighting === true && rankOpts !== undefined;

  const reinforceRaw = retrieved.filter(
    (r) => r.metadata.verdict === "validated" && !r.metadata.verdictSource.startsWith("proxy:"),
  );
  // When trust weighting is on, dedup-rejected is NOT an outcome-quality signal —
  // it just means a near-dup title existed this run — so it leaves the AVOID
  // bucket and renders as a novelty hint. When off, the legacy mix is preserved.
  const archivedRaw = retrieved.filter((r) => r.metadata.verdict === "archived");
  const dedupRaw = retrieved.filter((r) => r.metadata.verdict === "dedup-rejected");
  const avoidRaw = trustOn ? archivedRaw : [...archivedRaw, ...dedupRaw];

  // When no ranking opts are passed, fall back to the legacy first-N dedupAndCap
  // path so the emitted block is byte-identical to the pre-ranking behavior.
  // When trust weighting is on, use the trust-tiered selection (rank → MMR →
  // trust-sort → cap), proxy-capping the AVOID bucket only.
  const reinforce = trustOn
    ? selectTrustRankedOutcomes(reinforceRaw, reinforceCap, rankOpts, Number.POSITIVE_INFINITY)
    : rankOpts
      ? selectRankedOutcomes(reinforceRaw, reinforceCap, rankOpts)
      : dedupAndCap(reinforceRaw, reinforceCap);
  const avoid = trustOn
    ? selectTrustRankedOutcomes(avoidRaw, avoidCap, rankOpts, trust?.proxyAvoidCap ?? 0)
    : rankOpts
      ? selectRankedOutcomes(avoidRaw, avoidCap, rankOpts)
      : dedupAndCap(avoidRaw, avoidCap);
  // Novelty hint (trust-on only): dedup-rejected as "crowded title space".
  const novelty = trustOn && rankOpts ? selectRankedOutcomes(dedupRaw, avoidCap, rankOpts) : [];

  // Competability-aware moat learnings: correlate the moat signal on retrieved
  // outcomes with their verdict and distil a bounded directive. PURE, no LLM, no
  // extra fetch — it reads only the structured competability slice on the SAME
  // memories. It MUST receive the FULL UNRANKED retrieved set (not the
  // MMR-trimmed sublists) so the aggregate moat ↔ outcome lesson is unaffected by
  // recall ranking. "" when there is no competability-scored evidence, so
  // absent-data is byte-identical to today. When trust weighting is on, only
  // gold+reprobe archived count toward the AVOID moat line (see directive opts).
  const moatDirective = buildMoatLearningsDirective(
    retrieved,
    trustOn ? { goldReprobeOnly: true } : undefined,
  );

  if (
    reinforce.length === 0 &&
    avoid.length === 0 &&
    novelty.length === 0 &&
    moatDirective === ""
  ) {
    return "";
  }

  const parts: string[] = [HEADER];

  if (reinforce.length > 0) {
    parts.push("REINFORCE — patterns that PASSED validation (lean toward this rigor):");
    for (const r of reinforce) parts.push(bullet(r.memory));
  }
  if (avoid.length > 0) {
    parts.push(
      trustOn
        ? "AVOID — patterns ARCHIVED (do NOT regenerate):"
        : "AVOID — patterns ARCHIVED or rejected as duplicates (do NOT regenerate):",
    );
    for (const a of avoid) parts.push(bullet(a.memory));
  }
  if (novelty.length > 0) {
    parts.push(
      "CROWDED TITLE SPACE — these themes already had near-duplicate titles this run " +
        "(a novelty hint, not an outcome verdict — differentiate or pick a fresher angle):",
    );
    for (const n of novelty) parts.push(bullet(n.memory));
  }
  // Append the learned moat-scoring directive after the per-idea bullets so the
  // model reads the aggregate "moat ↔ outcome" lesson last.
  if (moatDirective !== "") parts.push(moatDirective);

  return parts.join("\n");
}

// ─── writeOutcomeMemories (best-effort I/O) ───────────────────────────────────

/** One outcome memory ready to persist: its rendered sentence + structured metadata. */
export interface OutcomeMemoryItem {
  readonly sentence: string;
  readonly metadata: OutcomeMemory;
}

/**
 * Write a batch of outcome memories to mem0 under the dedicated ideas userId.
 * Best-effort: any failure is logged and swallowed (the caller must continue —
 * write-back runs after persistence/proxy-labels and before markConsumed, in its
 * own try/catch). `enableGraph:false` so untrusted idea text never reaches mem0's
 * graph extractor. The client's circuit breaker handles a down sidecar.
 */
export async function writeOutcomeMemories(
  mem0: Mem0Client,
  items: readonly OutcomeMemoryItem[],
  userId: string,
): Promise<void> {
  if (items.length === 0) return;
  try {
    await mem0.addMemories({
      items: items.map((item) => ({
        content: item.sentence,
        metadata: { ...item.metadata },
      })),
      userId,
      enableGraph: false,
      maxConcurrent: 3,
    });
  } catch (err) {
    log.warn("writeOutcomeMemories failed (continuing)", {
      err,
      userId,
      count: items.length,
    });
  }
}

// ─── writeHumanOutcomeMemory (best-effort I/O) ────────────────────────────────

/**
 * Stage → terminal verdict mapping for HUMAN-driven write-back. A human can only
 * push an idea to one of the terminal buckets we learn from:
 *   - "validated" → verdict "validated" (REINFORCE)
 *   - "archived"  → verdict "archived"  (AVOID)
 * Any other stage (e.g. "idea" — an un-archive / restore) maps to null: there is
 * no terminal verdict, so we RETRACT prior memories and write nothing. PURE.
 */
export function humanStageToVerdict(stage: string): "validated" | "archived" | null {
  if (stage === "validated") return "validated";
  if (stage === "archived") return "archived";
  return null;
}

/**
 * Idempotency primitive: best-effort delete of every prior outcome memory for a
 * given ideaId under the ideas userId. mem0's addMemory has no upsert key, so a
 * human toggling archive → restore → archive would otherwise append contradictory
 * sentences. We getAll → client-side filter by metadata.ideaId (the OSS server's
 * metadata query is version-dependent and unreliable) → deleteMemory each match.
 * Every step is wrapped so a mem0 hiccup never escalates past a log.warn. PURE of
 * any throw — returns the count actually deleted. NEVER trusts the body text;
 * matching is on structured metadata only.
 */
export async function deletePriorOutcomeMemories(
  mem0: Mem0Client,
  userId: string,
  ideaId: string,
): Promise<number> {
  let all: readonly Mem0Memory[];
  try {
    all = await mem0.getAll({ userId, limit: 100 });
  } catch (err) {
    log.warn("deletePriorOutcomeMemories: getAll failed (continuing)", { err, userId });
    return 0;
  }

  const stale = all.filter((m) => {
    const parsed = outcomeMemorySchema.safeParse(m.metadata);
    return parsed.success && parsed.data.kind === "idea-outcome" && parsed.data.ideaId === ideaId;
  });

  let deleted = 0;
  for (const m of stale) {
    try {
      await mem0.deleteMemory(m.id);
      deleted += 1;
    } catch (err) {
      log.warn("deletePriorOutcomeMemories: deleteMemory failed (continuing)", {
        err,
        memoryId: m.id,
      });
    }
  }
  return deleted;
}

/**
 * Inputs for a single human-verdict write-back. Extends
 * {@link CandidateCompetabilityFields} so the caller can hand over the idea's
 * persisted competability scorecard (read off the generated_ideas row) and the
 * memory carries the same moat slice as a run-time write-back. All competability
 * fields are optional; absent ⇒ the human memory carries no moat slice (as before).
 */
export interface HumanOutcomeInput extends CandidateCompetabilityFields {
  readonly ideaId: string;
  readonly title: string;
  readonly stage: string;
  readonly segment?: string | null;
  readonly archetype?: Archetype | null;
  readonly giantComposite?: number | null;
  readonly runId: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly createdAtSec: number;
}

/**
 * Write back a POST-RUN HUMAN verdict (validate / archive) as an outcome memory,
 * replacing any prior memory for the same ideaId so the LATEST human decision is
 * authoritative. This closes the loop the proxy/run-time path opens: these are
 * the real-world outcomes, stamped verdictSource:"human".
 *
 * Idempotency: always delete-prior-by-ideaId FIRST. A restore / un-archive
 * (stage that maps to no terminal verdict) therefore RETRACTS the prior archived
 * memory and writes nothing — the idea returns to a neutral, un-learned state.
 *
 * Security: the title is scraped/LLM text. It is routed through
 * renderOutcomeSentence (which sanitizeScrapedField's it) and written with
 * enableGraph:false — untrusted idea text never reaches mem0's graph extractor.
 *
 * Best-effort: every mem0 interaction is wrapped; a failure here must NEVER break
 * the caller (the HTTP stage-update response). Returns silently.
 */
export async function writeHumanOutcomeMemory(
  mem0: Mem0Client,
  input: HumanOutcomeInput,
  userId: string,
): Promise<void> {
  try {
    // Idempotency: the latest human verdict supersedes older ones. Run FIRST so a
    // restore (verdict === null) leaves the idea with no outcome memory at all.
    await deletePriorOutcomeMemories(mem0, userId, input.ideaId);

    const verdict = humanStageToVerdict(input.stage);
    if (verdict === null) {
      log.info("Human outcome-memory: restore/neutral — prior retracted, nothing written", {
        ideaId: input.ideaId,
        stage: input.stage,
        userId,
      });
      return;
    }

    const memory = toOutcomeMemory(
      {
        ideaId: input.ideaId,
        segment: input.segment ?? null,
        archetype: input.archetype ?? null,
        giantComposite: input.giantComposite ?? null,
        // Carry the persisted competability scorecard so the human memory's moat
        // slice matches a run-time write-back. Spread the loose fields directly;
        // competabilityFromCandidate folds them (or yields null when absent).
        competability: input.competability,
        competabilityOverall: input.competabilityOverall,
        competabilityGated: input.competabilityGated,
        competabilityReason: input.competabilityReason,
        competabilityRaw: input.competabilityRaw,
        competabilityRawOverall: input.competabilityRawOverall,
        competabilityMatchedExpertiseDomain: input.competabilityMatchedExpertiseDomain,
      },
      { verdict, verdictSource: "human" },
      { gate: null, sigeDissent: null, convergenceVeto: null, demand: null },
      {
        runId: input.runId,
        promptVersion: input.promptVersion,
        model: input.model,
        createdAtSec: input.createdAtSec,
      },
    );

    await writeOutcomeMemories(
      mem0,
      [{ sentence: renderOutcomeSentence(memory, input.title), metadata: memory }],
      userId,
    );

    log.info("Human outcome-memory write-back complete", {
      ideaId: input.ideaId,
      verdict,
      userId,
    });
  } catch (err) {
    log.warn("writeHumanOutcomeMemory failed — skipping (non-fatal)", {
      err,
      ideaId: input.ideaId,
    });
  }
}

// ─── fetchOutcomeMemoryBlock (best-effort I/O) ────────────────────────────────

const FETCH_VERDICTS = ["validated", "archived", "dedup-rejected"] as const;

/** Parse a raw mem0 memory into a RetrievedOutcome, or null if its metadata
 *  is not a well-formed idea-outcome of the expected verdict bucket. PURE. */
function toRetrieved(
  raw: Mem0Memory,
  bucket: (typeof FETCH_VERDICTS)[number],
): RetrievedOutcome | null {
  const parsed = outcomeMemorySchema.safeParse(raw.metadata);
  if (!parsed.success) return null;
  const metadata = parsed.data;
  // Client-side post-filter net: the OSS server's metadata filter is version-
  // dependent and may be silently ignored, so re-assert kind + verdict here.
  if (metadata.kind !== "idea-outcome" || metadata.verdict !== bucket) return null;
  return { memory: raw.memory, metadata, relevance: raw.score ?? 0 };
}

/**
 * Fetch outcome memories for the next synthesis round and render the prompt
 * block. Runs THREE scoped searches in parallel (one per verdict bucket), each
 * with its own `.catch(() => [])` so a single bucket failing degrades to empty
 * rather than throwing. If anything outside those catches throws, returns "".
 *
 * `enableGraph:false` on read — we never feed untrusted idea text into the graph
 * extractor. The server-side `filters` is best-effort; {@link toRetrieved}
 * applies the authoritative client-side post-filter.
 */
export async function fetchOutcomeMemoryBlock(params: {
  readonly mem0: Mem0Client;
  readonly userId: string;
  readonly query: string;
  readonly reinforceCap: number;
  readonly avoidCap: number;
  readonly searchLimit: number;
  /** See {@link fetchOutcomeMemoryGuidance}. Omitted → legacy first-N selection. */
  readonly rank?: BlockRankOptions;
  /** Trust-tiered recall (Phase 2). Omitted / weighting:false → unchanged. */
  readonly trust?: TrustOptions;
}): Promise<string> {
  // Thin wrapper so seeded + autonomous share ONE ranking codepath: it delegates
  // to fetchOutcomeMemoryGuidance and returns only the REINFORCE/AVOID block.
  const guidance = await fetchOutcomeMemoryGuidance(params);
  return guidance.block;
}

/**
 * Shared best-effort fetch: run the three scoped, per-verdict searches in
 * parallel and return the parsed, post-filtered outcomes (un-rendered). Each
 * bucket has its own `.catch(() => [])`; any outer throw degrades to []. Never
 * throws. Both {@link fetchOutcomeMemoryBlock} and
 * {@link fetchOutcomeMemoryGuidance} build on this so the REINFORCE/AVOID block
 * and the SEED segment-diversity directive come from ONE round-trip.
 *
 * `enableGraph:false` on read — we never feed untrusted idea text into the graph
 * extractor. The server-side `filters` is best-effort; {@link toRetrieved}
 * applies the authoritative client-side post-filter.
 */
async function fetchRetrievedOutcomes(params: {
  readonly mem0: Mem0Client;
  readonly userId: string;
  readonly query: string;
  readonly searchLimit: number;
}): Promise<readonly RetrievedOutcome[]> {
  const { mem0, userId, query, searchLimit } = params;
  try {
    const buckets = await Promise.all(
      FETCH_VERDICTS.map((verdict) =>
        mem0
          .search({
            query,
            userId,
            limit: searchLimit,
            enableGraph: false,
            filters: { kind: "idea-outcome", verdict },
          })
          .then((res) =>
            res.memories
              .map((raw) => toRetrieved(raw, verdict))
              .filter((r): r is RetrievedOutcome => r !== null),
          )
          .catch(() => [] as readonly RetrievedOutcome[]),
      ),
    );
    return buckets.flat();
  } catch (err) {
    log.warn("fetchRetrievedOutcomes failed (returning empty)", { err, userId });
    return [];
  }
}

/** Outcome-memory guidance for one synthesis round, from a single fetch. */
export interface OutcomeMemoryGuidance {
  /** REINFORCE/AVOID block injected at Pass 2 (built by buildOutcomeMemoryBlock). */
  readonly block: string;
  /** SEED segment-diversity directive injected at Pass 1 (buildSegmentDiversityDirective). */
  readonly segmentDirective: string;
}

/**
 * Fetch outcome memories ONCE and derive BOTH the Pass-2 REINFORCE/AVOID block
 * and the Pass-1 SEED segment-diversity directive. Best-effort: any failure
 * degrades both fields to "" (never throws). When there are no usable memories
 * both fields are "" so a default run is byte-identical and no extra mem0 call
 * is made beyond the existing read.
 *
 * `rotationSeed` (derived from the run id upstream) rotates which under-explored
 * segments lead the directive so consecutive runs explore different corners.
 */
export async function fetchOutcomeMemoryGuidance(params: {
  readonly mem0: Mem0Client;
  readonly userId: string;
  readonly query: string;
  readonly reinforceCap: number;
  readonly avoidCap: number;
  readonly searchLimit: number;
  readonly rotationSeed?: number;
  /**
   * Relevance/recency ranking knobs. When omitted the block falls back to the
   * legacy first-N selection (byte-identical to the pre-ranking behavior).
   */
  readonly rank?: BlockRankOptions;
  /**
   * Trust-tiered recall (Phase 2). Omitted / weighting:false → the block is
   * byte-identical to the pre-Phase-2 behavior.
   */
  readonly trust?: TrustOptions;
}): Promise<OutcomeMemoryGuidance> {
  const { reinforceCap, avoidCap, rotationSeed = 0, rank, trust } = params;
  const retrieved = await fetchRetrievedOutcomes(params);
  return {
    block: buildOutcomeMemoryBlock(retrieved, reinforceCap, avoidCap, rank, trust),
    segmentDirective: buildSegmentDiversityDirective(retrieved, rotationSeed),
  };
}
