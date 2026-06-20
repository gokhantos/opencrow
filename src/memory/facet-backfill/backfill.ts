/**
 * Facet backfill orchestration.
 *
 * Re-runs signal-facet extraction over `opencrow_memory` points that predate
 * facet enrichment (or whose extraction failed) and patches the freshly-built
 * facet + ranking payload back onto those points — reusing the SAME extraction
 * (`enrichSignals`), payload shaping (`facetsToPayload` + ranking payload), and
 * `setPayload` write path the live indexer uses, so a backfilled point is
 * indistinguishable from one enriched at index time.
 *
 * The scan is resumable (Qdrant cursor) and idempotent (already-enriched points
 * are skipped by {@link needsBackfill}); a dry run measures the backlog without
 * calling the LLM or writing anything.
 */

import type { SQL } from "bun";
import { createLogger } from "../../logger";
import type { QdrantClient, QdrantFilter } from "../qdrant";
import {
  enrichSignals,
  type EnrichmentGates,
  type EnrichSignalsResult,
} from "../signal-enrichment";
import type { MemorySourceKind } from "../types";
import {
  buildPayloadPatch,
  type CandidatePoint,
  groupBySource,
  REQUIRED_FACET_KEYS,
  type SourceGroup,
  toCandidate,
} from "./select";

const log = createLogger("facet-backfill");

type Db = InstanceType<typeof SQL>;

/** Fetch the combined chunk text for a memory source (chunk order preserved). */
export type SourceTextFetcher = (sourceId: string) => Promise<string>;

/** Run a batch of sources through facet extraction + ranking. */
export type SignalEnricher = (
  items: ReadonlyArray<{
    readonly id: string;
    readonly kind: MemorySourceKind;
    readonly text: string;
  }>,
) => Promise<EnrichSignalsResult>;

export interface BackfillDeps {
  readonly qdrantClient: QdrantClient;
  readonly qdrantCollection: string;
  readonly fetchSourceText: SourceTextFetcher;
  readonly enrich: SignalEnricher;
}

export interface BackfillOptions {
  /** Sources to enrich+patch per LLM/Qdrant batch. */
  readonly batchSize: number;
  /** Stop after selecting this many sources (0 = no limit). */
  readonly limit: number;
  /** Qdrant scroll page size. */
  readonly scrollPageSize: number;
  /** When true, select + count only — no extraction, no writes. */
  readonly dryRun: boolean;
  /** Optional kind filter (server-side) to narrow the scan. */
  readonly kind?: MemorySourceKind;
  /** Payload keys whose absence marks a point as un-enriched. */
  readonly requiredKeys?: readonly string[];
}

export interface BackfillResult {
  readonly scannedPoints: number;
  readonly candidatePoints: number;
  readonly candidateSources: number;
  readonly enrichedSources: number;
  readonly patchedSources: number;
  readonly patchedPoints: number;
  readonly skippedNoText: number;
  readonly skippedNoFacets: number;
  readonly dryRun: boolean;
}

/**
 * Default DB-backed source-text fetcher: concatenate a source's chunks in
 * `chunk_index` order, matching how the live indexer composes the text it sends
 * to extraction (`chunks.join("\n\n")`).
 */
export function makeSourceTextFetcher(db: Db): SourceTextFetcher {
  return async (sourceId) => {
    const rows = (await db`
      SELECT content
      FROM memory_chunks
      WHERE source_id = ${sourceId}
      ORDER BY chunk_index ASC
    `) as ReadonlyArray<{ content: string }>;
    return rows
      .map((r) => r.content)
      .filter((c) => c.trim().length > 0)
      .join("\n\n");
  };
}

/**
 * Default enricher: force facet extraction ON (the backfill exists precisely
 * because the live flag may be off), while leaving ranking gated on live config
 * so a backfill cannot silently start writing ranking payload the deployment
 * hasn't opted into.
 */
export function makeEnricher(rankingEnabled: boolean): SignalEnricher {
  const gates: EnrichmentGates = {
    signalFacets: true,
    signalRanking: rankingEnabled,
  };
  return (items) => enrichSignals(items, { gates });
}

/** Scroll the collection and collect every source needing backfill. */
async function selectSources(
  deps: BackfillDeps,
  opts: BackfillOptions,
): Promise<{ readonly groups: readonly SourceGroup[]; readonly scanned: number }> {
  const requiredKeys = opts.requiredKeys ?? REQUIRED_FACET_KEYS;
  const filter: QdrantFilter | undefined = opts.kind
    ? { must: [{ key: "kind", match: { value: opts.kind } }] }
    : undefined;

  const candidates: CandidatePoint[] = [];
  let offset: string | number | undefined;
  let scanned = 0;

  // Drain the cursor; `limit` is applied at the source-group level after
  // grouping so a source's points are never split across the boundary.
  for (;;) {
    const page = await deps.qdrantClient.scrollPoints(deps.qdrantCollection, {
      filter,
      limit: opts.scrollPageSize,
      offset,
    });
    scanned += page.points.length;
    for (const point of page.points) {
      const candidate = toCandidate(point, requiredKeys);
      if (candidate) candidates.push(candidate);
    }
    if (page.nextPageOffset === null || page.points.length === 0) break;
    offset = page.nextPageOffset;
  }

  const allGroups = groupBySource(candidates);
  const groups =
    opts.limit > 0 ? allGroups.slice(0, opts.limit) : allGroups;

  return { groups, scanned };
}

/** Process one batch of source groups: enrich, then patch each source's points. */
async function processBatch(
  deps: BackfillDeps,
  batch: readonly SourceGroup[],
  acc: {
    enrichedSources: number;
    patchedSources: number;
    patchedPoints: number;
    skippedNoText: number;
    skippedNoFacets: number;
  },
): Promise<void> {
  const items: Array<{ id: string; kind: MemorySourceKind; text: string }> = [];
  const groupById = new Map<string, SourceGroup>();

  for (const group of batch) {
    const text = await deps.fetchSourceText(group.sourceId);
    if (text.trim().length === 0) {
      acc.skippedNoText += 1;
      continue;
    }
    items.push({ id: group.sourceId, kind: group.kind, text });
    groupById.set(group.sourceId, group);
  }

  if (items.length === 0) return;

  const { facets, payloads } = await deps.enrich(items);
  acc.enrichedSources += items.length;

  for (const item of items) {
    const group = groupById.get(item.id);
    if (!group) continue;

    const patch = buildPayloadPatch(
      facets.get(item.id) ?? null,
      payloads.get(item.id) ?? {},
    );
    if (Object.keys(patch).length === 0) {
      acc.skippedNoFacets += 1;
      continue;
    }

    await deps.qdrantClient.setPayload(
      deps.qdrantCollection,
      { ids: group.pointIds },
      patch,
    );
    acc.patchedSources += 1;
    acc.patchedPoints += group.pointIds.length;
  }
}

/** Run the facet backfill end to end. */
export async function runFacetBackfill(
  deps: BackfillDeps,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const { groups, scanned } = await selectSources(deps, opts);
  const candidatePoints = groups.reduce(
    (sum, g) => sum + g.pointIds.length,
    0,
  );

  log.info("Facet backfill selection complete", {
    scannedPoints: scanned,
    candidateSources: groups.length,
    candidatePoints,
    dryRun: opts.dryRun,
  });

  if (opts.dryRun || groups.length === 0) {
    return {
      scannedPoints: scanned,
      candidatePoints,
      candidateSources: groups.length,
      enrichedSources: 0,
      patchedSources: 0,
      patchedPoints: 0,
      skippedNoText: 0,
      skippedNoFacets: 0,
      dryRun: opts.dryRun,
    };
  }

  const acc = {
    enrichedSources: 0,
    patchedSources: 0,
    patchedPoints: 0,
    skippedNoText: 0,
    skippedNoFacets: 0,
  };

  for (let i = 0; i < groups.length; i += opts.batchSize) {
    const batch = groups.slice(i, i + opts.batchSize);
    await processBatch(deps, batch, acc);
    log.info("Facet backfill batch done", {
      processed: Math.min(i + opts.batchSize, groups.length),
      total: groups.length,
      patchedSources: acc.patchedSources,
      patchedPoints: acc.patchedPoints,
    });
  }

  return {
    scannedPoints: scanned,
    candidatePoints,
    candidateSources: groups.length,
    enrichedSources: acc.enrichedSources,
    patchedSources: acc.patchedSources,
    patchedPoints: acc.patchedPoints,
    skippedNoText: acc.skippedNoText,
    skippedNoFacets: acc.skippedNoFacets,
    dryRun: false,
  };
}
