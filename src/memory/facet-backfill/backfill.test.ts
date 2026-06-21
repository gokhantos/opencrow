/**
 * Unit tests for the facet-backfill orchestration.
 *
 * Lane: unit (no DB, no network, no mock.module). Drives `runFacetBackfill`
 * with in-memory fakes for the Qdrant client, the source-text fetcher, and the
 * enricher to assert the scroll/group/patch flow, the dry-run short-circuit,
 * the `--limit` source cap, and the no-text / no-facets skip paths.
 */

import { describe, expect, test } from "bun:test";
import type {
  QdrantClient,
  QdrantScrollOptions,
  QdrantScrollResult,
  SetPayloadTarget,
} from "../qdrant";
import type { EnrichSignalsResult } from "../signal-enrichment";
import type { SignalFacets } from "../signal-facets";
import type { MemorySourceKind } from "../types";
import {
  type BackfillDeps,
  type SignalEnricher,
  runFacetBackfill,
} from "./backfill";

interface PatchCall {
  readonly target: SetPayloadTarget;
  readonly payload: Readonly<Record<string, string | number>>;
}

/**
 * A Qdrant client fake that serves a fixed list of scroll points in pages and
 * records every `setPayload` call. Only the methods the backfill touches are
 * implemented; the rest throw if hit so an accidental dependency is loud.
 */
function makeQdrantFake(
  pages: ReadonlyArray<
    ReadonlyArray<{ id: string; payload: Record<string, string | number> }>
  >,
): { client: QdrantClient; patches: PatchCall[] } {
  const patches: PatchCall[] = [];
  let pageIndex = 0;

  const client = {
    available: true,
    async scrollPoints(
      _collection: string,
      _opts: QdrantScrollOptions,
    ): Promise<QdrantScrollResult> {
      const page = pages[pageIndex] ?? [];
      const isLast = pageIndex >= pages.length - 1;
      pageIndex += 1;
      return {
        points: page.map((p) => ({ id: p.id, payload: p.payload })),
        nextPageOffset: isLast ? null : String(pageIndex),
      };
    },
    async setPayload(
      _collection: string,
      target: SetPayloadTarget,
      payload: Readonly<Record<string, string | number>>,
    ): Promise<void> {
      patches.push({ target, payload });
    },
  } as unknown as QdrantClient;

  return { client, patches };
}

const FACETS: SignalFacets = {
  problemType: "bug",
  targetAudience: "devs",
  jtbd: "ship",
  sentiment: "negative",
  entities: [],
  importance: "high",
  relevanceToIdeas: 0.8,
  category: "tooling",
};

/** Enricher that returns the same facets for every requested id. */
function enricherWithFacets(): SignalEnricher {
  return async (items): Promise<EnrichSignalsResult> => {
    const facets = new Map<string, SignalFacets | null>();
    const payloads = new Map<string, Record<string, string | number>>();
    for (const item of items) {
      facets.set(item.id, FACETS);
      payloads.set(item.id, {});
    }
    return { facets, payloads };
  };
}

function deps(
  client: QdrantClient,
  overrides: Partial<BackfillDeps> = {},
): BackfillDeps {
  return {
    qdrantClient: client,
    qdrantCollection: "opencrow_memory",
    fetchSourceText: async (id) => `text for ${id}`,
    enrich: enricherWithFacets(),
    ...overrides,
  };
}

const UNENRICHED = {
  kind: "hackernews_story" as MemorySourceKind,
};

describe("runFacetBackfill — selection", () => {
  test("scans all pages and groups candidate points by source", async () => {
    const { client, patches } = makeQdrantFake([
      [
        { id: "p1", payload: { ...UNENRICHED, sourceId: "s1", chunkIndex: 0 } },
        { id: "p2", payload: { ...UNENRICHED, sourceId: "s1", chunkIndex: 1 } },
      ],
      [{ id: "p3", payload: { ...UNENRICHED, sourceId: "s2", chunkIndex: 0 } }],
    ]);

    const result = await runFacetBackfill(deps(client), {
      batchSize: 8,
      limit: 0,
      scrollPageSize: 2,
      dryRun: false,
    });

    expect(result.scannedPoints).toBe(3);
    expect(result.candidateSources).toBe(2);
    expect(result.candidatePoints).toBe(3);
    expect(result.patchedSources).toBe(2);
    expect(result.patchedPoints).toBe(3);
    // s1 patched by its two ids together; s2 by one.
    expect(patches).toHaveLength(2);
    expect(patches[0]?.target).toEqual({ ids: ["p1", "p2"] });
    expect(patches[0]?.payload.facetProblemType).toBe("bug");
  });

  test("skips already-enriched and non-signal points", async () => {
    const { client, patches } = makeQdrantFake([
      [
        {
          id: "p1",
          payload: {
            ...UNENRICHED,
            sourceId: "s1",
            facetProblemType: "x",
            signalCategory: "y",
          },
        },
        { id: "p2", payload: { kind: "observation", sourceId: "s2" } },
        { id: "p3", payload: { ...UNENRICHED, sourceId: "s3", chunkIndex: 0 } },
      ],
    ]);

    const result = await runFacetBackfill(deps(client), {
      batchSize: 8,
      limit: 0,
      scrollPageSize: 8,
      dryRun: false,
    });

    expect(result.scannedPoints).toBe(3);
    expect(result.candidateSources).toBe(1);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.target).toEqual({ ids: ["p3"] });
  });
});

describe("runFacetBackfill — dry run", () => {
  test("counts the backlog but does not enrich or patch", async () => {
    let enrichCalls = 0;
    const { client, patches } = makeQdrantFake([
      [{ id: "p1", payload: { ...UNENRICHED, sourceId: "s1" } }],
    ]);

    const result = await runFacetBackfill(
      deps(client, {
        enrich: async (items) => {
          enrichCalls += 1;
          const facets = new Map<string, SignalFacets | null>();
          const payloads = new Map<string, Record<string, string | number>>();
          for (const i of items) {
            facets.set(i.id, FACETS);
            payloads.set(i.id, {});
          }
          return { facets, payloads };
        },
      }),
      { batchSize: 8, limit: 0, scrollPageSize: 8, dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.candidateSources).toBe(1);
    expect(result.patchedSources).toBe(0);
    expect(enrichCalls).toBe(0);
    expect(patches).toHaveLength(0);
  });
});

describe("runFacetBackfill — limit", () => {
  test("caps the number of sources processed", async () => {
    const { client } = makeQdrantFake([
      [
        { id: "p1", payload: { ...UNENRICHED, sourceId: "s1" } },
        { id: "p2", payload: { ...UNENRICHED, sourceId: "s2" } },
        { id: "p3", payload: { ...UNENRICHED, sourceId: "s3" } },
      ],
    ]);

    const result = await runFacetBackfill(deps(client), {
      batchSize: 8,
      limit: 2,
      scrollPageSize: 8,
      dryRun: false,
    });

    expect(result.candidateSources).toBe(2);
    expect(result.patchedSources).toBe(2);
  });
});

describe("runFacetBackfill — skip paths", () => {
  test("skips sources whose chunk text is empty", async () => {
    const { client, patches } = makeQdrantFake([
      [{ id: "p1", payload: { ...UNENRICHED, sourceId: "s1" } }],
    ]);

    const result = await runFacetBackfill(
      deps(client, { fetchSourceText: async () => "   " }),
      { batchSize: 8, limit: 0, scrollPageSize: 8, dryRun: false },
    );

    expect(result.skippedNoText).toBe(1);
    expect(result.patchedSources).toBe(0);
    expect(patches).toHaveLength(0);
  });

  test("skips sources the enricher returns no facets for", async () => {
    const { client, patches } = makeQdrantFake([
      [{ id: "p1", payload: { ...UNENRICHED, sourceId: "s1" } }],
    ]);

    const result = await runFacetBackfill(
      deps(client, {
        enrich: async (items) => {
          const facets = new Map<string, SignalFacets | null>();
          const payloads = new Map<string, Record<string, string | number>>();
          for (const i of items) {
            facets.set(i.id, null);
            payloads.set(i.id, {});
          }
          return { facets, payloads };
        },
      }),
      { batchSize: 8, limit: 0, scrollPageSize: 8, dryRun: false },
    );

    expect(result.skippedNoFacets).toBe(1);
    expect(result.patchedSources).toBe(0);
    expect(patches).toHaveLength(0);
  });
});
