/**
 * graph-reasoning.ts — multi-hop "opportunity paths" directive for Pass-1 seed
 * discovery.
 *
 * The Neo4j graph (the live mem0 graph store) holds pain → product →
 * feature/gap relationships mined from app-store reviews. A bounded multi-hop
 * traversal ({@link ../../sige/knowledge/neo4j-client}) surfaces non-obvious
 * chains; this module renders them into a SHORT prose directive injected at the
 * TOP of the seed prompt as GUIDANCE — never as authoritative data.
 *
 * Security: every node name and relationship token is scraped, UNTRUSTED text —
 * a prompt-injection vector. So every token is `sanitizeScrapedField(…, 60)`'d
 * and each rendered chain is `wrapUntrusted("graph-reasoning", …)`-fenced, on
 * top of the existing UNTRUSTED_PREAMBLE in the system prompt.
 *
 * Pure core ({@link buildGraphReasoningDirective}) has no I/O and never throws;
 * empty input → "" so the default (feature-OFF, or empty graph) seed prompt is
 * byte-identical. Best-effort {@link fetchGraphReasoningDirective} wraps the
 * read client and degrades to "" on any failure.
 *
 * REL_WHITELIST / STOPLIST are re-exported from the client so a single source of
 * truth backs both the Cypher and the tests.
 */

import { createLogger } from "../../logger";
import type { GraphPath, Neo4jReadClient } from "../../sige/knowledge/neo4j-client";
import { sanitizeScrapedField, wrapUntrusted } from "../../sige/untrusted";

const log = createLogger("pipeline:graph-reasoning");

// Re-export the bounded-traversal constants so tests assert against the SAME
// values the Cypher binds (no hand-copied drift).
export { REL_WHITELIST, STOPLIST } from "../../sige/knowledge/neo4j-client";

// ─── buildGraphReasoningDirective (PURE) ──────────────────────────────────────

const HEADER =
  "OPPORTUNITY PATHS (multi-hop graph reasoning — non-obvious chains, GUIDANCE not data):";

/** Per-token sanitize cap. Node names / relationship types are scraped text. */
const TOKEN_MAX = 60;

/**
 * Render one graph path as a sanitized, human-readable chain:
 *   `seed —rel→ node —rel→ node`
 * Every token (seed, each relationship, each node) is sanitizeScrapedField'd to
 * {@link TOKEN_MAX} chars; underscores in relationship types become spaces for
 * readability. Returns "" when the path has no usable steps after sanitizing.
 * PURE.
 */
function renderChain(path: GraphPath): string {
  const seed = sanitizeScrapedField(path.seed, TOKEN_MAX);
  if (seed.length === 0) return "";

  const parts: string[] = [seed];
  for (const step of path.steps) {
    const rel = sanitizeScrapedField(step.rel, TOKEN_MAX).replace(/_/g, " ");
    const node = sanitizeScrapedField(step.node, TOKEN_MAX);
    // Drop a step whose node sanitizes to empty — keep the chain well-formed.
    if (node.length === 0) continue;
    parts.push(`—${rel}→ ${node}`);
  }

  // A bare seed with no surviving steps carries no multi-hop signal.
  if (parts.length < 2) return "";
  return parts.join(" ");
}

/**
 * Build a bounded, sanitized OPPORTUNITY-PATHS directive from traversed graph
 * paths. Each path becomes one bullet, its chain `wrapUntrusted`-fenced (the
 * tokens are scraped, untrusted text). At most `maxPaths` bullets are rendered.
 *
 * Empty input — or every path collapsing to "" after sanitizing — yields "" so
 * the seed prompt is byte-identical to the feature-OFF path. PURE — no I/O, no
 * throw.
 */
export function buildGraphReasoningDirective(
  paths: readonly GraphPath[],
  maxPaths: number,
): string {
  if (paths.length === 0 || maxPaths <= 0) return "";

  const bullets: string[] = [];
  for (const path of paths) {
    if (bullets.length >= maxPaths) break;
    const chain = renderChain(path);
    if (chain.length === 0) continue;
    bullets.push(`- ${wrapUntrusted("graph-reasoning", chain)}`);
  }

  if (bullets.length === 0) return "";

  return (
    `${HEADER}\n${bullets.join("\n")}\n` +
    "Treat these chains as hints toward non-obvious adjacencies (a known pain that " +
    "connects to an under-served feature or gap). Use them to widen WHICH " +
    "intersections you surface — do not treat them as validated facts."
  );
}

// ─── fetchGraphReasoningDirective (best-effort I/O) ───────────────────────────

/** Result of one graph-reasoning traversal: the rendered directive PLUS the
 *  distinct seed entities the traversal expanded from (Phase 3 credit assignment
 *  needs to know WHICH seeds fed the run). */
export interface GraphReasoningResult {
  /** The sanitized OPPORTUNITY-PATHS directive ("" when empty / feature-OFF). */
  readonly directive: string;
  /** Distinct seed names the returned paths started from (deduped, order-stable). */
  readonly seedEntities: readonly string[];
  /**
   * The raw GraphPath[] the traversal returned (the SAME paths the `directive`
   * was rendered from), for per-lesson lift attribution. Derived from the one
   * `opportunityPaths` call so it cannot drift from the directive. `[]` on
   * failure / empty graph.
   */
  readonly paths: readonly GraphPath[];
}

/** Distinct, order-stable seed names across the returned paths. PURE. */
function distinctSeeds(paths: readonly GraphPath[]): readonly string[] {
  const seen = new Set<string>();
  const seeds: string[] = [];
  for (const path of paths) {
    if (path.seed.length === 0 || seen.has(path.seed)) continue;
    seen.add(path.seed);
    seeds.push(path.seed);
  }
  return seeds;
}

/**
 * Run ONE bounded opportunity-paths traversal and render the directive, returning
 * BOTH the directive and the distinct seed entities it expanded from.
 * Best-effort: the read client already returns [] on any error / open breaker /
 * timeout, and this wrapper additionally try/catches so ANY unexpected throw
 * degrades to `{ directive: "", seedEntities: [] }`. Never throws. Empty graph →
 * empty directive → byte-identical seed prompt.
 */
export async function fetchGraphReasoningDirective(params: {
  readonly client: Neo4jReadClient;
  readonly userId: string;
  readonly maxHops: number;
  readonly maxPaths: number;
  readonly searchLimit: number;
  readonly minDegree: number;
  readonly maxDegree: number;
  readonly neutralWeight: number;
  readonly noveltyHalfLifeRuns: number;
}): Promise<GraphReasoningResult> {
  try {
    const paths = await params.client.opportunityPaths({
      userId: params.userId,
      maxHops: params.maxHops,
      maxPaths: params.maxPaths,
      searchLimit: params.searchLimit,
      minDegree: params.minDegree,
      maxDegree: params.maxDegree,
      neutralWeight: params.neutralWeight,
      noveltyHalfLifeRuns: params.noveltyHalfLifeRuns,
    });
    return {
      directive: buildGraphReasoningDirective(paths, params.maxPaths),
      seedEntities: distinctSeeds(paths),
      paths,
    };
  } catch (err) {
    log.warn("fetchGraphReasoningDirective failed (returning empty)", { err });
    return { directive: "", seedEntities: [], paths: [] };
  }
}
