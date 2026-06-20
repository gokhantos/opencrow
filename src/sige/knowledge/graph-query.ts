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
  /**
   * Mem0 search relevance score for the underlying memory, when available.
   * Higher means more relevant to the query. Undefined when the search backend
   * did not surface a score (e.g. getAll-style fetches). Used to rank nodes
   * before truncation so the most relevant entities survive.
   */
  readonly relevanceScore?: number;
  /**
   * Credibility of the underlying memory's source in [0, 1], lifted from
   * `metadata.credibility` when present. Undefined when absent.
   */
  readonly credibility?: number;
  /**
   * Source type of the underlying memory (e.g. "appstore_review"), lifted from
   * `metadata.source_type` when present. Undefined when absent.
   */
  readonly sourceType?: string;
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
  /**
   * When provided, mem0 is queried with this text instead of the broad graph
   * query, so results are scoped to a seed/topic and ranked by relevance to it.
   * Backward-compatible — omit it for the original broad behavior.
   */
  readonly scopeQuery?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_NODES = 100;
const DEFAULT_MAX_EDGES = 200;
const PROMPT_MAX_NODES = 15;
const PROMPT_MAX_EDGES = 20;
const BROAD_GRAPH_QUERY = "key entities relationships concepts";

/**
 * Weight applied to a node's credibility (0-1) when folding it into the
 * relevance score in getFilteredGraphView. Tuned so a maximally-credible source
 * (credibility 1) is worth half an amplified-entity match (+10), nudging
 * high-credibility sources up the ranking without overriding topical relevance.
 */
const CREDIBILITY_SCORE_WEIGHT = 5;

// ─── Mem0 → GraphView Conversion ──────────────────────────────────────────────

/**
 * Stable UUID prefix for nodes synthesized from a relation endpoint (a graph
 * entity name such as "app_store"). Distinct from memory-fact node UUIDs (mem0
 * memory ids), so the two never collide.
 */
const ENTITY_NODE_PREFIX = "entity:";

/**
 * Normalizes an entity name for use as a lookup key and stable UUID seed.
 * mem0/Neo4j entity endpoints are short snake_case names (e.g. "app_store");
 * lowercasing + trimming makes the source/target join stable regardless of
 * incidental casing or padding.
 */
function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Converts Mem0 search results into a GraphView.
 *
 * Two node populations are unified into one graph:
 *
 *  1. **Memory-fact nodes** — each Mem0 memory item becomes a GraphNode keyed by
 *     its mem0 id. The (truncated) `memory` text is the node name; `summary` is
 *     the full fact. `metadata.entityType` is used when present, else "Fact".
 *
 *  2. **Entity nodes** — Mem0/Neo4j relation triples reference graph *entities*
 *     by name (e.g. "app_store"), NOT by memory-fact text. Those names never
 *     match a fact-text node, so historically every edge resolved to a synthetic
 *     UUID and was then dropped by the connectivity filter (edgeCount always 0).
 *     We therefore synthesize one GraphNode per distinct relation endpoint, keyed
 *     by its normalized entity name with a stable `entity:<name>` UUID, so edges
 *     resolve to real, retained nodes and survive truncation's connectivity check.
 *
 * Each relation triple then becomes a GraphEdge whose endpoints resolve to a
 * memory-fact node when one matches by name, otherwise to the entity node for
 * that endpoint. Entity nodes are deduplicated, so an entity appearing on many
 * relations is a single node.
 */
export function mem0ResultToGraphView(
  memories: readonly Mem0Memory[],
  relations: readonly Mem0Relation[],
): GraphView {
  // Build memory-fact nodes
  const memoryNodes: GraphNode[] = memories.map((m) => ({
    uuid: m.id,
    name: truncateName(m.memory),
    entityType:
      typeof m.metadata?.entityType === "string" ? m.metadata.entityType : "Fact",
    summary: m.memory,
    relevanceScore: typeof m.score === "number" ? m.score : undefined,
    credibility: readCredibility(m.metadata),
    sourceType:
      typeof m.metadata?.source_type === "string" ? m.metadata.source_type : undefined,
  }));

  // name → uuid lookup for edge resolution, seeded with memory-fact node names.
  const nameToUuid = new Map<string, string>();
  for (const node of memoryNodes) {
    nameToUuid.set(node.name.toLowerCase(), node.uuid);
  }

  // Synthesize entity nodes from distinct relation endpoints so edges can join
  // to real nodes. Keyed by normalized entity name; a stable `entity:<name>`
  // UUID dedups an entity that appears across multiple relations into one node.
  const entityNodes: GraphNode[] = [];
  const entityUuidByName = new Map<string, string>();

  const ensureEntityNode = (rawName: string): string => {
    const key = normalizeEntityName(rawName);
    // Prefer an existing memory-fact node whose name matches this entity, so a
    // fact that genuinely names the entity stays the canonical node.
    const factUuid = nameToUuid.get(key);
    if (factUuid !== undefined) return factUuid;

    const existing = entityUuidByName.get(key);
    if (existing !== undefined) return existing;

    const uuid = `${ENTITY_NODE_PREFIX}${key}`;
    entityUuidByName.set(key, uuid);
    entityNodes.push({
      uuid,
      name: rawName.trim(),
      entityType: "Entity",
    });
    return uuid;
  };

  // Build edges from relations, resolving each endpoint to a real node.
  const edges: GraphEdge[] = relations.map((r, i) => {
    const sourceUuid = ensureEntityNode(r.source);
    const targetUuid = ensureEntityNode(r.target);

    return {
      uuid: `rel:${i}:${r.source}:${r.target}`,
      sourceNodeUuid: sourceUuid,
      targetNodeUuid: targetUuid,
      relationType: r.relationship,
      fact: `${r.source} ${r.relationship} ${r.target}`,
    };
  });

  const nodes: GraphNode[] = [...memoryNodes, ...entityNodes];
  const summary = buildSummary(nodes, edges);
  return { nodes, edges, summary };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Reads a credibility value (0-1) from a memory's metadata. Returns undefined
 * when absent or not a finite number in range, so callers stay graceful when
 * the ingestion layer hasn't written it.
 */
function readCredibility(metadata?: Record<string, unknown>): number | undefined {
  const raw = metadata?.credibility;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > 1) return undefined;
  return raw;
}

/**
 * Ranks nodes by mem0 relevance score (descending) ahead of truncation, so the
 * most relevant entities survive a maxNodes cut. Nodes without a score sort
 * after scored ones while preserving their original relative order (stable),
 * which preserves the previous behavior when no scores are present at all.
 */
function rankByRelevance(nodes: readonly GraphNode[]): readonly GraphNode[] {
  const anyScored = nodes.some((n) => typeof n.relevanceScore === "number");
  if (!anyScored) return nodes;

  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const sa = a.node.relevanceScore;
      const sb = b.node.relevanceScore;
      const hasA = typeof sa === "number";
      const hasB = typeof sb === "number";
      if (hasA && hasB) {
        if (sb !== sa) return (sb as number) - (sa as number);
        return a.index - b.index;
      }
      if (hasA) return -1;
      if (hasB) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.node);
}

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
 *   + credibility * CREDIBILITY_SCORE_WEIGHT  (when metadata.credibility present)
 *
 * Credibility folds in additively so that, all else equal, a node backed by a
 * higher-credibility source ranks above a lower-credibility one — letting
 * callers prefer trustworthy sources. Absent credibility contributes 0, so the
 * previous behavior is unchanged when the metadata is missing.
 */
function scoreNode(node: GraphNode, filter: KnowledgeFilter): number {
  let score = 0;

  if (nodeMatchesTerms(node, filter.amplifiedEntities)) {
    score += 10;
  }
  if (nodeMatchesTerms(node, filter.attenuatedEntities)) {
    score -= 5;
  }
  if (typeof node.credibility === "number") {
    score += node.credibility * CREDIBILITY_SCORE_WEIGHT;
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

function truncateGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  maxNodes: number,
  maxEdges: number,
): { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] } {
  // Take the top-ranked nodes up to the cap.
  const primaryNodes = nodes.slice(0, maxNodes);
  const retainedUuids = new Set(primaryNodes.map((n) => n.uuid));

  // Keep only edges whose endpoints are both retained, then cap edge count.
  // Endpoint nodes can fall outside the primary slice (entity nodes are appended
  // after relevance-ranked memory nodes), so pull those endpoint nodes back into
  // the node set — still bounded by maxNodes — rather than dropping the edge.
  // This preserves the "no dangling endpoints" invariant (every edge endpoint is
  // a node present in the result) while ensuring real relations survive truncation.
  const byUuid = new Map(nodes.map((n) => [n.uuid, n]));
  const finalNodes: GraphNode[] = [...primaryNodes];
  const finalEdges: GraphEdge[] = [];

  for (const edge of edges) {
    if (finalEdges.length >= maxEdges) break;

    const endpointUuids = [edge.sourceNodeUuid, edge.targetNodeUuid];
    const missing = endpointUuids.filter((id) => !retainedUuids.has(id));

    // Adding both endpoints must not exceed the node cap; if it would, skip this
    // edge rather than overflow or admit a dangling endpoint.
    if (finalNodes.length + missing.length > maxNodes) continue;

    // Every endpoint must resolve to a real node we know about.
    const resolved = endpointUuids.every((id) => retainedUuids.has(id) || byUuid.has(id));
    if (!resolved) continue;

    for (const id of missing) {
      const node = byUuid.get(id);
      if (node === undefined) continue;
      finalNodes.push(node);
      retainedUuids.add(id);
    }
    finalEdges.push(edge);
  }

  return { nodes: finalNodes, edges: finalEdges };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches the complete knowledge graph for a user from Mem0 and returns a
 * truncated GraphView. Uses a broad query with graph enabled to retrieve as
 * many relations as possible, unless `options.scopeQuery` narrows it to a
 * seed/topic.
 *
 * Returned nodes are ranked by mem0 relevance score before truncation, so the
 * most relevant entities survive a maxNodes cut.
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
  const query = options?.scopeQuery?.trim() ? options.scopeQuery : BROAD_GRAPH_QUERY;

  let memories: readonly Mem0Memory[];
  let relations: readonly Mem0Relation[];

  try {
    const result = await mem0.search({
      query,
      userId,
      limit: maxNodes,
      enableGraph: true,
    });
    memories = result.memories;
    relations = result.relations;
  } catch (err) {
    log.error("getFullGraph: mem0.search failed — returning empty graph", {
      err,
      userId,
      breakerOpen: mem0.isUnavailable(),
    });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  if (memories.length === 0 && relations.length === 0) {
    log.info("getFullGraph: empty graph", {
      userId,
      memoryCount: 0,
      relationCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      scoped: query !== BROAD_GRAPH_QUERY,
      breakerOpen: mem0.isUnavailable(),
    });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  const raw = mem0ResultToGraphView(memories, relations);
  const rankedNodes = rankByRelevance(raw.nodes);
  const { nodes, edges } = truncateGraph(rankedNodes, raw.edges, maxNodes, maxEdges);
  const summary = buildSummary(nodes, edges);

  log.info("getFullGraph: done", {
    userId,
    memoryCount: memories.length,
    relationCount: relations.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    scoped: query !== BROAD_GRAPH_QUERY,
  });

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
  const query = options?.scopeQuery?.trim() ? options.scopeQuery : BROAD_GRAPH_QUERY;

  let memories: readonly Mem0Memory[];
  let relations: readonly Mem0Relation[];

  try {
    const result = await mem0.search({
      query,
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
      breakerOpen: mem0.isUnavailable(),
    });
    return { nodes: [], edges: [], summary: "No entities found in the knowledge graph." };
  }

  const raw = mem0ResultToGraphView(memories, relations);

  if (raw.nodes.length === 0) {
    log.info("getFilteredGraphView: empty graph", {
      userId,
      role,
      memoryCount: memories.length,
      relationCount: relations.length,
      nodeCount: 0,
      edgeCount: 0,
      scoped: query !== BROAD_GRAPH_QUERY,
    });
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

  // Step 3 — score and sort. Filter score (amplified/attenuated + credibility)
  // dominates; mem0 relevance breaks ties so seed-scoped relevance still steers
  // ordering when two nodes match the filter equally. `index` keeps it stable.
  const scored = afterExclude
    .map((node, index) => ({ node, index, score: scoreNode(node, filter) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ra = a.node.relevanceScore ?? -Infinity;
      const rb = b.node.relevanceScore ?? -Infinity;
      if (rb !== ra) return rb - ra;
      return a.index - b.index;
    });

  const sortedNodes = scored.map((s) => s.node);

  // Step 4 — truncate and retain connected edges
  const { nodes, edges } = truncateGraph(sortedNodes, raw.edges, maxNodes, maxEdges);
  const summary = buildSummary(nodes, edges);

  log.info("getFilteredGraphView: done", {
    userId,
    role,
    memoryCount: memories.length,
    relationCount: relations.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    scoped: query !== BROAD_GRAPH_QUERY,
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

    case "founder":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["user", "growth", "distribution", "market", "traction", "acquisition"],
        attenuatedEntities: ["equilibrium", "payoff", "theoretical"],
      };

    case "user_researcher":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["user", "pain", "review", "complaint", "behavior", "need", "workaround"],
        attenuatedEntities: ["strategy", "equilibrium", "game"],
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

    case "contrarian_investor":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["market", "timing", "trend", "shift", "regulation", "technology", "demographics"],
        attenuatedEntities: ["equilibrium", "payoff"],
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

    case "technical_architect":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["technology", "api", "ai", "infrastructure", "github", "open source", "technical"],
        attenuatedEntities: ["social", "sentiment", "coalition"],
      };

    case "designer":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["user", "experience", "design", "app", "interface", "behavior", "friction"],
        attenuatedEntities: ["equilibrium", "payoff", "coalition", "game"],
      };

    case "domain_expert":
      return {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["industry", "regulation", "healthcare", "fintech", "education", "enterprise", "compliance"],
        attenuatedEntities: ["evolutionary", "game", "nash"],
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
