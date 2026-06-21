/**
 * Isolated tests for the read-only Neo4j client.
 *
 * Filed as *.isolated.test.ts because `mock.module` stubs BOTH `neo4j-driver`
 * (so no real Bolt connection is dialed) and `../../config/secrets` (so
 * NEO4J_PASSWORD resolves deterministically without a DB/env dependency). The
 * mock driver is programmable per-test via module-level switches so we can drive
 * the success path, a connection failure, and a hung query through ONE stub.
 *
 * Asserts the hard safety contract: READ mode only (executeWrite never used),
 * NO caller value interpolated into the Cypher text (everything bound as a
 * $param), the per-query `{ timeout }` is forwarded, a connection error → [] +
 * an open breaker that short-circuits, a hung query → [] via the JS race
 * fallback, and the records → GraphPath mapping (incl. cycle drop).
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
// Records every interaction so the test can assert on access mode, query text,
// bound params, and the forwarded transaction config.
interface Captured {
  readonly sessionConfigs: unknown[];
  readonly queries: { query: string; params: Record<string, unknown> }[];
  readonly txConfigs: unknown[];
  authCalls: { user: string; password: string }[];
  closed: number;
  sessionClosed: number;
  executeWriteCalled: boolean;
}

const captured: Captured = {
  sessionConfigs: [],
  queries: [],
  txConfigs: [],
  authCalls: [],
  closed: 0,
  sessionClosed: 0,
  executeWriteCalled: false,
};

// Per-test behavior switches.
let mode: "ok" | "connError" | "hang" = "ok";
// The raw "records" the mock tx returns on the ok path (each a {seed, steps}).
let okRecords: Array<{ seed: unknown; steps: unknown }> = [];

const READ_SENTINEL = { __mode: "READ" };

function makeRecord(row: { seed: unknown; steps: unknown }) {
  return {
    get(key: string) {
      if (key === "seed") return row.seed;
      if (key === "steps") return row.steps;
      return undefined;
    },
  };
}

// The client imports neo4j-driver and uses its NAMED exports
// (`mod.driver` / `mod.auth` / `mod.session`), matching the real ESM namespace.
mock.module("neo4j-driver", () => ({
  auth: {
    basic: (user: string, pw: string) => {
      captured.authCalls.push({ user, password: pw });
      return { user };
    },
  },
  session: { READ: READ_SENTINEL },
  driver: () => ({
      session: (config: { defaultAccessMode: unknown }) => {
        captured.sessionConfigs.push(config.defaultAccessMode);
        return {
          executeRead: async (
            work: (tx: {
              run: (q: string, p: Record<string, unknown>) => Promise<unknown>;
            }) => Promise<unknown>,
            txConfig: unknown,
          ) => {
            captured.txConfigs.push(txConfig);
            if (mode === "connError") {
              const err = new Error("Could not perform discovery. No routing servers available.");
              err.name = "ServiceUnavailable";
              throw err;
            }
            const tx = {
              run: async (q: string, p: Record<string, unknown>) => {
                captured.queries.push({ query: q, params: p });
                if (mode === "hang") {
                  // Never resolves — the client's Promise.race must time out.
                  return new Promise(() => {});
                }
                return { records: okRecords.map(makeRecord) };
              },
            };
            return work(tx);
          },
          executeWrite: async () => {
            captured.executeWriteCalled = true;
            return { records: [] };
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
import { Neo4jReadClient, REL_WHITELIST, STOPLIST } from "./neo4j-client";

const PARAMS = {
  userId: "sige-global",
  maxHops: 3,
  maxPaths: 8,
  searchLimit: 25,
  minDegree: 3,
  maxDegree: 60,
} as const;

function freshClient(timeoutMs = 5_000) {
  return new Neo4jReadClient({
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
  captured.executeWriteCalled = false;
  mode = "ok";
  okRecords = [];
  password = "test-password";
});

describe("Neo4jReadClient.opportunityPaths — success path", () => {
  test("uses a READ-mode session and never a write transaction", async () => {
    okRecords = [{ seed: "slow sync", steps: [{ rel: "LACKS", node: "offline mode" }] }];
    const client = freshClient();
    await client.opportunityPaths(PARAMS);

    expect(captured.sessionConfigs).toEqual([READ_SENTINEL]);
    expect(captured.executeWriteCalled).toBe(false);
    await client.close();
  });

  test("binds every caller value as a $param — none interpolated into Cypher", async () => {
    okRecords = [{ seed: "p", steps: [{ rel: "LACKS", node: "f" }] }];
    const client = freshClient();
    await client.opportunityPaths(PARAMS);

    expect(captured.queries.length).toBe(1);
    const { query, params } = captured.queries[0]!;

    // The query text must reference $params, NOT the literal caller values.
    expect(query).toContain("$userId");
    expect(query).toContain("$maxHops");
    expect(query).toContain("$relWhitelist");
    expect(query).toContain("$stoplist");
    // No caller numeric/string value is spliced into the text.
    expect(query).not.toContain("sige-global");
    expect(query).not.toContain("60"); // maxDegree
    expect(query).not.toContain("25"); // searchLimit
    expect(query).not.toMatch(/app_store/); // stoplist body never in text

    // The bound params carry the actual values + the shared constants.
    expect(params.userId).toBe("sige-global");
    expect(params.maxHops).toBe(3);
    expect(params.maxDegree).toBe(60);
    expect(params.stoplist).toBe(STOPLIST);
    expect(params.relWhitelist).toEqual([...REL_WHITELIST]);
    await client.close();
  });

  test("query is index-backed: :Entity-qualified matches + degree-property filter, no runtime COUNT{}", async () => {
    okRecords = [{ seed: "p", steps: [{ rel: "LACKS", node: "f" }] }];
    const client = freshClient();
    await client.opportunityPaths(PARAMS);

    const { query } = captured.queries[0]!;
    // Seed AND destination are label-qualified so the property indexes apply
    // (a bare `{user_id:…}` match is label-less and forces a full node scan).
    expect(query).toContain("(pain:Entity {user_id: $userId})");
    expect(query).toContain("(dest:Entity {user_id: $userId})");
    // Degree filtering reads the precomputed `degree` property, never a runtime
    // per-node subquery — that subquery was the original >4min timeout cause.
    expect(query).toContain("pain.degree >= $minDegree");
    expect(query).toContain("pain.degree <= $maxDegree");
    expect(query).toContain("n.degree <= $maxDegree");
    expect(query).not.toContain("COUNT {");
    expect(query).not.toContain("COUNT{");
    await client.close();
  });

  test("variable-length pattern carries a LITERAL upper bound (not unbounded *2..)", async () => {
    okRecords = [{ seed: "p", steps: [{ rel: "LACKS", node: "f" }] }];
    const client = freshClient();
    await client.opportunityPaths(PARAMS);

    const { query } = captured.queries[0]!;
    // An unbounded `*2..` makes the planner expand an enormous frontier and
    // times out; a literal ceiling lets it prune at expansion time. The
    // caller's runtime $maxHops is still enforced via the length guard.
    expect(query).toMatch(/\[rels\*2\.\.\d+\]/);
    expect(query).not.toMatch(/\[rels\*2\.\.\]/);
    expect(query).toContain("length(path) <= toInteger($maxHops)");
    await client.close();
  });

  test("matches rel types case-INSENSITIVELY against the uppercase whitelist", async () => {
    okRecords = [{ seed: "p", steps: [{ rel: "LACKS", node: "f" }] }];
    const client = freshClient();
    await client.opportunityPaths(PARAMS);

    const { query } = captured.queries[0]!;
    // Canonicalization is a WEEKLY backfill, but the sidecar / code-graph
    // ingestion write fresh LOWERCASE rel types between runs. Both whitelist
    // predicates (seed expansion + per-path) MUST fold the live type to upper
    // before the membership test, or those un-canonicalized edges are silently
    // dropped from reasoning until the next cleanup. Assert on the query text
    // since this lane has no live DB.
    expect(query).toContain("toUpper(type(rr))"); // seed predicate
    expect(query).toContain("toUpper(type(r)) IN $relWhitelist"); // per-path predicate
    // The returned hop label is emitted in the same canonical (uppercase) form.
    expect(query).toContain("toUpper(type(relationships(path)[i - 1]))");
    // Regression guard: no remaining case-sensitive `type(r) IN $relWhitelist`.
    expect(query).not.toMatch(/[^(]type\(r\) IN \$relWhitelist/);
    await client.close();
  });

  test("uses Cypher `//` line comments, never SQL-style `--` (a parse error)", async () => {
    // Cypher only supports `//` and `/* */`. A `--` "comment" is NOT ignored —
    // Neo4j raises `Invalid input ':'` and the WHOLE query fails, so
    // opportunityPaths silently returns [] on every call (graph reasoning dies
    // with only a WARN). This guards against re-introducing SQL-style comments,
    // since this lane has no live DB to catch the parse error directly.
    okRecords = [{ seed: "p", steps: [{ rel: "LACKS", node: "f" }] }];
    const client = freshClient();
    await client.opportunityPaths(PARAMS);

    const { query } = captured.queries[0]!;
    // No line that is only-whitespace then `--` (SQL line comment).
    expect(query).not.toMatch(/^\s*--/m);
    // The intended explanatory comments are present as Cypher `//` comments.
    expect(query).toContain("// toUpper()");
    await client.close();
  });

  test("forwards the per-query { timeout } transaction config", async () => {
    okRecords = [{ seed: "p", steps: [{ rel: "LACKS", node: "f" }] }];
    const client = freshClient(1234);
    await client.opportunityPaths(PARAMS);

    expect(captured.txConfigs[0]).toEqual({ timeout: 1234 });
    await client.close();
  });

  test("maps records into GraphPath and drops cyclic paths", async () => {
    okRecords = [
      // valid two-step chain
      {
        seed: "clunky export",
        steps: [
          { rel: "LACKS", node: "bulk export" },
          { rel: "HAS_FEATURE", node: "csv export" },
        ],
      },
      // cyclic: the seed name reappears as a node → dropped by the mapper
      {
        seed: "loop",
        steps: [
          { rel: "LACKS", node: "mid" },
          { rel: "USES", node: "loop" },
        ],
      },
    ];
    const client = freshClient();
    const paths = await client.opportunityPaths(PARAMS);

    expect(paths.length).toBe(1);
    expect(paths[0]!.seed).toBe("clunky export");
    expect(paths[0]!.steps).toEqual([
      { rel: "LACKS", node: "bulk export" },
      { rel: "HAS_FEATURE", node: "csv export" },
    ]);
    await client.close();
  });

  test("returns [] (no driver dialed) when NEO4J_PASSWORD is unset", async () => {
    password = undefined;
    const client = freshClient();
    const paths = await client.opportunityPaths(PARAMS);
    expect(paths).toEqual([]);
    expect(captured.queries.length).toBe(0);
    await client.close();
  });
});

describe("Neo4jReadClient.opportunityPaths — failure paths", () => {
  test("a connection error → [] and opens the breaker (subsequent call short-circuits)", async () => {
    mode = "connError";
    const client = freshClient();

    const first = await client.opportunityPaths(PARAMS);
    expect(first).toEqual([]);
    expect(client.isUnavailable()).toBe(true);

    // Breaker open → the next call short-circuits without running a query.
    const queriesBefore = captured.queries.length;
    const second = await client.opportunityPaths(PARAMS);
    expect(second).toEqual([]);
    expect(captured.queries.length).toBe(queriesBefore); // no new query attempted
    await client.close();
  });

  test("a hung query → [] via the JS race fallback within the timeout", async () => {
    mode = "hang";
    // Tiny timeout so the test is fast; the race must reject and degrade to [].
    const client = freshClient(50);
    const start = Date.now();
    const paths = await client.opportunityPaths(PARAMS);
    const elapsed = Date.now() - start;

    expect(paths).toEqual([]);
    // Resolved well before any default 5s ceiling — the race fired.
    expect(elapsed).toBeLessThan(2_000);
    await client.close();
  });
});
