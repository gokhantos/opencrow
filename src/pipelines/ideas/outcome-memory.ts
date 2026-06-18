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
  const t = sanitizeScrapedField(title, 160);
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
  const { mem0, userId, query, reinforceCap, avoidCap, searchLimit } = params;
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

    const retrieved = buckets.flat();
    return buildOutcomeMemoryBlock(retrieved, reinforceCap, avoidCap);
  } catch (err) {
    log.warn("fetchOutcomeMemoryBlock failed (returning empty)", { err, userId });
    return "";
  }
}
