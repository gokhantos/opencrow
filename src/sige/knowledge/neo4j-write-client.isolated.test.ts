/**
 * Isolated tests for the WRITE-mode Neo4j client (graph outcome feedback, P3).
 *
 * Filed as *.isolated.test.ts because `mock.module` stubs BOTH `neo4j-driver`
 * (so no real Bolt connection is dialed) and `../../config/secrets` (so
 * NEO4J_PASSWORD resolves deterministically). The mock driver is programmable
 * per-test so we can drive the success path, a connection failure, and a missing
 * password through ONE stub.
 *
 * Asserts the hard safety contract the security reviewer flagged as a blocker:
 *   - WRITE mode only: executeWrite IS called, executeRead is NOT.
 *   - The rel types written are EXACTLY OPPORTUNITY_VALIDATED / OPPORTUNITY_KILLED
 *     (uppercase, never lowercased — the sidecar lowercases at write, so this
 *     client's static query strings are the guarantee).
 *   - EVERY dynamic value (seed name, runId, weight, success_weight,
 *     exposure_count) is in the params object, and the query STRING contains NO
 *     seed-name / weight substring → no string interpolation of dynamic values.
 *   - FUZZ: a malicious seed_name appears ONLY in params, never in the query text.
 *   - Connection error → silent no-op (no throw); missing password → no-op.
 *
 * NOTE: mock.module must register BEFORE the unit under test is imported.
 */

import { mock, test, expect, describe, beforeEach } from "bun:test";

// ── secrets stub: NEO4J_PASSWORD resolves to a fixed value ───────────────────
let password: string | undefined = "test-password";
mock.module("../../config/secrets", () => ({
  getSecret: async (key: string) => (key === "NEO4J_PASSWORD" ? password : undefined),
}));

// ── neo4j-driver stub: programmable per-test ─────────────────────────────────
interface Captured {
  readonly sessionConfigs: unknown[];
  readonly queries: { query: string; params: Record<string, unknown> }[];
  readonly txConfigs: unknown[];
  authCalls: { user: string; password: string }[];
  closed: number;
  sessionClosed: number;
  executeReadCalled: boolean;
  executeWriteCalled: boolean;
}

const captured: Captured = {
  sessionConfigs: [],
  queries: [],
  txConfigs: [],
  authCalls: [],
  closed: 0,
  sessionClosed: 0,
  executeReadCalled: false,
  executeWriteCalled: false,
};

let mode: "ok" | "connError" | "hang" = "ok";
// Count the prune's `count(a) AS deleted` record returns (per-test).
let pruneDeleted = 0;

const WRITE_SENTINEL = { __mode: "WRITE" };

mock.module("neo4j-driver", () => ({
  auth: {
    basic: (user: string, pw: string) => {
      captured.authCalls.push({ user, password: pw });
      return { user };
    },
  },
  session: { WRITE: WRITE_SENTINEL, READ: { __mode: "READ" } },
  driver: () => ({
    session: (config: { defaultAccessMode: unknown }) => {
      captured.sessionConfigs.push(config.defaultAccessMode);
      return {
        executeRead: async () => {
          captured.executeReadCalled = true;
          return undefined;
        },
        executeWrite: async (
          work: (tx: {
            run: (q: string, p: Record<string, unknown>) => Promise<unknown>;
          }) => Promise<unknown>,
          txConfig: unknown,
        ) => {
          captured.executeWriteCalled = true;
          captured.txConfigs.push(txConfig);
          if (mode === "connError") {
            const err = new Error("Could not perform discovery. No routing servers available.");
            err.name = "ServiceUnavailable";
            throw err;
          }
          const tx = {
            run: async (q: string, p: Record<string, unknown>) => {
              captured.queries.push({ query: q, params: p });
              if (mode === "hang") return new Promise(() => {});
              // Prune returns a `count(a) AS deleted` record (a neo4j Integer in
              // prod; here a plain object exposing .get + .toNumber to exercise both
              // extraction branches).
              if (q.includes("DETACH DELETE")) {
                return {
                  records: [
                    {
                      get: (key: string) =>
                        key === "deleted" ? { toNumber: () => pruneDeleted } : undefined,
                    },
                  ],
                };
              }
              return { records: [] };
            },
          };
          return work(tx);
        },
        close: async () => {
          captured.sessionClosed += 1;
        },
      };
    },
    close: async () => {
      captured.closed += 1;
    },
  }),
}));

// Import AFTER mocks are registered.
import { Neo4jWriteClient } from "./neo4j-write-client";

function freshClient(timeoutMs = 5_000) {
  return new Neo4jWriteClient({
    boltUrl: "bolt://127.0.0.1:7687",
    user: "neo4j",
    queryTimeoutMs: timeoutMs,
  });
}

beforeEach(() => {
  captured.sessionConfigs.length = 0;
  captured.queries.length = 0;
  captured.txConfigs.length = 0;
  captured.authCalls.length = 0;
  captured.closed = 0;
  captured.sessionClosed = 0;
  captured.executeReadCalled = false;
  captured.executeWriteCalled = false;
  mode = "ok";
  password = "test-password";
  pruneDeleted = 0;
});

describe("Neo4jWriteClient.upsertSeedOutcomeEdges — write contract", () => {
  test("uses a WRITE-mode session and executeWrite, NEVER executeRead", async () => {
    const client = freshClient();
    await client.upsertSeedOutcomeEdges([
      { seedName: "slow sync", runId: "run-1", verdict: "validated", weight: 1, createdAtSec: 1000 },
    ]);

    expect(captured.sessionConfigs).toEqual([WRITE_SENTINEL]);
    expect(captured.executeWriteCalled).toBe(true);
    expect(captured.executeReadCalled).toBe(false);
    await client.close();
  });

  test("writes EXACTLY uppercase OPPORTUNITY_VALIDATED / OPPORTUNITY_KILLED rel types", async () => {
    const client = freshClient();
    await client.upsertSeedOutcomeEdges([
      { seedName: "good seed", runId: "run-1", verdict: "validated", weight: 2, createdAtSec: 1000 },
      { seedName: "bad seed", runId: "run-1", verdict: "killed", weight: -2, createdAtSec: 1000 },
    ]);

    expect(captured.queries.length).toBe(2);
    const [q1, q2] = captured.queries;
    // Uppercase canonical rel types — never lowercased.
    expect(q1!.query).toContain("[edge:OPPORTUNITY_VALIDATED]");
    expect(q2!.query).toContain("[edge:OPPORTUNITY_KILLED]");
    // Regression guard: no lowercase rel type ever appears.
    expect(q1!.query).not.toContain("opportunity_validated");
    expect(q2!.query).not.toContain("opportunity_killed");
    // The verdict string itself is NOT interpolated as a rel type.
    expect(q1!.query).not.toContain("[:validated]");
    expect(q2!.query).not.toContain("[:killed]");
    await client.close();
  });

  test("binds every dynamic value as a $param — none interpolated into Cypher", async () => {
    const client = freshClient();
    await client.upsertSeedOutcomeEdges([
      {
        seedName: "slow sync",
        runId: "run-xyz",
        verdict: "validated",
        weight: 3.5,
        createdAtSec: 1717000000,
      },
    ]);

    const { query, params } = captured.queries[0]!;
    // The query references $params, NOT the literal caller values.
    expect(query).toContain("$seedName");
    expect(query).toContain("$runId");
    expect(query).toContain("$weight");
    expect(query).toContain("$createdAtSec");
    // The dynamic values must NOT appear as literals in the query text.
    expect(query).not.toContain("slow sync");
    expect(query).not.toContain("run-xyz");
    expect(query).not.toContain("3.5");
    // They live in the bound params instead.
    expect(params.seedName).toBe("slow sync");
    expect(params.runId).toBe("run-xyz");
    expect(params.weight).toBe(3.5);
    expect(params.createdAtSec).toBe(1717000000);
    await client.close();
  });

  test("stamps the anchor creation time via ON CREATE SET createdAtSec (bound, never re-stamped)", async () => {
    const client = freshClient();
    await client.upsertSeedOutcomeEdges([
      { seedName: "seed", runId: "run-1", verdict: "validated", weight: 1, createdAtSec: 4242 },
    ]);

    const { query, params } = captured.queries[0]!;
    // ON CREATE SET stamps the time only the first time the anchor MERGEs — never
    // on a re-run of the same runId. The value is a bound $param, not interpolated.
    expect(query).toContain("ON CREATE SET anchor.createdAtSec = $createdAtSec");
    expect(query).not.toContain("4242");
    expect(params.createdAtSec).toBe(4242);
    await client.close();
  });

  test("FUZZ: an injection-shaped seed_name appears ONLY in params, never in query text", async () => {
    const client = freshClient();
    // A malicious name carrying backticks, the MERGE param delimiter, a DETACH
    // DELETE payload, and a Cypher `//` comment. If ANY of it reached the query
    // text, the graph could be injected/destroyed.
    const evil = "x`}) DETACH DELETE n //";
    await client.upsertSeedOutcomeEdges([
      { seedName: evil, runId: "run-1", verdict: "killed", weight: -1, createdAtSec: 1000 },
    ]);

    const { query, params } = captured.queries[0]!;
    // The malicious string is bound verbatim as a param…
    expect(params.seedName).toBe(evil);
    // …and NONE of its injected fragments leak into the executable query text.
    // (A bare `})` is legitimate Cypher — e.g. `{runId: $runId})` — so we assert
    // on the malicious payload fragments, not on that token.)
    expect(query).not.toContain(evil);
    expect(query).not.toContain("DETACH DELETE");
    expect(query).not.toContain("`");
    await client.close();
  });

  test("empty events → no session opened, no query, returns 0", async () => {
    const client = freshClient();
    const n = await client.upsertSeedOutcomeEdges([]);
    expect(n).toBe(0);
    expect(captured.executeWriteCalled).toBe(false);
    expect(captured.queries.length).toBe(0);
    await client.close();
  });

  test("a connection error → 0 and silent no-op (never throws), opens the breaker", async () => {
    mode = "connError";
    const client = freshClient();

    const n = await client.upsertSeedOutcomeEdges([
      { seedName: "s", runId: "run-1", verdict: "validated", weight: 1, createdAtSec: 1000 },
    ]);
    expect(n).toBe(0);
    expect(client.isUnavailable()).toBe(true);

    // Breaker open → the next write short-circuits without running a query.
    const queriesBefore = captured.queries.length;
    const n2 = await client.upsertSeedOutcomeEdges([
      { seedName: "s2", runId: "run-2", verdict: "killed", weight: -1, createdAtSec: 1000 },
    ]);
    expect(n2).toBe(0);
    expect(captured.queries.length).toBe(queriesBefore);
    await client.close();
  });

  test("missing NEO4J_PASSWORD → no-op (no driver dialed, no query)", async () => {
    password = undefined;
    const client = freshClient();
    const n = await client.upsertSeedOutcomeEdges([
      { seedName: "s", runId: "run-1", verdict: "validated", weight: 1, createdAtSec: 1000 },
    ]);
    expect(n).toBe(0);
    expect(captured.queries.length).toBe(0);
    expect(captured.executeWriteCalled).toBe(false);
    await client.close();
  });
});

describe("Neo4jWriteClient.projectSeedWeights — projection contract", () => {
  test("ensures the range index then SETs success_weight/exposure_count as $params", async () => {
    const client = freshClient();
    const projected = await client.projectSeedWeights([
      { seedName: "good seed", successWeight: 2.5, exposureCount: 4 },
    ]);

    expect(projected).toBe(1);
    expect(captured.sessionConfigs).toEqual([WRITE_SENTINEL]);
    expect(captured.executeReadCalled).toBe(false);
    // First query ensures the index; second projects the weight.
    expect(captured.queries.length).toBe(2);
    expect(captured.queries[0]!.query).toContain("CREATE INDEX entity_success_weight IF NOT EXISTS");
    const proj = captured.queries[1]!;
    expect(proj.query).toContain("$successWeight");
    expect(proj.query).toContain("$exposureCount");
    expect(proj.query).toContain("$seedName");
    // Never MERGE a node — projection MATCHes existing :Entity only.
    expect(proj.query).toContain("MATCH (seed:Entity {name: $seedName})");
    expect(proj.query).not.toContain("MERGE (seed");
    expect(proj.params.successWeight).toBe(2.5);
    expect(proj.params.exposureCount).toBe(4);
    expect(proj.params.seedName).toBe("good seed");
    await client.close();
  });

  test("empty rows still ensures the index (idempotent) and never throws", async () => {
    const client = freshClient();
    const projected = await client.projectSeedWeights([]);
    expect(projected).toBe(0);
    expect(captured.queries.length).toBe(1);
    expect(captured.queries[0]!.query).toContain("CREATE INDEX entity_success_weight IF NOT EXISTS");
    await client.close();
  });

  test("FUZZ: an injection-shaped seed_name in a projection stays in params only", async () => {
    const client = freshClient();
    const evil = "y`}) DETACH DELETE n //";
    await client.projectSeedWeights([{ seedName: evil, successWeight: 1, exposureCount: 1 }]);

    const proj = captured.queries[1]!;
    expect(proj.params.seedName).toBe(evil);
    expect(proj.query).not.toContain(evil);
    expect(proj.query).not.toContain("DETACH DELETE");
    expect(proj.query).not.toContain("`");
    await client.close();
  });
});

describe("Neo4jWriteClient.pruneIdeaAnchors — retention prune contract", () => {
  test("runs a STATIC parameterized DETACH DELETE with the cutoff bound as $cutoff", async () => {
    pruneDeleted = 7;
    const client = freshClient();
    const deleted = await client.pruneIdeaAnchors(1717000000);

    // WRITE session only — never a read.
    expect(captured.sessionConfigs).toEqual([WRITE_SENTINEL]);
    expect(captured.executeWriteCalled).toBe(true);
    expect(captured.executeReadCalled).toBe(false);

    expect(captured.queries.length).toBe(1);
    const { query, params } = captured.queries[0]!;
    // The cutoff is BOUND as $cutoff — never interpolated into the query text.
    expect(query).toContain("$cutoff");
    expect(query).toContain("MATCH (a:IdeaAnchor)");
    expect(query).toContain("DETACH DELETE a");
    expect(query).not.toContain("1717000000");
    expect(params.cutoff).toBe(1717000000);
    // The deleted count is read back from the result record.
    expect(deleted).toBe(7);
    await client.close();
  });

  test("a connection error → 0 and silent no-op (never throws), opens the breaker", async () => {
    mode = "connError";
    const client = freshClient();
    const deleted = await client.pruneIdeaAnchors(1000);
    expect(deleted).toBe(0);
    expect(client.isUnavailable()).toBe(true);
    await client.close();
  });

  test("missing NEO4J_PASSWORD → 0 (no driver dialed, no query)", async () => {
    password = undefined;
    const client = freshClient();
    const deleted = await client.pruneIdeaAnchors(1000);
    expect(deleted).toBe(0);
    expect(captured.queries.length).toBe(0);
    expect(captured.executeWriteCalled).toBe(false);
    await client.close();
  });
});
