import { createLogger } from "../../logger";
import type { Mem0Client, Mem0Memory, Mem0Relation } from "../knowledge/mem0-client";
import type { GraphNode } from "../knowledge/graph-query";

const log = createLogger("sige:retrieval-modes");

// ─── Result Type ──────────────────────────────────────────────────────────────

export interface RetrievalResult {
  readonly facts: readonly string[];
  readonly nodes: readonly GraphNode[];
  readonly score: number;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Decompose a query into 2-3 sub-questions using simple clause-boundary heuristics.
 * Splits on conjunctions and punctuation boundaries.
 */
function decomposeQuery(query: string): readonly string[] {
  const clauses = query
    .split(/\band\b|\bor\b|[,;?]|\bthen\b|\bbut\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 3);

  // Cap at 3 sub-questions to limit API calls
  const subQuestions = clauses.slice(0, 3);
  return subQuestions.length > 0 ? subQuestions : [query];
}

function memoriesToFacts(memories: readonly Mem0Memory[]): readonly string[] {
  const seen = new Set<string>();
  const facts: string[] = [];

  for (const m of memories) {
    if (m.memory && !seen.has(m.memory)) {
      seen.add(m.memory);
      facts.push(m.memory);
    }
  }

  return facts;
}

function relationsToFacts(relations: readonly Mem0Relation[]): readonly string[] {
  return relations.map((r) => `${r.source} ${r.relationship} ${r.target}`);
}

function memoriesToNodes(memories: readonly Mem0Memory[]): readonly GraphNode[] {
  const seen = new Set<string>();
  const nodes: GraphNode[] = [];

  for (const m of memories) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      nodes.push({
        uuid: m.id,
        name: m.memory.slice(0, 80),
        entityType:
          typeof m.metadata?.entityType === "string" ? m.metadata.entityType : "Fact",
        summary: m.memory,
      });
    }
  }

  return nodes;
}

function aggregateScore(memories: readonly Mem0Memory[]): number {
  if (memories.length === 0) return 0;
  const total = memories.reduce((sum, m) => sum + (m.score ?? 0), 0);
  const avg = total / memories.length;
  return Math.max(0, Math.min(1, avg));
}

function mergeMemories(
  ...batches: readonly (readonly Mem0Memory[])[]
): readonly Mem0Memory[] {
  const seen = new Set<string>();
  const merged: Mem0Memory[] = [];

  for (const batch of batches) {
    for (const m of batch) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        merged.push(m);
      }
    }
  }

  return merged;
}

function mergeRelations(
  ...batches: readonly (readonly Mem0Relation[])[]
): readonly Mem0Relation[] {
  const seen = new Set<string>();
  const merged: Mem0Relation[] = [];

  for (const batch of batches) {
    for (const r of batch) {
      const key = `${r.source}|${r.relationship}|${r.target}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(r);
      }
    }
  }

  return merged;
}

// ─── Retrieval Modes ──────────────────────────────────────────────────────────

/**
 * Deep multi-hop retrieval for complex strategic questions.
 *
 * Decomposes the query into sub-questions, retrieves results for each,
 * then expands each result by searching on the top memory content strings
 * to surface connected entities (one-hop expansion).
 */
export async function insightForge(
  mem0: Mem0Client,
  userId: string,
  query: string,
  options?: { readonly maxResults?: number },
): Promise<RetrievalResult> {
  const maxResults = options?.maxResults ?? 15;
  const subQuestions = decomposeQuery(query);

  log.debug("insightForge: starting multi-hop retrieval", {
    userId,
    subQuestions: subQuestions.length,
  });

  // Retrieve results for each sub-question in parallel
  const firstHopResults = await Promise.all(
    subQuestions.map((q) =>
      mem0
        .search({ query: q, userId, limit: 10, enableGraph: true })
        .catch(() => ({ memories: [] as Mem0Memory[], relations: [] as Mem0Relation[] })),
    ),
  );

  const firstHopMemories = mergeMemories(...firstHopResults.map((r) => r.memories));
  const firstHopRelations = mergeRelations(...firstHopResults.map((r) => r.relations));

  // One-hop expansion: search using top memory content as queries
  const expansionQueries = firstHopMemories
    .slice(0, 10)
    .map((m) => m.memory.slice(0, 100));

  const secondHopResults = await Promise.all(
    expansionQueries.map((q) =>
      mem0
        .search({ query: q, userId, limit: 5, enableGraph: false })
        .catch(() => ({ memories: [] as Mem0Memory[], relations: [] as Mem0Relation[] })),
    ),
  );

  const allMemories = mergeMemories(
    firstHopMemories,
    ...secondHopResults.map((r) => r.memories),
  );
  const allRelations = mergeRelations(
    firstHopRelations,
    ...secondHopResults.map((r) => r.relations),
  );

  // Sort by score descending and cap
  const topMemories = [...allMemories]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxResults);

  const graphFacts = memoriesToFacts(topMemories);
  const relationFacts = relationsToFacts(allRelations.slice(0, maxResults));
  const facts = Array.from(new Set([...graphFacts, ...relationFacts]));

  log.debug("insightForge: complete", {
    userId,
    firstHop: firstHopMemories.length,
    total: allMemories.length,
    returned: topMemories.length,
  });

  return {
    facts,
    nodes: memoriesToNodes(topMemories),
    score: aggregateScore(topMemories),
  };
}

/**
 * Broad retrieval showing the full picture.
 *
 * Fetches all memories for a user to capture the entire knowledge store.
 * Breadth over precision — no filtering applied.
 */
export async function panoramaSearch(
  mem0: Mem0Client,
  userId: string,
  query: string,
  options?: { readonly maxResults?: number },
): Promise<RetrievalResult> {
  const maxResults = options?.maxResults ?? 50;

  log.debug("panoramaSearch: starting broad retrieval", { userId });

  const [allResult, searchResult] = await Promise.allSettled([
    mem0.getAll({ userId, limit: maxResults }),
    mem0.search({ query, userId, limit: maxResults, enableGraph: true }),
  ]);

  const allMemories: readonly Mem0Memory[] =
    allResult.status === "fulfilled" ? allResult.value : [];

  const searchMemories: readonly Mem0Memory[] =
    searchResult.status === "fulfilled" ? searchResult.value.memories : [];
  const searchRelations: readonly Mem0Relation[] =
    searchResult.status === "fulfilled" ? searchResult.value.relations : [];

  const merged = mergeMemories(allMemories, searchMemories);
  const allFacts = Array.from(
    new Set([...memoriesToFacts(merged), ...relationsToFacts(searchRelations)]),
  );

  log.debug("panoramaSearch: complete", {
    userId,
    allMemories: allMemories.length,
    searchMemories: searchMemories.length,
    totalFacts: allFacts.length,
  });

  return {
    facts: allFacts,
    nodes: memoriesToNodes(merged),
    score: aggregateScore(searchMemories),
  };
}

/**
 * Fast direct semantic search.
 *
 * Single Mem0 search with minimal post-processing. Optimised for latency.
 */
export async function quickSearch(
  mem0: Mem0Client,
  userId: string,
  query: string,
  options?: { readonly maxResults?: number },
): Promise<RetrievalResult> {
  const maxResults = options?.maxResults ?? 10;

  log.debug("quickSearch: starting fast retrieval", { userId });

  const result = await mem0
    .search({ query, userId, limit: maxResults, enableGraph: true })
    .catch((err: unknown) => {
      log.warn("quickSearch: mem0.search failed, returning empty result", { err });
      return { memories: [] as Mem0Memory[], relations: [] as Mem0Relation[] };
    });

  const facts = Array.from(
    new Set([
      ...memoriesToFacts(result.memories),
      ...relationsToFacts(result.relations),
    ]),
  );

  return {
    facts,
    nodes: memoriesToNodes(result.memories),
    score: aggregateScore(result.memories),
  };
}
