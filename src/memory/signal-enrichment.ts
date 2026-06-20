import { createLogger } from "../logger";
import { loadConfig } from "../config/loader";
import type { MemorySourceKind } from "./types";
import { MEMORY_SOURCE_KINDS } from "./types";
import {
  extractSignalFacetsBatch,
  persistSignalFacets,
  shouldRankSignal,
  type SignalBatchItem,
  type SignalFacets,
  type SignalImportance,
  type SignalRankSignals,
  type SignalRankThresholds,
} from "./signal-facets";

const log = createLogger("signal-enrichment");

/** Default model used to rank/categorize signals. Cheap on purpose. */
const DEFAULT_RANK_MODEL = "claude-haiku-4-5";

/**
 * MemorySourceKinds that are NOT scraped market signals. Conversations,
 * notes/documents the user authored, internal observations, and generated
 * ideas must NEVER be categorized/ranked — ranking is anchored to scraped
 * signal usefulness for idea generation, and these kinds would pollute the
 * calibration loop.
 */
const NON_SIGNAL_KINDS: ReadonlySet<MemorySourceKind> = new Set<MemorySourceKind>(
  ["conversation", "note", "document", "observation", "idea"],
);

/** Scraped-signal MemorySourceKinds eligible for categorization + ranking. */
export const SIGNAL_SOURCE_KINDS: readonly MemorySourceKind[] =
  MEMORY_SOURCE_KINDS.filter((kind) => !NON_SIGNAL_KINDS.has(kind));

const SIGNAL_SOURCE_KIND_SET: ReadonlySet<MemorySourceKind> = new Set(
  SIGNAL_SOURCE_KINDS,
);

/**
 * Pure predicate: is this a scraped-signal kind (vs conversation/observation/
 * idea/note/document)? Only signal kinds are categorized/ranked.
 */
export function isSignalKind(kind: MemorySourceKind): boolean {
  return SIGNAL_SOURCE_KIND_SET.has(kind);
}

/** Importance buckets in ascending order: noise < low < medium < high. */
export const IMPORTANCE_ORDER: readonly SignalImportance[] = [
  "noise",
  "low",
  "medium",
  "high",
];

/**
 * Map an importance bucket to its ordinal rank (noise=0 … high=3). Pure.
 * Used both for the Qdrant numeric payload (range-filterable) and for the
 * retrieval importance-floor comparison.
 */
export function importanceRank(importance: SignalImportance): number {
  const idx = IMPORTANCE_ORDER.indexOf(importance);
  // Unknown values default to the "low" rank so they survive the default floor.
  return idx >= 0 ? idx : IMPORTANCE_ORDER.indexOf("low");
}

/**
 * Does `importance` meet or exceed `floor`? Pure. Buckets are ordered
 * noise < low < medium < high. With the default floor "low", noise is filtered
 * out but everything low+ passes.
 */
export function meetsImportanceFloor(
  importance: SignalImportance,
  floor: SignalImportance,
): boolean {
  return importanceRank(importance) >= importanceRank(floor);
}

/**
 * Flatten the ranking layer of a facet profile into Qdrant-payload-safe scalar
 * fields. Pure. Returns an empty object when `facets` is null. These keys are
 * the FILTERABLE retrieval fields:
 *   - signalImportance      (keyword)  — bucket string noise|low|medium|high
 *   - signalImportanceRank  (integer)  — ordinal 0..3 for range floor filtering
 *   - signalRelevance       (float)    — relevanceToIdeas in [0,1]
 *   - signalCategory        (keyword)  — coarse category, omitted when empty
 */
export function buildRankingPayload(
  facets: SignalFacets | null,
): Record<string, string | number> {
  if (!facets) {
    return {};
  }
  const payload: Record<string, string | number> = {
    signalImportance: facets.importance,
    signalImportanceRank: importanceRank(facets.importance),
    signalRelevance: facets.relevanceToIdeas,
  };
  if (facets.category) {
    payload.signalCategory = facets.category;
  }
  return payload;
}

/** A scraped signal to enrich: a source row plus the text + optional metrics. */
export interface EnrichSignalItem {
  /** Stable id — typically the memory source id; keys the result map. */
  readonly id: string;
  /** The source kind (must be a signal kind to be ranked). */
  readonly kind: MemorySourceKind;
  /** Combined signal text to categorize/rank. */
  readonly text: string;
  /** Optional engagement/velocity metrics for the pre-filter. */
  readonly signals?: SignalRankSignals;
}

export interface EnrichSignalsOptions {
  /** Override the ranking model (defaults to Haiku). */
  readonly model?: string;
  /** Max signals per LLM call. */
  readonly batchSize?: number;
  /** Max characters of each signal fed to the model. */
  readonly maxChars?: number;
  /** Pre-filter thresholds (default permissive). */
  readonly thresholds?: SignalRankThresholds;
  /**
   * Inject config gates for testing. When omitted, gates are read from
   * `loadConfig().pipelines.ideas.smart`. Tests pass these to avoid I/O.
   */
  readonly gates?: EnrichmentGates;
  /** Inject the batch extractor (for tests). Defaults to the real Haiku call. */
  readonly extractBatch?: typeof extractSignalFacetsBatch;
  /** Inject persistence (for tests). Defaults to the real DB write. */
  readonly persist?: typeof persistSignalFacets;
}

/** Resolved enrichment gates (extraction vs ranking). */
export interface EnrichmentGates {
  /** `pipelines.ideas.smart.signalFacets` — gates extraction/categorization. */
  readonly signalFacets: boolean;
  /** `pipelines.ideas.smart.signalRanking` — gates importance/relevance scoring. */
  readonly signalRanking: boolean;
}

export interface EnrichSignalsResult {
  /**
   * Per-id Qdrant payload patch to MERGE onto that source's points. Only
   * contains ranking keys when `signalRanking` is on; empty map entries are
   * omitted. Callers apply these via `qdrantClient.setPayload(...)`.
   */
  readonly payloads: Map<string, Record<string, string | number>>;
  /** Per-id extracted facets (null on failure / skipped). */
  readonly facets: Map<string, SignalFacets | null>;
}

/** Read the extraction/ranking gates from config; default OFF on any failure. */
function resolveGates(): EnrichmentGates {
  try {
    const smart = loadConfig().pipelines.ideas.smart;
    return {
      signalFacets: smart.signalFacets,
      signalRanking: smart.signalRanking,
    };
  } catch {
    return { signalFacets: false, signalRanking: false };
  }
}

/**
 * BATCHED, KIND-SCOPED, GRACEFUL enrichment for scraped signals.
 *
 * Pipeline per call:
 *  1. Drop non-signal kinds (conversations/observations/ideas/notes/documents).
 *  2. Gate on `signalFacets` — when off, no LLM calls and an empty result.
 *  3. Apply the {@link shouldRankSignal} pre-filter (engagement/velocity floor).
 *  4. Batch the survivors through ONE Haiku call per chunk.
 *  5. Persist facets (incl. ranking columns) per item — best-effort.
 *  6. Build per-id Qdrant ranking payloads, GATED on `signalRanking` so the
 *     filterable importance/relevance/category fields only appear when ranking
 *     is enabled (extraction can run without exposing rank fields).
 *
 * Never throws: any failure degrades to null facets / empty payloads so the
 * ingest path is never blocked. Returns a complete map keyed by input id.
 */
export async function enrichSignals(
  items: readonly EnrichSignalItem[],
  opts: EnrichSignalsOptions = {},
): Promise<EnrichSignalsResult> {
  const payloads = new Map<string, Record<string, string | number>>();
  const facets = new Map<string, SignalFacets | null>();

  // Seed every input id so callers always get a complete map.
  for (const item of items) {
    facets.set(item.id, null);
    payloads.set(item.id, {});
  }

  const gates = opts.gates ?? resolveGates();
  if (!gates.signalFacets) {
    return { payloads, facets };
  }

  const model = opts.model ?? DEFAULT_RANK_MODEL;
  const extractBatch = opts.extractBatch ?? extractSignalFacetsBatch;
  const persist = opts.persist ?? persistSignalFacets;

  // Kind-scope + pre-filter + non-empty text.
  const rankable: EnrichSignalItem[] = items.filter(
    (item) =>
      isSignalKind(item.kind) &&
      item.text.trim().length > 0 &&
      shouldRankSignal(item.signals, opts.thresholds),
  );

  if (rankable.length === 0) {
    return { payloads, facets };
  }

  const batchItems: SignalBatchItem[] = rankable.map((item) => ({
    id: item.id,
    text: item.text,
  }));

  let extracted: Map<string, SignalFacets | null>;
  try {
    extracted = await extractBatch(batchItems, {
      model,
      batchSize: opts.batchSize,
      maxChars: opts.maxChars,
    });
  } catch (error) {
    log.error("Signal enrichment batch failed (non-fatal)", {
      error,
      count: rankable.length,
    });
    return { payloads, facets };
  }

  const kindById = new Map(rankable.map((item) => [item.id, item.kind]));

  for (const [id, profile] of extracted) {
    facets.set(id, profile);
    if (!profile) {
      continue;
    }

    const kind = kindById.get(id);
    try {
      await persist({
        sourceTable: kind ?? "unknown",
        sourceId: id,
        facets: profile,
        signalType: kind,
        rankModel: gates.signalRanking ? model : undefined,
      });
    } catch (error) {
      log.error("Signal facet persist failed (non-fatal)", { id, error });
    }

    // Ranking payload only when the ranking flag is on. Extraction can run
    // without surfacing importance/relevance as a filterable retrieval field.
    if (gates.signalRanking) {
      payloads.set(id, buildRankingPayload(profile));
    }
  }

  log.debug("Enriched signals", {
    requested: items.length,
    ranked: rankable.length,
    withFacets: [...facets.values()].filter(Boolean).length,
    ranking: gates.signalRanking,
  });

  return { payloads, facets };
}

