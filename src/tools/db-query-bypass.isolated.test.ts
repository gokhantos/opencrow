/**
 * Isolated tests for confirmed bypass vectors against the db_query guard layer.
 *
 * These tests exercise attack patterns that the security reviewer confirmed as
 * exploitable against the previous implementation:
 *
 *   1. PostgreSQL U& unicode-escaped identifiers
 *      (e.g. U&"\0078_accounts" resolves to x_accounts at DB level but was
 *      left literal by the old normalizer, bypassing the table denylist)
 *
 *   2. substring()-chunking to defeat TOKEN_VALUE_RE length thresholds
 *      (e.g. substring(auth_token,1,30) returned 30 chars below the old 40-char
 *      threshold — now the column denylist blocks auth_token before execution,
 *      and the token threshold is lowered to 20 chars as additional backstop)
 *
 *   3. Structured secret columns (cookies_json, value_json) that hold non-token-
 *      shaped values (JSON blobs) that the old TOKEN_VALUE_RE missed entirely
 *
 *   4. pg_user_mappings and pg_settings catalog reflection that was not in the
 *      old DENIED_FUNCTION_RE
 *
 * Every test asserts the query is REJECTED (isError=true) — not merely redacted.
 *
 * This file uses mock.module so it must be *.isolated.test.ts.
 */

import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the DB layer so no real Postgres connection is needed, AND mock
// OPENCROW_READONLY_DATABASE_URL so getReadonlyDb() does not throw the
// fail-closed error before our guard checks run.
// ---------------------------------------------------------------------------

mock.module("../store/db", () => ({
  getDb: () => {
    throw new Error("getDb() should not be called in isolated tests");
  },
  initDb: () => Promise.resolve(),
  closeDb: () => Promise.resolve(),
}));

mock.module("bun", () => {
  const actual = require("bun");
  return {
    ...actual,
    SQL: class MockSQL {
      constructor() {}
      async begin() {
        throw new Error("Mock SQL: begin() should not be reached in bypass tests");
      }
    },
  };
});

// Set the env var BEFORE importing db-query (module cache not yet warm in
// isolated process, but just in case the module was already loaded we use
// process.env directly and rely on the mock above to prevent actual DB use).
process.env.OPENCROW_READONLY_DATABASE_URL =
  "postgres://readonly:readonly@127.0.0.1:5432/opencrow";

import { describe, it, expect, afterAll } from "bun:test";
import { createDbQueryTool } from "./db-query";

afterAll(() => {
  delete process.env.OPENCROW_READONLY_DATABASE_URL;
});

async function exec(query: string) {
  const tool = createDbQueryTool();
  return tool.execute({ query });
}

// ---------------------------------------------------------------------------
// 1. U& unicode-escaped identifier bypass
// ---------------------------------------------------------------------------

describe("bypass: U& unicode-escaped identifiers", () => {
  it("rejects U&\"\\\\0078_accounts\" (x_accounts encoded as U&)", async () => {
    // \0078 → 'x', so this is U&"x_accounts" which Postgres resolves to x_accounts
    const result = await exec('SELECT * FROM U&"\\0078_accounts"');
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unicode|U&/i);
  });

  it("rejects U&\"\\\\0061uth_token\" (auth_token column U&-encoded)", async () => {
    // \0061 → 'a', so substring(U&"\0061uth_token",1,30) → substring(auth_token,1,30)
    const result = await exec(
      'SELECT substring(U&"\\0061uth_token",1,30) FROM U&"\\0078_accounts"',
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unicode|U&/i);
  });

  it("rejects U&'...' string literal form", async () => {
    const result = await exec("SELECT U&'\\0068ello'");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unicode|U&/i);
  });

  it("rejects mixed-case U& prefix (case-insensitive)", async () => {
    const result = await exec('SELECT * FROM u&"\\0078_accounts"');
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unicode|U&/i);
  });

  it("rejects raw backslash-hex escape outside U& (\\XXXX notation)", async () => {
    // Residual \NNNN sequences are also rejected.
    const result = await exec("SELECT * FROM foo WHERE id = \\0031");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unicode|escape/i);
  });

  it("rejects the exact confirmed exploit payload from security review", async () => {
    // Confirmed end-to-end bypass: returned full auth_token via substring chunking.
    const result = await exec(
      'SELECT substring(U&"\\0061uth_token",1,30) AS s1, ' +
        'substring(U&"\\0061uth_token",31) AS s2 ' +
        'FROM U&"\\0078_accounts"',
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/unicode|U&/i);
  });
});

// ---------------------------------------------------------------------------
// 2. substring()-chunked exfil defeating old TOKEN_VALUE_RE thresholds
// ---------------------------------------------------------------------------

describe("bypass: substring-chunked exfil", () => {
  it("blocks auth_token column reference (column denylist fires before execution)", async () => {
    // substring(auth_token,1,30) still names the credential column — blocked at Layer 2.
    const result = await exec(
      "SELECT id, substring(auth_token,1,30) AS part1 FROM x_accounts",
    );
    expect(result.isError).toBe(true);
    // Either table or column denylist fires — both block this.
    expect(result.output).toMatch(/restricted|Access to table/i);
  });

  it("blocks auth_token inside a concat expression", async () => {
    const result = await exec(
      "SELECT id, auth_token || '' AS t FROM x_accounts",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|Access to table/i);
  });

  it("blocks ct0 cookie column via substring", async () => {
    const result = await exec(
      "SELECT id, substring(ct0,1,30) AS s1 FROM x_accounts",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|Access to table/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Structured secret columns (cookies_json / value_json) not caught by old
//    TOKEN_VALUE_RE (JSON blobs are not token-shaped)
// ---------------------------------------------------------------------------

describe("bypass: structured secret column names", () => {
  it("blocks cookies_json column reference", async () => {
    const result = await exec("SELECT id, cookies_json FROM reddit_accounts");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|Access to table/i);
  });

  it("blocks value_json column reference from any table", async () => {
    const result = await exec("SELECT id, value_json FROM some_analytics_table");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("blocks cookies_json in a subquery alias", async () => {
    const result = await exec(
      "SELECT sub.c FROM (SELECT cookies_json AS c FROM ph_accounts) AS sub",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|Access to table/i);
  });
});

// ---------------------------------------------------------------------------
// 4. pg_user_mappings and pg_settings catalog reflection
// ---------------------------------------------------------------------------

describe("bypass: pg_catalog reflection tables not in old denylist", () => {
  it("blocks pg_user_mappings", async () => {
    const result = await exec("SELECT * FROM pg_user_mappings");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|system catalog/i);
  });

  it("blocks pg_settings", async () => {
    const result = await exec("SELECT name, setting FROM pg_settings");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|system catalog/i);
  });

  it("blocks pg_hba_file_rules", async () => {
    const result = await exec("SELECT * FROM pg_hba_file_rules");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|system catalog/i);
  });

  it("blocks any pg_* table via the pg_ pattern guard", async () => {
    // Unlisted pg_ catalog views are blocked by the pg_* pattern guard.
    const result = await exec("SELECT * FROM pg_some_future_catalog_view");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|system catalog/i);
  });

  it("blocks schema-qualified pg_catalog.pg_user_mappings", async () => {
    const result = await exec("SELECT * FROM pg_catalog.pg_user_mappings");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted|Access to table|system catalog/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Layer 1 fail-closed: getReadonlyDb() throws when env var absent
// ---------------------------------------------------------------------------

describe("Layer 1 fail-closed: missing OPENCROW_READONLY_DATABASE_URL", () => {
  it("returns serviceError when OPENCROW_READONLY_DATABASE_URL is unset", async () => {
    // Temporarily remove the env var to trigger the fail-closed path.
    const saved = process.env.OPENCROW_READONLY_DATABASE_URL;
    delete process.env.OPENCROW_READONLY_DATABASE_URL;
    try {
      // A query that passes all Layer 2 guards should hit Layer 1 fail-closed.
      const result = await exec("SELECT 1");
      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/OPENCROW_READONLY_DATABASE_URL/i);
    } finally {
      process.env.OPENCROW_READONLY_DATABASE_URL = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Regression: legitimate analytics queries still pass Layer 2 guards
// ---------------------------------------------------------------------------

describe("regression: legitimate analytics queries pass all guards", () => {
  const LEGITIMATE = [
    { desc: "count pipeline_runs", q: "SELECT COUNT(*) FROM pipeline_runs" },
    { desc: "join agents", q: "SELECT a.name FROM agents a WHERE a.active = true" },
    { desc: "non-credential columns", q: "SELECT id, username, created_at FROM users" },
    { desc: "token_count (safe column)", q: "SELECT id, token_count FROM usage_stats" },
    {
      desc: "aggregate with HAVING",
      q: "SELECT agent_id, COUNT(*) FROM jobs GROUP BY agent_id HAVING COUNT(*) > 5",
    },
  ];

  for (const { desc, q } of LEGITIMATE) {
    it(`passes guards: ${desc}`, async () => {
      // These will hit the mock SQL which throws "begin() should not be reached"
      // — that is expected. What matters is that none of the Layer 2 guard
      // messages appear.
      const result = await exec(q);
      if (result.isError) {
        expect(result.output).not.toContain("Only SELECT queries are allowed");
        expect(result.output).not.toContain("CTEs with write operations");
        expect(result.output).not.toContain("No DDL or DML");
        expect(result.output).not.toContain("restricted PostgreSQL function");
        expect(result.output).not.toContain("restricted for security");
        expect(result.output).not.toContain("Access to table");
        expect(result.output).not.toContain("system catalog");
        expect(result.output).not.toContain("unicode");
      }
    });
  }
});
