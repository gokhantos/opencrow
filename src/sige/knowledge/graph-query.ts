import { createLogger } from "../../logger";
import type { KnowledgeFilter, StrategicAgentRole } from "../types";
import type { ZepClient, ZepEdge, ZepNode } from "./zep-client";

const log = createLogger("sige:graph-query");

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface GraphView {
  readonly nodes: readonly ZepNode[];
  readonly edges: readonly ZepEdge[];
  readonly summary: string;
}

export interface GraphQueryOptions {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly includeWeights?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_NODES = 100;
const DEFAULT_MAX_EDGES = 200;
const PROMPT_MAX_NODES = 15;
const PROMPT_MAX_EDGES = 20;

// ─── Scoring ──────────────────────────────────────────────────────────────────

function nodeMatchesTerms(node: ZepNode, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const haystack =
    `${node.name} ${node.entityType} ${node.summary ?? ""}`.toLowerCase();
  return terms.some((t) => haystack.includes(t.toLowerCase()));
}

/**
 * Computes a relevance score for a node against a KnowledgeFilter.
 * Higher score = higher priority in filtered results.
 *
 * Score bands:
 *   +10 per amplified match
 *    0  neutral (no match to any list)
 *   -5  per attenuated match
 *   -∞  (excluded — caller handles removal)
 */
function scoreNode(node: ZepNode, filter: KnowledgeFilter): number {
  let score = 0;

  if (nodeMatchesTerms(node, filter.amplifiedEntities)) {
    score += 10;
  }
  if (nodeMatchesTerms(node, filter.attenuatedEntities)) {
    score -= 5;
  }

  return score;
}

// ─── Summary Generation ───────────────────────────────────────────────────────

function buildSummary(nodes: readonly ZepNode[], edges: readonly ZepEdge[]): string {
  if (nodes.length === 0) {
    return "No entities found in the knowledge graph.";
  }

  const topNodes = nodes.slice(0, 5);
  const entityList = topNodes.map((n) => n.name).join(", ");
  const entityCount = nodes.length;
  const edgeCount = edges.length;

  return `Graph contains ${entityCount} entit${entityCount === 1 ? "y" : "ies"} and ${edgeCount} relationship${edgeCount === 1 ? "" : "s"}. Key entities: ${entityList}.`;
}

// ─── Truncation ───────────────────────────────────────────────────────────────

/**
 * Retains only edges where both endpoints are present in the node set.
 */
function retainConnectedEdges(
  edges: readonly ZepEdge[],
  nodeUuids: ReadonlySet<string>,
): readonly ZepEdge[] {
  return edges.filter(
    (e) => nodeUuids.has(e.sourceNodeUuid) && nodeUuids.has(e.targetNodeUuid),
  );
}

function truncateGraph(
  nodes: readonly ZepNode[],
  edges: readonly ZepEdge[],
  maxNodes: number,
  maxEdges: number,
): { readonly nodes: readonly ZepNode[]; readonly edges: readonly ZepEdge[] } {
  const truncatedNodes = nodes.slice(0, maxNodes);
  const nodeUuids = new Set(truncatedNodes.map((n) => n.uuid));
  const connectedEdges = retainConnectedEdges(edges, nodeUuids);
  const truncatedEdges = connectedEdges.slice(0, maxEdges);
  return { nodes: truncatedNodes, edges: truncatedEdges };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches and returns the complete knowledge graph for a user, truncated to
 * the configured limits.
 */
export async function getFullGraph(
  zep: ZepClient,
  userId: string,
  options?: GraphQueryOptions,
): Promise<GraphView> {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES;

  let rawNodes: readonly ZepNode[];
  let rawEdges: readonly ZepEdge[];

  try {
    const result = await zep.getFullGraph(userId);
    rawNodes = result.nodes;
    rawEdges = result.edges;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("getFullGraph: zep.getFullGraph failed", { err, userId });
    throw new Error(`Failed to fetch knowledge graph for user ${userId}: ${msg}`);
  }

  if (rawNodes.length === 0) {
    log.debug("getFullGraph: empty graph", { userId });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  const { nodes, edges } = truncateGraph(rawNodes, rawEdges, maxNodes, maxEdges);
  const summary = buildSummary(nodes, edges);

  log.debug("getFullGraph: done", { userId, nodeCount: nodes.length, edgeCount: edges.length });

  return { nodes, edges, summary };
}

/**
 * Returns a role-specific filtered view of the knowledge graph, sorted by
 * relevance score derived from the provided KnowledgeFilter.
 */
export async function getFilteredGraphView(
  zep: ZepClient,
  userId: string,
  role: StrategicAgentRole,
  filter: KnowledgeFilter,
  options?: GraphQueryOptions,
): Promise<GraphView> {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES;

  let rawNodes: readonly ZepNode[];
  let rawEdges: readonly ZepEdge[];

  try {
    const result = await zep.getFullGraph(userId);
    rawNodes = result.nodes;
    rawEdges = result.edges;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("getFilteredGraphView: zep.getFullGraph failed", { err, userId, role });
    throw new Error(`Failed to fetch knowledge graph for user ${userId}: ${msg}`);
  }

  if (rawNodes.length === 0) {
    log.debug("getFilteredGraphView: empty graph", { userId, role });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  // Step 1 — apply includedTopics filter (keep all if no inclusions specified)
  const afterInclude: readonly ZepNode[] =
    filter.includedTopics.length > 0
      ? rawNodes.filter((n) => nodeMatchesTerms(n, filter.includedTopics))
      : rawNodes;

  // Step 2 — apply excludedTopics filter
  const afterExclude: readonly ZepNode[] =
    filter.excludedTopics.length > 0
      ? afterInclude.filter((n) => !nodeMatchesTerms(n, filter.excludedTopics))
      : afterInclude;

  // Step 3 — score and sort
  const scored = afterExclude
    .map((n) => ({ node: n, score: scoreNode(n, filter) }))
    .sort((a, b) => b.score - a.score);

  const sortedNodes = scored.map((s) => s.node);

  // Step 4 — truncate and retain connected edges
  const { nodes, edges } = truncateGraph(sortedNodes, rawEdges, maxNodes, maxEdges);
  const summary = buildSummary(nodes, edges);

  log.debug("getFilteredGraphView: done", {
    userId,
    role,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  return { nodes, edges, summary };
}

/**
 * Searches the graph with a semantic query and returns the relevant subgraph
 * formed by the matched nodes and edges.
 */
export async function searchSubgraph(
  zep: ZepClient,
  userId: string,
  query: string,
  options?: GraphQueryOptions & { readonly limit?: number },
): Promise<GraphView> {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES;
  const limit = options?.limit ?? maxNodes;

  let results: Awaited<ReturnType<ZepClient["searchGraph"]>>;

  try {
    results = await zep.searchGraph(userId, query, { limit });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("searchSubgraph: zep.searchGraph failed", { err, userId, query });
    throw new Error(`Failed to search graph for user ${userId}: ${msg}`);
  }

  if (results.length === 0) {
    log.debug("searchSubgraph: no results", { userId, query });
    return { nodes: [], edges: [], summary: "No matching entities found for the query." };
  }

  // Collect nodes from results (deduplicated by uuid)
  const nodeMap = new Map<string, ZepNode>();
  const edgeMap = new Map<string, ZepEdge>();

  for (const result of results) {
    if (result.node) {
      nodeMap.set(result.node.uuid, result.node);
    }
    if (result.edge) {
      edgeMap.set(result.edge.uuid, result.edge);
    }
  }

  const nodes = Array.from(nodeMap.values()).slice(0, maxNodes);
  const nodeUuids = new Set(nodes.map((n) => n.uuid));

  // Retain only edges whose endpoints are both in our node set
  const edges = Array.from(edgeMap.values())
    .filter((e) => nodeUuids.has(e.sourceNodeUuid) && nodeUuids.has(e.targetNodeUuid))
    .slice(0, maxEdges);

  const summary = buildSummary(nodes, edges);

  log.debug("searchSubgraph: done", {
    userId,
    query,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  });

  return { nodes, edges, summary };
}

/**
 * Returns the default KnowledgeFilter for a given strategic agent role.
 * Each role amplifies entities relevant to its strategic perspective and
 * attenuates entities that are less relevant or opposing.
 */
export function getDefaultKnowledgeFilter(role: StrategicAgentRole): KnowledgeFilter {
  switch (role) {
    case "rational_player":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [],
        attenuatedEntities: [],
      };

    case "boundedly_rational":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [],
        attenuatedEntities: [],
      };

    case "cooperative":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["alliance", "partnership", "collaboration", "coalition", "agreement"],
        attenuatedEntities: ["competition", "threat", "conflict", "rivalry", "dispute"],
      };

    case "adversarial":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "threat",
          "risk",
          "vulnerability",
          "competition",
          "conflict",
          "rival",
          "weakness",
        ],
        attenuatedEntities: ["cooperation", "partnership", "alliance", "agreement"],
      };

    case "evolutionary":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["trend", "adoption", "market_share", "growth", "evolution", "fitness"],
        attenuatedEntities: [],
      };

    case "mechanism_designer":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "constraint",
          "rule",
          "regulation",
          "incentive",
          "policy",
          "mechanism",
          "governance",
        ],
        attenuatedEntities: [],
      };

    case "explorer":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["novel", "emerging", "experimental", "frontier", "innovation"],
        attenuatedEntities: ["established", "dominant", "incumbent", "legacy", "traditional"],
      };

    case "contrarian":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "assumption",
          "conventional",
          "mainstream",
          "consensus",
          "dominant",
          "orthodox",
        ],
        attenuatedEntities: [],
      };

    case "signaler":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "communication",
          "signal",
          "announcement",
          "reputation",
          "credibility",
          "perception",
        ],
        attenuatedEntities: [],
      };

    case "abductive_reasoner":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "anomaly",
          "unexplained",
          "surprising",
          "contradiction",
          "paradox",
          "outlier",
          "exception",
        ],
        attenuatedEntities: [],
      };
  }
}

/**
 * Converts a GraphView into a structured text block suitable for injection
 * into an agent system prompt.
 */
export function graphViewToPromptContext(view: GraphView): string {
  if (view.nodes.length === 0) {
    return "## Knowledge Graph Context\n\nNo knowledge graph data available.";
  }

  const topNodes = view.nodes.slice(0, PROMPT_MAX_NODES);
  const topEdges = view.edges.slice(0, PROMPT_MAX_EDGES);

  const entityLines = topNodes
    .map((n) => {
      const summary = n.summary ? `: ${n.summary}` : "";
      return `- ${n.name} (${n.entityType})${summary}`;
    })
    .join("\n");

  // Build a lookup map for node names to resolve edge endpoints
  const nodeNameByUuid = new Map<string, string>(view.nodes.map((n) => [n.uuid, n.name]));

  const relationshipLines = topEdges
    .map((e) => {
      const source = nodeNameByUuid.get(e.sourceNodeUuid) ?? e.sourceNodeUuid;
      const target = nodeNameByUuid.get(e.targetNodeUuid) ?? e.targetNodeUuid;
      return `- ${source} → ${e.relationType} → ${target}: ${e.fact}`;
    })
    .join("\n");

  const sections: string[] = [
    `## Knowledge Graph Context`,
    ``,
    `### Key Entities (${topNodes.length})`,
    entityLines,
  ];

  if (topEdges.length > 0) {
    sections.push(``, `### Key Relationships (${topEdges.length})`, relationshipLines);
  }

  sections.push(``, `### Summary`, view.summary);

  return sections.join("\n");
}
