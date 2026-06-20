/**
 * neo4j-client.ts — read-only Bolt client over the live mem0 Neo4j graph.
 *
 * Structural sibling of {@link ../knowledge/mem0-client}. It queries the SAME
 * Neo4j instance mem0 writes its graph store to (no ETL, no second copy) to
 * surface bounded multi-hop "opportunity paths" (pain → product → adjacent
 * feature/gap chains) for idea synthesis.
 *
 * Hard safety contract — this is read-only graph traversal over UNTRUSTED,
 * app-store-review-derived data:
 *   - READ-mode sessions only (`session({ defaultAccessMode: READ })` +
 *     `session.executeRead`). The client NEVER issues a write transaction.
 *   - PARAMETERIZED Cypher only. No caller value is ever interpolated into the
 *     query text — every bound value (degree caps, hop count, stoplist regex,
 *     relationship whitelist, userId) travels as a `$param`.
 *   - Per-query transaction `{ timeout }` PLUS a JS `Promise.race` fallback so a
 *     hung Bolt connection can't stall the pipeline past the configured ceiling.
 *   - `opportunityPaths()` NEVER throws — it returns `[]` on any error, on an
 *     open circuit breaker, or on a timeout. The graph is GUIDANCE, never
 *     authoritative, so degrade-to-empty is correct.
 *   - Cycle rejection (a node name appearing twice in a path) is done in the JS
 *     mapper — no APOC dependency on the server.
 *   - Password comes from `getSecret("NEO4J_PASSWORD")` and is NEVER logged.
 *
 * The `neo4j-driver` package is imported LAZILY (only when a query actually
 * runs) so a deployment with the feature OFF never loads it.
 */

import { getSecret } from "../../config/secrets";
import { createLogger } from "../../logger";

const log = createLogger("sige:neo4j-client");

// ─── Public Types ─────────────────────────────────────────────────────────────

/** One step in an opportunity path: a typed relationship into a named node. */
export interface GraphStep {
  /** Relationship type traversed to reach this node (already whitelist-filtered). */
  readonly rel: string;
  /** Destination node name (raw graph text — sanitize before any prompt use). */
  readonly node: string;
}

/** One bounded multi-hop opportunity path: a seed node + its ordered steps. */
export interface GraphPath {
  /** The seed (pain) node name the traversal started from. */
  readonly seed: string;
  /** Ordered steps from the seed to the destination (length ≥ 1). */
  readonly steps: readonly GraphStep[];
}

/** Parameters for one opportunity-paths traversal. All caps are bound as $params. */
export interface OpportunityPathsParams {
  /** mem0 graph user_id partition to constrain every node to (e.g. "sige-global"). */
  readonly userId: string;
  /** Max hops in a path (path length). */
  readonly maxHops: number;
  /** Max paths returned by the query. */
  readonly maxPaths: number;
  /** How many seed (pain) nodes to expand from. */
  readonly searchLimit: number;
  /** Lower degree bound on the seed node (skips one-off leaf noise). */
  readonly minDegree: number;
  /** Upper degree bound on EVERY path node (suppresses hubs). */
  readonly maxDegree: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Relationship types that carry a meaningful pain → product → feature/gap
 * signal. Every relationship on a returned path MUST be in this whitelist — the
 * sige-global graph is hub/noise-heavy, and unconstrained traversal routes junk
 * through artifact edges. Bound into the query as `$relWhitelist`.
 */
export const REL_WHITELIST: readonly string[] = [
  "complained_about",
  "complaint_about",
  "complains_about",
  "has_issue",
  "lacks",
  "has_feature",
  "provides",
  "offers",
  "includes",
  "supports",
  "uses",
  "category",
  "available_on",
];

/**
 * Case-insensitive regex (passed as `$stoplist` and applied server-side via
 * `=~ '(?i)' + $stoplist`) that excludes hub/artifact/rating nodes from BOTH
 * the seed set and every traversed node:
 *   - `^(app_store|play_store|sige-global)$` — the deg-565/750 store hubs + the
 *     partition-name artifact node.
 *   - `^user_id:` — mem0 user_id artifact nodes (~1200 of them).
 *   - a "digits slash digits" anchor — "1/5", "3 / 5" rating-fraction nodes
 *     (deg-408 et al).
 *   - a "digits optional-decimal optional-star" anchor — "4", "4.5 stars"
 *     rating nodes.
 * See {@link STOPLIST} below for the exact regex source.
 */
export const STOPLIST: string =
  "^(app_store|play_store|sige-global)$" +
  "|^user_id:" +
  "|^\\d+\\s*/\\s*\\d+$" +
  "|^\\d+(\\.\\d+)?\\s*(star|stars)?$";

// How long the breaker stays fully open before letting a single probe through.
const BREAKER_COOLDOWN_MS = 30_000;

// ─── Internal driver typing (structural — avoids a hard type dependency) ──────

interface Neo4jRecord {
  get(key: string): unknown;
}

interface Neo4jResult {
  records: Neo4jRecord[];
}

interface Neo4jTransaction {
  run(query: string, params: Record<string, unknown>): Promise<Neo4jResult>;
}

interface Neo4jSession {
  executeRead<T>(
    work: (tx: Neo4jTransaction) => Promise<T>,
    config?: { timeout?: number },
  ): Promise<T>;
  close(): Promise<void>;
}

interface Neo4jDriver {
  session(config: { defaultAccessMode: unknown }): Neo4jSession;
  close(): Promise<void>;
}

interface Neo4jModule {
  driver(url: string, auth: unknown): Neo4jDriver;
  auth: { basic(user: string, password: string): unknown };
  session: { READ: unknown };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A transport-level failure means Neo4j is unreachable (not configured, the
 * container is down, DNS/connection refused). These open the circuit breaker;
 * a structured server error (bad Cypher, auth) does not.
 */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  const msg = err.message.toLowerCase();
  return (
    name === "connectionrefused" ||
    name === "typeerror" ||
    name.includes("serviceunavailable") ||
    name.includes("sessionexpired") ||
    msg.includes("unable to connect") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("could not perform discovery") ||
    msg.includes("failed to connect") ||
    msg.includes("connection acquisition timed out")
  );
}

/** Coerce one raw `path` cell (a list of {rel, node} maps) into a GraphPath, or
 *  null when it is malformed, empty, or CYCLIC (a node name appears twice). The
 *  seed is taken from the bound `seedName` cell. PURE — no driver dependency. */
function toGraphPath(seedName: unknown, rawSteps: unknown): GraphPath | null {
  if (typeof seedName !== "string" || seedName.length === 0) return null;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return null;

  const steps: GraphStep[] = [];
  // Cycle detection: the seed plus every destination node must be distinct.
  const seen = new Set<string>([seedName]);

  for (const raw of rawSteps) {
    if (typeof raw !== "object" || raw === null) return null;
    const rel = (raw as Record<string, unknown>).rel;
    const node = (raw as Record<string, unknown>).node;
    if (typeof rel !== "string" || typeof node !== "string") return null;
    if (rel.length === 0 || node.length === 0) return null;
    // Reject the whole path on any repeated node name (a cycle).
    if (seen.has(node)) return null;
    seen.add(node);
    steps.push({ rel, node });
  }

  return { seed: seedName, steps };
}

// ─── Cypher (parameterized; static query text) ────────────────────────────────

/**
 * Single bounded read query. Seeds on mid-degree pain entities, traverses 2..N
 * whitelisted relationships to a same-partition destination through nodes that
 * are all same-partition, non-stoplisted, and below the degree cap, then returns
 * the seed name + an ordered step list. EVERY caller value is a $param — no
 * interpolation. `(?i)` makes the stoplist regex case-insensitive server-side.
 */
const OPPORTUNITY_PATHS_CYPHER = `
MATCH (pain {user_id: $userId})
WHERE COUNT { (pain)--() } >= $minDegree
  AND COUNT { (pain)--() } <= $maxDegree
  AND NOT pain.name =~ ('(?i)' + $stoplist)
  AND any(r IN [(pain)-[rr]-() | type(rr)] WHERE r IN $relWhitelist)
WITH pain, COUNT { (pain)--() } AS deg
ORDER BY deg DESC
LIMIT toInteger($searchLimit)
MATCH path = (pain)-[rels*2..]-(dest {user_id: $userId})
WHERE length(path) <= toInteger($maxHops)
  AND all(r IN relationships(path) WHERE type(r) IN $relWhitelist)
  AND all(n IN nodes(path) WHERE
        n.user_id = $userId
        AND NOT n.name =~ ('(?i)' + $stoplist)
        AND COUNT { (n)--() } <= $maxDegree)
RETURN pain.name AS seed,
       [i IN range(1, length(path)) |
          { rel: type(relationships(path)[i - 1]),
            node: nodes(path)[i].name }] AS steps
LIMIT toInteger($maxPaths)
`;

// ─── Client ───────────────────────────────────────────────────────────────────

export class Neo4jReadClient {
  private readonly boltUrl: string;
  private readonly user: string;
  private readonly queryTimeoutMs: number;

  // Lazily-created single shared driver. Loaded only on first query so a
  // feature-OFF deployment never imports neo4j-driver.
  private driver: Neo4jDriver | null = null;
  private mod: Neo4jModule | null = null;
  private connecting: Promise<Neo4jDriver | null> | null = null;

  // Circuit breaker (mirrors Mem0Client): once a transport-level failure proves
  // Neo4j is unreachable, short-circuit subsequent queries instead of re-dialing
  // a dead endpoint on every synthesis. Half-open recovery: after the cooldown,
  // exactly one query is let through as a probe.
  private unavailable = false;
  private openedAt = 0;
  private probing = false;

  constructor(config: {
    readonly boltUrl: string;
    readonly user: string;
    readonly queryTimeoutMs: number;
  }) {
    this.boltUrl = config.boltUrl;
    this.user = config.user;
    this.queryTimeoutMs = config.queryTimeoutMs;
  }

  /** True while the circuit breaker is open (short-circuiting queries). */
  isUnavailable(): boolean {
    return this.unavailable;
  }

  /** Endpoint reachable → close the breaker. */
  private recordReachable(): void {
    if (this.unavailable) {
      log.info("Neo4j reachable again — closing circuit breaker", { boltUrl: this.boltUrl });
    }
    this.unavailable = false;
    this.openedAt = 0;
    this.probing = false;
  }

  /** Transport-level failure → (re)open the breaker and restart the cooldown. */
  private recordUnreachable(): void {
    if (!this.unavailable) {
      log.warn("Neo4j unreachable — opening circuit breaker, skipping graph reasoning", {
        boltUrl: this.boltUrl,
      });
    }
    this.unavailable = true;
    this.openedAt = Date.now();
    this.probing = false;
  }

  /** Lazily import the driver + create the shared (pool-size-1) driver instance.
   *  Single-flight via `connecting` so concurrent first queries share one dial.
   *  Returns null when the password is not configured (feature can't run). */
  private async getDriver(): Promise<Neo4jDriver | null> {
    if (this.driver) return this.driver;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const password = await getSecret("NEO4J_PASSWORD");
        if (!password) {
          log.warn("NEO4J_PASSWORD not configured — skipping graph reasoning");
          return null;
        }
        const mod = (await import("neo4j-driver")) as unknown as Neo4jModule;
        this.mod = mod;
        const driver = mod.driver(this.boltUrl, mod.auth.basic(this.user, password));
        this.driver = driver;
        return driver;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  /**
   * Run one bounded, read-only opportunity-paths traversal. NEVER throws —
   * returns `[]` on a missing password, an open breaker, a connection failure,
   * a query error, or a timeout. The result is cycle-filtered in the JS mapper.
   */
  async opportunityPaths(params: OpportunityPathsParams): Promise<readonly GraphPath[]> {
    // Circuit breaker. While open, short-circuit — unless the cooldown has
    // elapsed and no probe is in flight, in which case THIS query becomes the
    // single half-open probe (synchronous check-and-set).
    if (this.unavailable) {
      if (this.probing || Date.now() - this.openedAt < BREAKER_COOLDOWN_MS) {
        return [];
      }
      this.probing = true;
    }

    let driver: Neo4jDriver | null;
    try {
      driver = await this.getDriver();
    } catch (err) {
      if (isConnectionError(err)) this.recordUnreachable();
      else if (this.probing) {
        this.probing = false;
        this.openedAt = Date.now();
      }
      log.warn("opportunityPaths: driver init failed (returning empty)", { err });
      return [];
    }
    if (!driver || !this.mod) return [];

    const session = driver.session({ defaultAccessMode: this.mod.session.READ });

    // Bind EVERY caller value as a parameter — nothing is interpolated into the
    // static query text above.
    const queryParams: Record<string, unknown> = {
      userId: params.userId,
      minDegree: params.minDegree,
      maxDegree: params.maxDegree,
      maxHops: params.maxHops,
      searchLimit: params.searchLimit,
      maxPaths: params.maxPaths,
      stoplist: STOPLIST,
      relWhitelist: [...REL_WHITELIST],
    };

    try {
      // READ transaction with a server-side `{ timeout }`, wrapped in a JS
      // Promise.race so even a connection that hangs before the server timeout
      // engages can't stall the caller past the ceiling.
      const result = await this.race(
        session.executeRead(
          (tx) => tx.run(OPPORTUNITY_PATHS_CYPHER, queryParams),
          { timeout: this.queryTimeoutMs },
        ),
      );

      this.recordReachable();

      const paths: GraphPath[] = [];
      for (const record of result.records) {
        const mapped = toGraphPath(record.get("seed"), record.get("steps"));
        if (mapped) paths.push(mapped);
      }

      log.debug("opportunityPaths: done", {
        userId: params.userId,
        returned: result.records.length,
        afterCycleFilter: paths.length,
      });

      return paths;
    } catch (err) {
      if (isConnectionError(err)) this.recordUnreachable();
      else if (this.probing) {
        this.probing = false;
        this.openedAt = Date.now();
      }
      if (this.unavailable) log.debug("opportunityPaths skipped (Neo4j unavailable)");
      else log.warn("opportunityPaths failed (returning empty)", { err });
      return [];
    } finally {
      await session.close().catch(() => {});
    }
  }

  /** Hard timeout fallback: reject if the underlying promise outlives the
   *  configured ceiling, so a hung Bolt connection degrades to []. */
  private race<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Neo4j query timed out")),
        this.queryTimeoutMs,
      );
    });
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    }) as Promise<T>;
  }

  /** Close the shared driver. Best-effort; safe to call when never connected. */
  async close(): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    this.mod = null;
    if (driver) await driver.close().catch(() => {});
  }
}
