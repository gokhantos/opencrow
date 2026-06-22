/**
 * neo4j-write-client.ts — WRITE-mode Bolt client for the graph outcome-feedback
 * loop (Phase 3 of the idea-funnel learning loop).
 *
 * Structural WRITE sibling of {@link ./neo4j-client} (Neo4jReadClient). It writes
 * the SAME live mem0 Neo4j graph the read client traverses, but ONLY the two new
 * artifacts this feature owns:
 *   1. (seed:Entity)-[:OPPORTUNITY_VALIDATED|:OPPORTUNITY_KILLED]->(:IdeaAnchor
 *      {runId}) edges carrying a numeric `weight`, idempotently MERGEd.
 *   2. `success_weight` / `exposure_count` properties SET on EXISTING `:Entity`
 *      seed nodes, plus a range index on `:Entity(success_weight)`.
 *
 * It NEVER creates or deletes `:Entity` nodes — those stay owned by the mem0
 * sidecar extractor and the weekly canonicalizer. It NEVER calls APOC / dbms
 * procedures, so it works under a least-privilege write user.
 *
 * Hard safety contract — this writes a graph fed by UNTRUSTED, app-store-review-
 * derived `:Entity` names (a graph-injection vector):
 *   - WRITE-mode sessions only (`session({ defaultAccessMode: WRITE })` +
 *     `session.executeWrite`).
 *   - PARAMETERIZED Cypher only. EVERY dynamic value (seed name, runId, verdict
 *     payload, weight, success_weight, exposure_count) travels as a bound
 *     `$param` — there is ZERO string interpolation of any dynamic value into the
 *     query text. The only interpolation allowed anywhere is numeric MODULE
 *     CONSTANTS (none are currently interpolated).
 *   - Relationship TYPES cannot be parameterized in Cypher, so the
 *     OPPORTUNITY_VALIDATED vs OPPORTUNITY_KILLED choice is a branch between TWO
 *     fully-static query-string constants — NEVER `"[:" + verdict + "]"`.
 *   - Every write method NEVER throws — it degrades to a silent no-op on a missing
 *     password, an open circuit breaker, a connection failure, a query error, or a
 *     timeout. The graph feedback loop is best-effort GUIDANCE, never on the
 *     critical path.
 *   - Password comes from `getSecret("NEO4J_PASSWORD")` and is NEVER logged.
 *
 * The `neo4j-driver` package is imported LAZILY (only when a write actually runs)
 * so a deployment with the feature OFF never loads it.
 */

import { getSecret } from "../../config/secrets";
import { createLogger } from "../../logger";

const log = createLogger("sige:neo4j-write-client");

// ─── Public Types ─────────────────────────────────────────────────────────────

/** A run-level seed→outcome edge to MERGE: which seed fed which run, and how the
 *  run's verdict scored it. `verdict` selects between two STATIC rel-type queries
 *  (it is NEVER interpolated); `weight` is a bound numeric param. */
export interface SeedOutcomeEdge {
  /** Source `:Entity` seed name (raw, untrusted graph text — bound as a $param). */
  readonly seedName: string;
  /** The pipeline run id the verdict belongs to (the IdeaAnchor key). */
  readonly runId: string;
  /** Aggregate run verdict for this seed: validated → reinforce, killed → avoid. */
  readonly verdict: "validated" | "killed";
  /** Signed numeric weight carried on the edge (already clamped by the caller). */
  readonly weight: number;
}

/** A materialized per-seed weight projection to SET on existing `:Entity` nodes. */
export interface SeedWeightProjection {
  /** `:Entity` seed name to project onto (bound as a $param). */
  readonly seedName: string;
  /** Decayed success weight (signed). Bound as a $param. */
  readonly successWeight: number;
  /** How many runs this seed has fed (novelty signal). Bound as a $param. */
  readonly exposureCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// How long the breaker stays fully open before letting a single probe through.
const BREAKER_COOLDOWN_MS = 30_000;

// ─── Cypher (parameterized; static query text) ────────────────────────────────

/**
 * Idempotent run→seed edge MERGE. Two FULLY-STATIC variants — the ONLY thing that
 * differs is the literal relationship type, because Cypher cannot parameterize a
 * rel type and we MUST NOT build it by string concatenation of a dynamic value.
 * The seed name, runId, and weight are ALL bound `$params`.
 *
 * MERGE on the (seed, anchor, rel) triple makes a re-run idempotent: the second
 * write of the same (seedName, runId, verdict) updates the weight in place rather
 * than creating a duplicate edge. The seed must already exist (MATCH, not MERGE)
 * — this client never creates `:Entity` nodes; the IdeaAnchor is MERGEd because it
 * is a NEW artifact node type this feature owns (never an `:Entity`).
 */
const UPSERT_VALIDATED_EDGE_CYPHER = `
MATCH (seed:Entity {name: $seedName})
MERGE (anchor:IdeaAnchor {runId: $runId})
MERGE (seed)-[edge:OPPORTUNITY_VALIDATED]->(anchor)
SET edge.weight = $weight
`;

const UPSERT_KILLED_EDGE_CYPHER = `
MATCH (seed:Entity {name: $seedName})
MERGE (anchor:IdeaAnchor {runId: $runId})
MERGE (seed)-[edge:OPPORTUNITY_KILLED]->(anchor)
SET edge.weight = $weight
`;

/**
 * Project a materialized per-seed weight onto an EXISTING `:Entity`. MATCH (never
 * MERGE) so we never create a node — an absent seed silently projects nothing.
 * success_weight + exposure_count are bound `$params`.
 */
const PROJECT_SEED_WEIGHT_CYPHER = `
MATCH (seed:Entity {name: $seedName})
SET seed.success_weight = $successWeight,
    seed.exposure_count = $exposureCount
`;

/**
 * Ensure a range index on `:Entity(success_weight)` so the read path's seed
 * ranking (which reads `success_weight`) is index-backed. `IF NOT EXISTS` makes it
 * idempotent and a plain CREATE INDEX needs no APOC/admin procedure.
 */
const ENSURE_WEIGHT_INDEX_CYPHER = `
CREATE INDEX entity_success_weight IF NOT EXISTS
FOR (n:Entity) ON (n.success_weight)
`;

// ─── Internal driver typing (structural — avoids a hard type dependency) ──────

interface Neo4jResult {
  records: unknown[];
}

interface Neo4jTransaction {
  run(query: string, params: Record<string, unknown>): Promise<Neo4jResult>;
}

interface Neo4jSession {
  executeWrite<T>(
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
  session: { WRITE: unknown };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A transport-level failure means Neo4j is unreachable (not configured, the
 * container is down, DNS/connection refused). These open the circuit breaker; a
 * structured server error (bad Cypher, auth) does not. Mirrors the read client.
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

// ─── Client ───────────────────────────────────────────────────────────────────

export class Neo4jWriteClient {
  private readonly boltUrl: string;
  private readonly user: string;
  private readonly queryTimeoutMs: number;

  // Lazily-created single shared driver. Loaded only on first write so a
  // feature-OFF deployment never imports neo4j-driver.
  private driver: Neo4jDriver | null = null;
  private mod: Neo4jModule | null = null;
  private connecting: Promise<Neo4jDriver | null> | null = null;

  // Circuit breaker (mirrors Neo4jReadClient): once a transport-level failure
  // proves Neo4j is unreachable, short-circuit subsequent writes instead of
  // re-dialing a dead endpoint. Half-open recovery after the cooldown.
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

  /** True while the circuit breaker is open (short-circuiting writes). */
  isUnavailable(): boolean {
    return this.unavailable;
  }

  /** Endpoint reachable → close the breaker. */
  private recordReachable(): void {
    if (this.unavailable) {
      log.info("Neo4j (write) reachable again — closing circuit breaker", {
        boltUrl: this.boltUrl,
      });
    }
    this.unavailable = false;
    this.openedAt = 0;
    this.probing = false;
  }

  /** Transport-level failure → (re)open the breaker and restart the cooldown. */
  private recordUnreachable(): void {
    if (!this.unavailable) {
      log.warn("Neo4j (write) unreachable — opening circuit breaker, skipping graph feedback", {
        boltUrl: this.boltUrl,
      });
    }
    this.unavailable = true;
    this.openedAt = Date.now();
    this.probing = false;
  }

  /** Lazily import the driver + create the shared driver instance. Single-flight
   *  via `connecting`. Returns null when the password is not configured. */
  private async getDriver(): Promise<Neo4jDriver | null> {
    if (this.driver) return this.driver;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const password = await getSecret("NEO4J_PASSWORD");
        if (!password) {
          log.warn("NEO4J_PASSWORD not configured — skipping graph feedback writes");
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
   * Run a unit of WRITE work inside ONE breaker-guarded, timeout-raced write
   * session. NEVER throws — returns false on a missing password / open breaker /
   * connection failure / query error / timeout, true on success. Every public
   * write method funnels through here so the never-throw + breaker contract lives
   * in exactly one place.
   */
  private async runWrite(work: (tx: Neo4jTransaction) => Promise<void>): Promise<boolean> {
    // Circuit breaker. While open, short-circuit — unless the cooldown elapsed and
    // no probe is in flight, in which case THIS write becomes the single probe.
    if (this.unavailable) {
      if (this.probing || Date.now() - this.openedAt < BREAKER_COOLDOWN_MS) {
        return false;
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
      log.warn("graph-feedback write: driver init failed (no-op)", { err });
      return false;
    }
    if (!driver || !this.mod) return false;

    const session = driver.session({ defaultAccessMode: this.mod.session.WRITE });
    try {
      await this.race(
        session.executeWrite(async (tx) => {
          await work(tx);
        }, { timeout: this.queryTimeoutMs }),
      );
      this.recordReachable();
      return true;
    } catch (err) {
      if (isConnectionError(err)) this.recordUnreachable();
      else if (this.probing) {
        this.probing = false;
        this.openedAt = Date.now();
      }
      if (this.unavailable) log.debug("graph-feedback write skipped (Neo4j unavailable)");
      else log.warn("graph-feedback write failed (no-op)", { err });
      return false;
    } finally {
      await session.close().catch(() => {});
    }
  }

  /**
   * Idempotently MERGE one run→seed outcome edge per event. The rel type is chosen
   * by a STATIC-query branch on `verdict` (never interpolated); seedName, runId,
   * and weight are bound `$params`. Best-effort: returns the number of edges
   * written; an empty input is a no-op (no session opened).
   */
  async upsertSeedOutcomeEdges(events: readonly SeedOutcomeEdge[]): Promise<number> {
    if (events.length === 0) return 0;
    let written = 0;
    const ok = await this.runWrite(async (tx) => {
      for (const event of events) {
        // STATIC query per rel type — the dynamic verdict ONLY selects which
        // constant string runs; it is NEVER spliced into the Cypher text.
        const query =
          event.verdict === "validated"
            ? UPSERT_VALIDATED_EDGE_CYPHER
            : UPSERT_KILLED_EDGE_CYPHER;
        await tx.run(query, {
          seedName: event.seedName,
          runId: event.runId,
          weight: event.weight,
        });
        written += 1;
      }
    });
    if (ok) {
      log.debug("upsertSeedOutcomeEdges done", { events: events.length, written });
      return written;
    }
    return 0;
  }

  /**
   * Project materialized per-seed weights onto existing `:Entity` seeds and ensure
   * the supporting range index. Each row's success_weight / exposure_count are
   * bound `$params`. Best-effort: returns the number of seeds projected; an empty
   * input still ensures the index (cheap, idempotent) so the read path is
   * index-backed before the first projection.
   */
  async projectSeedWeights(rows: readonly SeedWeightProjection[]): Promise<number> {
    let projected = 0;
    const ok = await this.runWrite(async (tx) => {
      // Ensure the range index first so the read-path seed ranking is index-backed
      // even on the very first (possibly empty) projection.
      await tx.run(ENSURE_WEIGHT_INDEX_CYPHER, {});
      for (const row of rows) {
        await tx.run(PROJECT_SEED_WEIGHT_CYPHER, {
          seedName: row.seedName,
          successWeight: row.successWeight,
          exposureCount: row.exposureCount,
        });
        projected += 1;
      }
    });
    if (ok) {
      log.debug("projectSeedWeights done", { rows: rows.length, projected });
      return projected;
    }
    return 0;
  }

  /** Hard timeout fallback: reject if the underlying promise outlives the
   *  configured ceiling, so a hung Bolt connection degrades to a no-op. */
  private race<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Neo4j write timed out")),
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
