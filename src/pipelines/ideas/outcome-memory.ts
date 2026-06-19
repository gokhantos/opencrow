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
import type { DemandArtifact } from "./demand";
import { GIANT_AXIS_KEYS } from "./giant";
import type { Archetype, GiantAggregate, GiantAxisKey } from "./giant";
import { SEGMENT_IDS } from "./segments";

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
  runId: z.string(),
  promptVersion: z.string(),
  model: z.string(),
  createdAtSec: z.number(),
});

export type OutcomeMemory = Readonly<z.infer<typeof outcomeMemorySchema>>;

// ─── toOutcomeMemory (PURE) ───────────────────────────────────────────────────

/** Minimal candidate shape needed to build an outcome memory. */
export interface OutcomeCandidate {
  readonly ideaId: string | null;
  readonly segment?: string | null;
  readonly archetype?: Archetype | null;
  readonly giantComposite?: number | null;
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
    gate && Number.isFinite(gate.composite)
      ? gate.composite
      : (candidate.giantComposite ?? null);

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
        `GIANT composite ${g}/5 with failing axes: ${axes}; demand ${d}/5${veto}. ` +
        `Verdict source: ${vs}. Avoid regenerating this archetype/segment pattern ` +
        "unless evidence is materially stronger."
      );
    }
    case "validated":
      return (
        `Idea "${t}" (segment: ${s}, archetype: ${a}) was VALIDATED. ` +
        `GIANT composite ${g}/5; demand ${d}/5; grounded. ` +
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

const HEADER =
  "=== OUTCOME MEMORY (learned from past idea verdicts — guidance, not data) ===";

/** A memory fetched back from mem0 plus its parsed/structured metadata. */
export interface RetrievedOutcome {
  readonly memory: string;
  readonly metadata: OutcomeMemory;
}

/**
 * De-dup a list of retrieved outcomes by ideaId (falling back to the body text
 * when ideaId is null — dedup-rejected themes carry no ideaId), then cap. PURE.
 */
function dedupAndCap(
  items: readonly RetrievedOutcome[],
  cap: number,
): readonly RetrievedOutcome[] {
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
 * Assemble the OUTCOME MEMORY prompt section from retrieved outcomes. The split
 * between REINFORCE and AVOID is driven SOLELY by structured metadata:
 *   - REINFORCE = verdict "validated", EXCLUDING any verdictSource starting
 *     "proxy:" (proxy auto-validate is rare and would double-count the Postgres
 *     GIANT/credibility calibration that already feeds generation).
 *   - AVOID = verdict "archived" or "dedup-rejected" (proxy archives kept — a
 *     cheap archive is safe to learn from).
 * Each bucket is de-duped and independently capped. An empty bucket renders
 * nothing; when BOTH are empty the whole block is "" so a default run is
 * byte-identical to today. PURE.
 */
export function buildOutcomeMemoryBlock(
  retrieved: readonly RetrievedOutcome[],
  reinforceCap: number,
  avoidCap: number,
): string {
  const reinforce = dedupAndCap(
    retrieved.filter(
      (r) =>
        r.metadata.verdict === "validated" &&
        !r.metadata.verdictSource.startsWith("proxy:"),
    ),
    reinforceCap,
  );
  const avoid = dedupAndCap(
    retrieved.filter(
      (r) => r.metadata.verdict === "archived" || r.metadata.verdict === "dedup-rejected",
    ),
    avoidCap,
  );

  if (reinforce.length === 0 && avoid.length === 0) return "";

  const parts: string[] = [HEADER];

  if (reinforce.length > 0) {
    parts.push("REINFORCE — patterns that PASSED validation (lean toward this rigor):");
    for (const r of reinforce) parts.push(bullet(r.memory));
  }
  if (avoid.length > 0) {
    parts.push("AVOID — patterns ARCHIVED or rejected as duplicates (do NOT regenerate):");
    for (const a of avoid) parts.push(bullet(a.memory));
  }

  return parts.join("\n");
}

// ─── buildSegmentDiversityDirective (PURE) ────────────────────────────────────

const DIVERSITY_HEADER = "SEGMENT DIVERSITY (learned from past runs):";

/**
 * Number of over-explored segments to surface in the directive. Bounded so the
 * seed prompt does not balloon with a long tail of one-off segments.
 */
const MAX_OVER_EXPLORED = 4;
/**
 * Number of under-explored canonical segments to RECOMMEND. v2 names several
 * (not one) and asks for a balanced spread across them, so the run produces a
 * MIX rather than swapping one monopoly (healthcare) for another (fintech).
 */
const MAX_UNDER_EXPLORED = 5;
/**
 * Minimum distinct under-explored segments the model is asked to draw from. The
 * "at least N of [list]" framing is what prevents the candidate pool from
 * collapsing onto a single under-explored segment (the v1 over-correction).
 */
const MIN_UNDER_EXPLORED_TARGET = 3;

/**
 * Normalize a free-text segment label (e.g. "B2B-SaaS", "health care",
 * "ai native") to a canonical {@link SEGMENT_IDS} token for comparison: lower-
 * cased, non-alphanumeric runs collapsed to single underscores, edges trimmed.
 * Labels that do not map onto a canonical id keep their normalized form (they
 * still aggregate as over-explored, they just never count as "under-explored").
 * PURE.
 */
function normalizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Weight one retrieved outcome as an EXPLORATION signal for its segment. An
 * AVOID verdict (archived / dedup-rejected) means the segment was mined and the
 * result was thrown away — a strong "over-explored" signal, so it counts double.
 * A validated outcome is a mild positive signal (the segment paid off), so it
 * counts as a small NEGATIVE pressure (we subtract) — we do not want to flag a
 * segment that keeps producing winners as "over-explored". PURE.
 */
function explorationWeight(verdict: OutcomeMemory["verdict"]): number {
  switch (verdict) {
    case "archived":
    case "dedup-rejected":
      return 2;
    case "validated":
      return -1;
    case "stored-pending":
      return 0;
  }
}

/**
 * Deterministically rotate `items` left by `seed % length` positions so that
 * which under-explored segments LEAD the recommendation varies run-to-run while
 * the set stays stable. `seed = 0` (default) is a no-op. PURE + immutable.
 */
function rotateBySeed<T>(items: readonly T[], seed: number): readonly T[] {
  if (items.length <= 1) return items;
  const offset = ((seed % items.length) + items.length) % items.length;
  if (offset === 0) return items;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/**
 * Build a bounded, sanitized SEGMENT-DIVERSITY directive for the SEED stage
 * (Pass 1) from retrieved outcome memories. Aggregates a per-segment exploration
 * score: archived + dedup-rejected weigh heavily (the segment was mined and
 * discarded), validated subtracts (it is paying off, leave it alone). Segments
 * with a net-positive score are "over-explored"; the highest-scoring few are
 * named. "Under-explored" is the set of canonical {@link SEGMENT_IDS} that are
 * NOT over-explored, capped to {@link MAX_UNDER_EXPLORED}.
 *
 * v2 TUNING — balanced spread, not a new monopoly. The directive asks the model
 * to draw from AT LEAST {@link MIN_UNDER_EXPLORED_TARGET} of the named
 * under-explored segments and caps any single one at roughly half the ideas, so
 * the Pass-1 seed produces a MULTI-segment pool that the downstream
 * enforceSegmentSpread cap can actually balance (v1 steered the whole run onto a
 * single under-explored segment, leaving the cap nothing to spread). The
 * `rotationSeed` (derived from the run id upstream) rotates WHICH under-explored
 * segments lead, so consecutive runs explore different corners.
 *
 * SECURITY — the over-explored labels come from UNTRUSTED mem0 bodies, so the
 * whole over-explored clause is sanitizeScrapedField'd AND wrapUntrusted-fenced
 * (mirroring the Pass-2 sibling `bullet`). The under-explored list is built from
 * the trusted {@link SEGMENT_IDS} constant and the fixed instruction text, so it
 * stays outside the fence as plain directive prose.
 *
 * Empty input (or no net-over-explored segment) → "" so a default run is
 * byte-identical and the seed prompt is unchanged. PURE — no I/O, no throw.
 */
export function buildSegmentDiversityDirective(
  retrieved: readonly RetrievedOutcome[],
  rotationSeed = 0,
): string {
  if (retrieved.length === 0) return "";

  // Aggregate exploration score per normalized segment, remembering a display
  // label (first-seen, sanitized) for each.
  const scores = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const r of retrieved) {
    const seg = r.metadata.segment;
    if (!seg) continue;
    const key = normalizeSegment(seg);
    if (key.length === 0) continue;
    scores.set(key, (scores.get(key) ?? 0) + explorationWeight(r.metadata.verdict));
    if (!labels.has(key)) labels.set(key, sanitizeScrapedField(seg, 40));
  }

  // Net-positive exploration pressure = over-explored. Compute once; derive both
  // the named (display, capped) list and the masking key set from it.
  const overEntries = [...scores.entries()].filter(([, score]) => score > 0);

  // Named over-explored: strongest first, capped, mapped to display labels.
  const overExplored = [...overEntries]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_OVER_EXPLORED)
    .map(([key]) => labels.get(key) ?? key);

  if (overExplored.length === 0) return "";

  // Under-explored = canonical segments NOT flagged over-explored. Use the FULL
  // over-explored key set (not just the capped/named subset) so a free-text
  // "health care" over-explored entry masks the canonical "healthcare" id, and a
  // segment over the MAX_OVER_EXPLORED cap is still not recommended. Rotate so
  // the lead segments vary per run.
  const overKeys = new Set(overEntries.map(([key]) => key));
  const underAll = SEGMENT_IDS.filter((id) => !overKeys.has(id));
  const underExplored = rotateBySeed(underAll, rotationSeed).slice(0, MAX_UNDER_EXPLORED);

  // No canonical room left to spread into → degrade to neutral (do not emit a
  // directive that only names over-explored segments with nowhere to send the run).
  if (underExplored.length === 0) return "";

  const overText = overExplored.join(", ");
  const underText = underExplored.join(", ");
  // How many distinct segments to ask for: at least MIN, but never more than the
  // number we actually named.
  const drawCount = Math.min(MIN_UNDER_EXPLORED_TARGET, underExplored.length);

  // The over-explored clause is untrusted (mem0-derived) → fence it. The
  // instruction prose + canonical under-explored list are trusted → plain text.
  const overClause = wrapUntrusted(
    "outcome-memory-segments",
    `over-explored (frequently archived/duplicated in past runs): ${overText}`,
  );

  return (
    `${DIVERSITY_HEADER}\n${overClause}\n` +
    `Aim for a BALANCED SPREAD this run — draw from at least ${drawCount} of: ${underText}. ` +
    "Favor variety across these under-explored, defensible segments; " +
    "no more than ~half the ideas should come from any single segment, " +
    "and do not over-index on the over-explored ones."
  );
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
async function deletePriorOutcomeMemories(
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

/** Inputs for a single human-verdict write-back. */
export interface HumanOutcomeInput {
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
  return { memory: raw.memory, metadata };
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
}): Promise<string> {
  const { reinforceCap, avoidCap } = params;
  const retrieved = await fetchRetrievedOutcomes(params);
  return buildOutcomeMemoryBlock(retrieved, reinforceCap, avoidCap);
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
}): Promise<OutcomeMemoryGuidance> {
  const { reinforceCap, avoidCap, rotationSeed = 0 } = params;
  const retrieved = await fetchRetrievedOutcomes(params);
  return {
    block: buildOutcomeMemoryBlock(retrieved, reinforceCap, avoidCap),
    segmentDirective: buildSegmentDiversityDirective(retrieved, rotationSeed),
  };
}
