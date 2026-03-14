import { createLogger } from "../../logger"
import type { ZepClient, ZepNode, ZepSearchResult } from "../knowledge/zep-client"

const log = createLogger("sige:retrieval-modes")

// ─── Result Type ──────────────────────────────────────────────────────────────

export interface RetrievalResult {
  readonly facts: readonly string[]
  readonly nodes: readonly ZepNode[]
  readonly score: number
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
    .filter((c) => c.length > 3)

  // Cap at 3 sub-questions to limit API calls
  const subQuestions = clauses.slice(0, 3)
  return subQuestions.length > 0 ? subQuestions : [query]
}

function extractFacts(results: readonly ZepSearchResult[]): readonly string[] {
  const seen = new Set<string>()
  const facts: string[] = []

  for (const r of results) {
    const fact = r.fact ?? r.edge?.fact
    if (fact && !seen.has(fact)) {
      seen.add(fact)
      facts.push(fact)
    }
  }

  return facts
}

function extractNodes(results: readonly ZepSearchResult[]): readonly ZepNode[] {
  const seen = new Set<string>()
  const nodes: ZepNode[] = []

  for (const r of results) {
    if (r.node && !seen.has(r.node.uuid)) {
      seen.add(r.node.uuid)
      nodes.push(r.node)
    }
  }

  return nodes
}

function mergeResults(
  ...batches: readonly (readonly ZepSearchResult[])[]
): readonly ZepSearchResult[] {
  const seen = new Set<string>()
  const merged: ZepSearchResult[] = []

  for (const batch of batches) {
    for (const r of batch) {
      const key = r.node?.uuid ?? r.edge?.uuid ?? r.fact ?? ""
      if (key && !seen.has(key)) {
        seen.add(key)
        merged.push(r)
      }
    }
  }

  return merged
}

function aggregateScore(results: readonly ZepSearchResult[]): number {
  if (results.length === 0) return 0
  const total = results.reduce((sum, r) => sum + r.score, 0)
  const avg = total / results.length
  return Math.max(0, Math.min(1, avg))
}

// ─── Retrieval Modes ──────────────────────────────────────────────────────────

/**
 * Deep multi-hop retrieval for complex strategic questions.
 *
 * Decomposes the query into sub-questions, retrieves results for each,
 * then expands each result node by one additional hop to surface connected entities.
 */
export async function insightForge(
  zep: ZepClient,
  userId: string,
  query: string,
  options?: { readonly maxHops?: number; readonly maxResults?: number },
): Promise<RetrievalResult> {
  const maxResults = options?.maxResults ?? 15
  const subQuestions = decomposeQuery(query)

  log.debug("insightForge: starting multi-hop retrieval", {
    userId,
    subQuestions: subQuestions.length,
  })

  // Retrieve results for each sub-question in parallel
  const firstHopBatches = await Promise.all(
    subQuestions.map((q) => zep.searchGraph(userId, q, { limit: 10 }).catch(() => [])),
  )

  const firstHopAll = mergeResults(...firstHopBatches)

  // One-hop expansion: for each node found, search using its name as query
  const nodeNames = firstHopAll
    .flatMap((r) => (r.node ? [r.node.name] : []))
    .slice(0, 10) // cap to avoid explosion

  const secondHopBatches = await Promise.all(
    nodeNames.map((name) =>
      zep.searchGraph(userId, name, { limit: 5 }).catch(() => []),
    ),
  )

  const allResults = mergeResults(firstHopAll, ...secondHopBatches)
  const topResults = [...allResults]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  log.debug("insightForge: complete", {
    userId,
    firstHop: firstHopAll.length,
    total: allResults.length,
    returned: topResults.length,
  })

  return {
    facts: extractFacts(topResults),
    nodes: extractNodes(topResults),
    score: aggregateScore(topResults),
  }
}

/**
 * Broad retrieval showing evolution over time.
 *
 * Queries both the graph and memory stores to capture current structure
 * and historical facts. Breadth over precision — no filtering applied.
 */
export async function panoramaSearch(
  zep: ZepClient,
  userId: string,
  query: string,
  options?: { readonly maxResults?: number; readonly includeExpired?: boolean },
): Promise<RetrievalResult> {
  const maxResults = options?.maxResults ?? 50

  log.debug("panoramaSearch: starting broad retrieval", { userId })

  const [graphResults, memoryResults] = await Promise.allSettled([
    zep.searchGraph(userId, query, { limit: maxResults }),
    zep.searchMemory(userId, query, { limit: maxResults }),
  ])

  const graphItems: readonly ZepSearchResult[] =
    graphResults.status === "fulfilled" ? graphResults.value : []

  // Convert memory results into a unified shape for fact extraction
  const memoryFacts: readonly string[] =
    memoryResults.status === "fulfilled"
      ? memoryResults.value.map((r) => r.fact)
      : []

  // Sort graph results by score (spread first since graphItems is readonly)
  // panorama intentionally returns all, no slice
  const sortedGraph = [...graphItems].sort((a, b) => b.score - a.score)

  // Merge memory facts with graph-derived facts, deduplicated
  const graphFacts = extractFacts(sortedGraph)
  const allFacts = Array.from(new Set([...graphFacts, ...memoryFacts]))

  log.debug("panoramaSearch: complete", {
    userId,
    graphItems: graphItems.length,
    memoryFacts: memoryFacts.length,
    totalFacts: allFacts.length,
  })

  return {
    facts: allFacts,
    nodes: extractNodes(sortedGraph),
    score: aggregateScore(sortedGraph),
  }
}

/**
 * Fast direct semantic search.
 *
 * Single graph query with minimal post-processing. Optimised for latency.
 */
export async function quickSearch(
  zep: ZepClient,
  userId: string,
  query: string,
  options?: { readonly maxResults?: number },
): Promise<RetrievalResult> {
  const maxResults = options?.maxResults ?? 10

  log.debug("quickSearch: starting fast retrieval", { userId })

  const results = await zep
    .searchGraph(userId, query, { limit: maxResults })
    .catch((err: unknown) => {
      log.warn("quickSearch: graph search failed, returning empty result", { err })
      return []
    })

  return {
    facts: extractFacts(results),
    nodes: extractNodes(results),
    score: aggregateScore(results),
  }
}
