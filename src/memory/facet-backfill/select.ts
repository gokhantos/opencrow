/**
 * Pure selection + transform logic for the facet backfill.
 *
 * Kept free of I/O so it can be unit-tested without Qdrant or Postgres: it
 * decides which scrolled points still need facet enrichment, groups them by
 * their source so the LLM extraction batches over whole sources (not per
 * chunk), and merges the freshly-extracted facet/ranking payload the same way
 * the live indexer's `enrichAndPatch` does.
 */

import { facetsToPayload } from "../indexer";
import { isSignalKind } from "../signal-enrichment";
import type { SignalFacets } from "../signal-facets";
import type { MemorySourceKind } from "../types";
import type { QdrantScrollPoint } from "../qdrant";

/**
 * Payload keys whose absence marks a point as un-enriched. A point is selected
 * for backfill when it is a signal kind and is missing ANY of these. They are
 * the lowest-coverage enrichment fields and are written by every successful
 * extraction, so their absence is a reliable "never enriched" signal.
 */
export const REQUIRED_FACET_KEYS = [
  "facetProblemType",
  "signalCategory",
] as const;

/** A scrolled point projected to just what selection/grouping needs. */
export interface CandidatePoint {
  readonly id: string;
  readonly sourceId: string;
  readonly chunkIndex: number;
  readonly kind: MemorySourceKind;
}

/** All Qdrant point ids belonging to one memory source, with its kind. */
export interface SourceGroup {
  readonly sourceId: string;
  readonly kind: MemorySourceKind;
  readonly pointIds: readonly string[];
}

/** True when a payload value is present and non-empty. */
function hasValue(value: string | number | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

/**
 * Whether a scrolled point still needs facet enrichment. Skips points that are
 * not a signal kind (they are never enriched by the live path) and points that
 * already carry every required facet key (idempotency — re-running the backfill
 * does not re-touch already-enriched points).
 */
export function needsBackfill(
  payload: Readonly<Record<string, string | number>>,
  requiredKeys: readonly string[] = REQUIRED_FACET_KEYS,
): boolean {
  const kind = payload.kind;
  if (typeof kind !== "string" || !isSignalKind(kind as MemorySourceKind)) {
    return false;
  }
  return requiredKeys.some((key) => !hasValue(payload[key]));
}

/**
 * Project a scrolled point to a {@link CandidatePoint} when it needs backfill,
 * else `null`. Drops points whose payload lacks the `sourceId` / `kind` keys
 * the backfill relies on to fetch source text and re-enrich.
 */
export function toCandidate(
  point: QdrantScrollPoint,
  requiredKeys: readonly string[] = REQUIRED_FACET_KEYS,
): CandidatePoint | null {
  const { payload } = point;
  if (!needsBackfill(payload, requiredKeys)) return null;

  const sourceId = payload.sourceId;
  const kind = payload.kind;
  if (typeof sourceId !== "string" || sourceId.length === 0) return null;
  if (typeof kind !== "string") return null;

  const rawChunkIndex = payload.chunkIndex;
  const chunkIndex =
    typeof rawChunkIndex === "number" && Number.isFinite(rawChunkIndex)
      ? rawChunkIndex
      : 0;

  return {
    id: point.id,
    sourceId,
    chunkIndex,
    kind: kind as MemorySourceKind,
  };
}

/**
 * Group candidate points by their source so enrichment runs once per source
 * (over all of that source's chunks) and the resulting payload patch is applied
 * to every one of the source's points. Insertion order is preserved so the
 * caller can deterministically slice the first N groups for a `--limit`.
 */
export function groupBySource(
  candidates: readonly CandidatePoint[],
): readonly SourceGroup[] {
  const order: string[] = [];
  const byId = new Map<string, { kind: MemorySourceKind; pointIds: string[] }>();

  for (const c of candidates) {
    const existing = byId.get(c.sourceId);
    if (existing) {
      existing.pointIds.push(c.id);
    } else {
      order.push(c.sourceId);
      byId.set(c.sourceId, { kind: c.kind, pointIds: [c.id] });
    }
  }

  return order.map((sourceId) => {
    const entry = byId.get(sourceId);
    if (!entry) {
      // Unreachable: every id in `order` was inserted into `byId`.
      throw new Error(`group ${sourceId} missing after build`);
    }
    return { sourceId, kind: entry.kind, pointIds: entry.pointIds };
  });
}

/**
 * Merge extracted facets and ranking payload into the patch applied via
 * `setPayload`, mirroring the live `enrichAndPatch` precedence (ranking payload
 * keys win over facet keys on any overlap). Returns an empty object when there
 * is nothing to write, so callers can skip the patch.
 */
export function buildPayloadPatch(
  facets: SignalFacets | null,
  rankingPayload: Readonly<Record<string, string | number>>,
): Readonly<Record<string, string | number>> {
  return {
    ...facetsToPayload(facets),
    ...rankingPayload,
  };
}
