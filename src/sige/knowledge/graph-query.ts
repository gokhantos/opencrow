import { createLogger } from "../../logger";
import type { KnowledgeFilter, StrategicAgentRole } from "../types";
import type { Mem0Client, Mem0Memory, Mem0Relation } from "./mem0-client";

const log = createLogger("sige:graph-query");

// ─── Public Types ─────────────────────────────────────────────────────────────

/**
 * Graph node derived from a Mem0 memory item.
 * Each memory fact about an entity becomes a node.
 */
export interface GraphNode {
  readonly uuid: string;
  readonly name: string;
  readonly entityType: string;
  readonly summary?: string;
}

/**
 * Graph edge derived from a Mem0 relation triple.
 */
export interface GraphEdge {
  readonly uuid: string;
  readonly sourceNodeUuid: string;
  readonly targetNodeUuid: string;
  readonly relationType: string;
  readonly fact: string;
  /** Optional relevance weight. Mem0 does not provide this; field may be undefined. */
  readonly weight?: number;
}

export interface GraphView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly summary: string;
}

export interface GraphQueryOptions {
  readonly maxNodes?: number;
  readonly maxEdges?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_NODES = 100;
const DEFAULT_MAX_EDGES = 200;
const PROMPT_MAX_NODES = 15;
const PROMPT_MAX_EDGES = 20;
const BROAD_GRAPH_QUERY = "key entities relationships concepts";

// ─── Mem0 → GraphView Conversion ──────────────────────────────────────────────

/**
 * Converts Mem0 search results into a GraphView.
 *
 * Each Mem0 memory item becomes a GraphNode. The `memory` text is used as the
 * node name (truncated) and summary. The `metadata.entityType` field is used
 * when present, otherwise "Fact" is the default type.
 *
 * Each Mem0 relation triple becomes a GraphEdge. Source and target strings are
 * matched against node names to resolve UUIDs; unresolvable endpoints are given
 * synthetic UUIDs so no data is silently dropped.
 */
export function mem0ResultToGraphView(
  memories: readonly Mem0Memory[],
  relations: readonly Mem0Relation[],
): GraphView {
  // Build nodes from memories
  const nodes: GraphNode[] = memories.map((m) => ({
    uuid: m.id,
    name: truncateName(m.memory),
    entityType:
      typeof m.metadata?.entityType === "string" ? m.metadata.entityType : "Fact",
    summary: m.memory,
  }));

  // Build a name → uuid lookup for edge resolution
  const nameToUuid = new Map<string, string>();
  for (const node of nodes) {
    nameToUuid.set(node.name.toLowerCase(), node.uuid);
  }

  // Build edges from relations
  const edges: GraphEdge[] = relations.map((r, i) => {
    const sourceKey = r.source.toLowerCase();
    const targetKey = r.target.toLowerCase();

    // Best-effort UUID resolution: exact match first, then substring match
    const sourceUuid =
      nameToUuid.get(sourceKey) ??
      findBestMatchUuid(nameToUuid, sourceKey) ??
      `synthetic:src:${i}`;
    const targetUuid =
      nameToUuid.get(targetKey) ??
      findBestMatchUuid(nameToUuid, targetKey) ??
      `synthetic:tgt:${i}`;

    return {
      uuid: `rel:${i}:${r.source}:${r.target}`,
      sourceNodeUuid: sourceUuid,
      targetNodeUuid: targetUuid,
      relationType: r.relationship,
      fact: `${r.source} ${r.relationship} ${r.target}`,
    };
  });

  const summary = buildSummary(nodes, edges);
  return { nodes, edges, summary };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

function nodeMatchesTerms(node: GraphNode, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const haystack =
    `${node.name} ${node.entityType} ${node.summary ?? ""}`.toLowerCase();
  return terms.some((t) => haystack.includes(t.toLowerCase()));
}

/**
 * Computes a relevance score for a node against a KnowledgeFilter.
 *
 * Score bands:
 *   +10 per amplified match
 *    0  neutral
 *   -5  per attenuated match
 */
function scoreNode(node: GraphNode, filter: KnowledgeFilter): number {
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

function buildSummary(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
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

function retainConnectedEdges(
  edges: readonly GraphEdge[],
  nodeUuids: ReadonlySet<string>,
): readonly GraphEdge[] {
  return edges.filter(
    (e) => nodeUuids.has(e.sourceNodeUuid) && nodeUuids.has(e.targetNodeUuid),
  );
}

function truncateGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  maxNodes: number,
  maxEdges: number,
): { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] } {
  const truncatedNodes = nodes.slice(0, maxNodes);
  const nodeUuids = new Set(truncatedNodes.map((n) => n.uuid));
  const connectedEdges = retainConnectedEdges(edges, nodeUuids);
  const truncatedEdges = connectedEdges.slice(0, maxEdges);
  return { nodes: truncatedNodes, edges: truncatedEdges };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches the complete knowledge graph for a user from Mem0 and returns a
 * truncated GraphView. Uses a broad query with graph enabled to retrieve as
 * many relations as possible.
 *
 * Degrades gracefully — an empty GraphView is returned if Mem0 is unavailable.
 */
export async function getFullGraph(
  mem0: Mem0Client,
  userId: string,
  options?: GraphQueryOptions,
): Promise<GraphView> {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES;

  let memories: readonly Mem0Memory[];
  let relations: readonly Mem0Relation[];

  try {
    const result = await mem0.search({
      query: BROAD_GRAPH_QUERY,
      userId,
      limit: maxNodes,
      enableGraph: true,
    });
    memories = result.memories;
    relations = result.relations;
  } catch (err) {
    log.error("getFullGraph: mem0.search failed — returning empty graph", { err, userId });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  if (memories.length === 0 && relations.length === 0) {
    log.debug("getFullGraph: empty graph", { userId });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  const raw = mem0ResultToGraphView(memories, relations);
  const { nodes, edges } = truncateGraph(raw.nodes, raw.edges, maxNodes, maxEdges);
  const summary = buildSummary(nodes, edges);

  log.debug("getFullGraph: done", { userId, nodeCount: nodes.length, edgeCount: edges.length });

  return { nodes, edges, summary };
}

/**
 * Returns a role-specific filtered view of the knowledge graph, sorted by
 * relevance score derived from the provided KnowledgeFilter.
 *
 * Degrades gracefully — an empty GraphView is returned if Mem0 is unavailable.
 */
export async function getFilteredGraphView(
  mem0: Mem0Client,
  userId: string,
  role: StrategicAgentRole,
  filter: KnowledgeFilter,
  options?: GraphQueryOptions,
): Promise<GraphView> {
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES;

  let memories: readonly Mem0Memory[];
  let relations: readonly Mem0Relation[];

  try {
    const result = await mem0.search({
      query: BROAD_GRAPH_QUERY,
      userId,
      limit: maxNodes,
      enableGraph: true,
    });
    memories = result.memories;
    relations = result.relations;
  } catch (err) {
    log.error("getFilteredGraphView: mem0.search failed — returning empty graph", {
      err,
      userId,
      role,
    });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  const raw = mem0ResultToGraphView(memories, relations);

  if (raw.nodes.length === 0) {
    log.debug("getFilteredGraphView: empty graph", { userId, role });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  // Step 1 — apply includedTopics filter (keep all if no inclusions specified)
  const afterInclude: readonly GraphNode[] =
    filter.includedTopics.length > 0
      ? raw.nodes.filter((n) => nodeMatchesTerms(n, filter.includedTopics))
      : raw.nodes;

  // Step 2 — apply excludedTopics filter
  const afterExclude: readonly GraphNode[] =
    filter.excludedTopics.length > 0
      ? afterInclude.filter((n) => !nodeMatchesTerms(n, filter.excludedTopics))
      : afterInclude;

  // Step 3 — score and sort
  const scored = afterExclude
    .map((n) => ({ node: n, score: scoreNode(n, filter) }))
    .sort((a, b) => b.score - a.score);

  const sortedNodes = scored.map((s) => s.node);

  // Step 4 — truncate and retain connected edges
  const { nodes, edges } = truncateGraph(sortedNodes, raw.edges, maxNodes, maxEdges);
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
 * Returns the default KnowledgeFilter for a given strategic agent role.
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

// ─── Internal Utilities ───────────────────────────────────────────────────────

function truncateName(text: string): string {
  // Use up to the first sentence or 80 chars as the node name
  const firstSentence = text.split(/[.!?]/)[0] ?? text;
  return firstSentence.trim().slice(0, 80);
}

function findBestMatchUuid(
  nameToUuid: Map<string, string>,
  key: string,
): string | undefined {
  for (const [name, uuid] of nameToUuid) {
    if (name.includes(key) || key.includes(name)) {
      return uuid;
    }
  }
  return undefined;
}
