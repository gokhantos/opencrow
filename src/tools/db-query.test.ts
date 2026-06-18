/**
 * Unit tests for db-query.ts — guard / normalisation logic (no DB required).
 *
 * Every test in this file exercises paths that return BEFORE getReadonlyDb() is
 * called (i.e. all permission / input guard checks), so the test lane is "unit"
 * (*.test.ts suffix).  Output-redaction tests that require a live connection
 * live in db-query.integration.test.ts.
 *
 * KNOWN IMPLEMENTATION BUG (surfaced by these tests):
 *   The DDL/DML keyword regex in execute() uses uppercase-only patterns
 *   (/\b(DROP|DELETE|...)\b/) but tests against `norm` which is always
 *   lowercase.  As a result, semicolon-chained DDL like
 *   "SELECT 1; DROP TABLE foo" slips past the code-level keyword guard.
 *   The READ ONLY transaction (Layer 1) and the database role (Layer 0) are
 *   the effective backstops for that case.  The bug is documented in the
 *   "known gaps" describe block below and must be fixed in the implementation.
 */

import { describe, it, expect } from "bun:test";
import { createDbQueryTool } from "./db-query";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exec(query: string, extra?: Record<string, unknown>) {
  const tool = createDbQueryTool();
  return tool.execute({ query, ...extra });
}

// ---------------------------------------------------------------------------
// Layer 0 — input validation
// ---------------------------------------------------------------------------

describe("db-query unit — input validation", () => {
  it("rejects missing query", async () => {
    const tool = createDbQueryTool();
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("query is required");
  });

  it("rejects undefined query", async () => {
    const tool = createDbQueryTool();
    const result = await tool.execute({ query: undefined });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("query is required");
  });
});

// ---------------------------------------------------------------------------
// Layer 2a — SELECT-only gate
// ---------------------------------------------------------------------------

describe("db-query unit — SELECT-only gate", () => {
  it("blocks INSERT", async () => {
    const result = await exec("INSERT INTO foo VALUES (1)");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks UPDATE", async () => {
    const result = await exec("UPDATE foo SET bar = 1 WHERE id = 1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks DELETE", async () => {
    const result = await exec("DELETE FROM foo WHERE id = 1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks TRUNCATE as opener", async () => {
    const result = await exec("TRUNCATE TABLE foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks DROP as opener", async () => {
    const result = await exec("DROP TABLE foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks queries starting with a comment then non-SELECT", async () => {
    // A leading comment should not trick the SELECT gate.
    const result = await exec("-- comment\nDELETE FROM foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks block-comment-masked non-SELECT opener", async () => {
    const result = await exec("/* trick */ INSERT INTO foo VALUES (1)");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH-prefixed queries (CTEs starting with WITH, not SELECT)", async () => {
    // Queries starting with WITH rather than SELECT are rejected at the SELECT
    // gate because the stripped form does not start with SELECT.
    // This means any CTE — including read-only ones — is blocked unless the
    // caller starts with SELECT.
    const result = await exec(
      "WITH cte AS (SELECT 1) SELECT * FROM cte",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("allows SELECT (uppercase)", async () => {
    // Will fail at DB in unit lane, but NOT at the SELECT gate.
    const result = await exec("SELECT 1");
    if (result.isError) {
      expect(result.output).not.toContain("Only SELECT queries are allowed");
    }
  });

  it("allows select (lowercase)", async () => {
    const result = await exec("select 1");
    if (result.isError) {
      expect(result.output).not.toContain("Only SELECT queries are allowed");
    }
  });

  it("allows SELECT with leading whitespace", async () => {
    const result = await exec("   SELECT 1");
    if (result.isError) {
      expect(result.output).not.toContain("Only SELECT queries are allowed");
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2b — CTE write-operation guard
//
// NOTE: This guard fires ONLY for queries whose stripped opener is SELECT and
// that contain WITH ... <write-op> after the SELECT.  Queries starting with
// WITH are blocked earlier by the SELECT gate.  The realistic attack vector
// this guard covers is an inline CTE nested inside a SELECT clause, e.g.:
//   SELECT ... FROM (WITH w AS (DELETE ...) SELECT * FROM w)
// We test these WITH-as-opener cases here and document what message fires.
// ---------------------------------------------------------------------------

describe("db-query unit — CTE write-op guard (WITH opener blocked at SELECT gate)", () => {
  // All these queries start with WITH, so the SELECT gate fires first.
  // The CTE guard is defence-in-depth for SELECT-starting queries that embed a
  // writable CTE inline.

  it("blocks WITH...DELETE (rejected at SELECT gate)", async () => {
    const result = await exec(
      "WITH d AS (DELETE FROM foo RETURNING *) SELECT * FROM d",
    );
    expect(result.isError).toBe(true);
    // Blocked by SELECT gate (not CTE guard) because query starts with WITH.
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...UPDATE (rejected at SELECT gate)", async () => {
    const result = await exec(
      "WITH u AS (UPDATE foo SET x=1 RETURNING *) SELECT * FROM u",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...INSERT (rejected at SELECT gate)", async () => {
    const result = await exec(
      "WITH i AS (INSERT INTO foo VALUES (1) RETURNING *) SELECT * FROM i",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...DROP (rejected at SELECT gate)", async () => {
    const result = await exec("WITH d AS (DROP TABLE foo) SELECT 1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...TRUNCATE (rejected at SELECT gate)", async () => {
    const result = await exec("WITH t AS (TRUNCATE TABLE foo) SELECT 1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...CREATE (rejected at SELECT gate)", async () => {
    const result = await exec(
      "WITH c AS (CREATE TABLE evil (id int)) SELECT 1",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...GRANT (rejected at SELECT gate)", async () => {
    const result = await exec(
      "WITH g AS (GRANT ALL ON foo TO public) SELECT 1",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks WITH...REVOKE (rejected at SELECT gate)", async () => {
    const result = await exec(
      "WITH r AS (REVOKE ALL ON foo FROM public) SELECT 1",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });
});

// ---------------------------------------------------------------------------
// Layer 2c — DDL/DML keyword denylist (post-normalisation)
//
// IMPORTANT: The DDL regex uses uppercase-only patterns but `norm` is always
// lowercase. As a result the keyword check does NOT catch semicolon-chained
// DDL. Those queries reach the DB where the READ ONLY transaction blocks them.
// Tests in the "known gaps" section below document this gap explicitly.
// ---------------------------------------------------------------------------

describe("db-query unit — DDL/DML keyword denylist (direct openers blocked at SELECT gate)", () => {
  // These test the SELECT gate path, not the DDL keyword check.
  it("blocks bare DROP", async () => {
    const result = await exec("DROP TABLE foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare DELETE", async () => {
    const result = await exec("DELETE FROM foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare UPDATE", async () => {
    const result = await exec("UPDATE foo SET x=1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare INSERT", async () => {
    const result = await exec("INSERT INTO foo VALUES (1)");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare TRUNCATE", async () => {
    const result = await exec("TRUNCATE TABLE foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare ALTER", async () => {
    const result = await exec("ALTER TABLE foo ADD bar int");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare CREATE", async () => {
    const result = await exec("CREATE TABLE evil (id int)");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare GRANT", async () => {
    const result = await exec("GRANT ALL ON foo TO public");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare REVOKE", async () => {
    const result = await exec("REVOKE ALL ON foo FROM public");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });

  it("blocks bare COPY", async () => {
    const result = await exec("COPY foo TO '/tmp/out'");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Only SELECT queries are allowed");
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DDL keyword denylist — case-insensitive fix verified
//
// The old implementation used uppercase-only patterns (/\b(DROP|...)\b/) but
// tested against `norm` which is always lowercase.  The fix switches to
// lowercase patterns so semicolon-chained DDL is now caught at Layer 2.
// ---------------------------------------------------------------------------

describe("db-query unit — DDL keyword denylist now catches semicolon-chained DDL", () => {
  it("SELECT 1; DROP TABLE foo — now blocked at Layer 2 (No DDL or DML)", async () => {
    const result = await exec("SELECT 1; DROP TABLE foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; DELETE FROM foo — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; DELETE FROM foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; UPDATE foo SET x=1 — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; UPDATE foo SET x=1");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; INSERT INTO foo VALUES (1) — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; INSERT INTO foo VALUES (1)");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; TRUNCATE TABLE foo — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; TRUNCATE TABLE foo");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; ALTER TABLE foo ADD bar int — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; ALTER TABLE foo ADD bar int");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; CREATE TABLE evil (id int) — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; CREATE TABLE evil (id int)");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; GRANT ALL ON foo TO public — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; GRANT ALL ON foo TO public");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; REVOKE ALL ON foo FROM public — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; REVOKE ALL ON foo FROM public");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });

  it("SELECT 1; COPY foo TO '/tmp/out' — now blocked at Layer 2", async () => {
    const result = await exec("SELECT 1; COPY foo TO '/tmp/out'");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("No DDL or DML");
  });
});

// ---------------------------------------------------------------------------
// Layer 2d — dangerous function denylist
// ---------------------------------------------------------------------------

describe("db-query unit — dangerous function denylist", () => {
  it("blocks pg_read_file", async () => {
    const result = await exec("SELECT pg_read_file('/etc/passwd')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks PG_READ_FILE (uppercase in original, lowercase in norm)", async () => {
    const result = await exec("SELECT PG_READ_FILE('/etc/passwd')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks pg_read_binary_file", async () => {
    const result = await exec("SELECT pg_read_binary_file('/etc/shadow')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks pg_write_file", async () => {
    const result = await exec("SELECT pg_write_file('/tmp/x', 'data')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks pg_execute_server_program", async () => {
    const result = await exec("SELECT pg_execute_server_program('id')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks lo_import", async () => {
    const result = await exec("SELECT lo_import('/etc/passwd')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks lo_export", async () => {
    const result = await exec("SELECT lo_export(12345, '/tmp/out')");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks dblink", async () => {
    const result = await exec(
      "SELECT * FROM dblink('host=evil.com', 'SELECT 1') AS t(x int)",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks pg_stat_activity", async () => {
    const result = await exec("SELECT * FROM pg_stat_activity");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks pg_authid (function denylist)", async () => {
    const result = await exec("SELECT * FROM pg_authid");
    expect(result.isError).toBe(true);
    // Blocked by function denylist OR sensitive table denylist — both cover it.
    expect(result.output).toMatch(/restricted PostgreSQL function|Access to table/);
  });

  it("blocks pg_shadow (function denylist)", async () => {
    const result = await exec("SELECT * FROM pg_shadow");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/restricted PostgreSQL function|Access to table/);
  });

  it("blocks pg_roles", async () => {
    const result = await exec("SELECT * FROM pg_roles");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });

  it("blocks pg_user", async () => {
    const result = await exec("SELECT * FROM pg_user");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted PostgreSQL function");
  });
});

// ---------------------------------------------------------------------------
// Layer 2e — sensitive table denylist (normalization variants)
// ---------------------------------------------------------------------------

describe("db-query unit — sensitive table denylist", () => {
  // Application credential tables (non-pg_* prefix — blocked by SENSITIVE_TABLES loop)
  const APP_BLOCKED_TABLES = [
    "x_accounts",
    "ph_accounts",
    "reddit_accounts",
    "sdk_sessions",
    "config_overrides",
  ];

  for (const table of APP_BLOCKED_TABLES) {
    it(`blocks plain reference to ${table}`, async () => {
      const result = await exec(`SELECT * FROM ${table}`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Access to table");
    });

    it(`blocks double-quoted reference to ${table}`, async () => {
      const result = await exec(`SELECT * FROM "${table}"`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Access to table");
    });

    it(`blocks schema-qualified reference to ${table}`, async () => {
      const result = await exec(`SELECT * FROM public.${table}`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Access to table");
    });

    it(`blocks schema-qualified double-quoted reference to ${table}`, async () => {
      const result = await exec(`SELECT * FROM public."${table}"`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Access to table");
    });

    it(`blocks uppercase reference to ${table}`, async () => {
      const result = await exec(`SELECT * FROM ${table.toUpperCase()}`);
      expect(result.isError).toBe(true);
      // Blocked at table denylist or function denylist.
      expect(result.output).toMatch(/Access to table|restricted PostgreSQL function/);
    });
  }

  // pg_auth_members starts with pg_ so it is caught by the pg_* pattern guard
  // (before the SENSITIVE_TABLES loop) with the "system catalog" message.
  it("blocks pg_auth_members (pg_* pattern guard)", async () => {
    const result = await exec("SELECT * FROM pg_auth_members");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/system catalog|restricted/i);
  });

  it("blocks information_schema reference (pg_* / information_schema pattern guard)", async () => {
    const result = await exec(
      "SELECT * FROM information_schema.tables",
    );
    expect(result.isError).toBe(true);
    // Caught by the pg_* / information_schema pattern guard.
    expect(result.output).toMatch(/system catalog|restricted/i);
  });

  it("blocks information_schema with WHERE clause (pg_* / information_schema pattern guard)", async () => {
    const result = await exec(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/system catalog|restricted/i);
  });

  it("blocks pg_catalog reference (pg_* pattern guard fires before SENSITIVE_TABLES)", async () => {
    const result = await exec("SELECT * FROM pg_catalog.pg_tables");
    expect(result.isError).toBe(true);
    // Caught by the pg_* pattern guard — message is about system catalogs.
    expect(result.output).toMatch(/system catalog|restricted/i);
  });

  it("blocks aliased sensitive table (alias does not bypass guard)", async () => {
    const result = await exec(
      "SELECT a.id FROM x_accounts AS a WHERE 1=1",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access to table");
  });

  it("blocks JOIN on sensitive table", async () => {
    const result = await exec(
      "SELECT u.id FROM users u JOIN x_accounts xa ON xa.id = u.account_id",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access to table");
  });

  it("blocks sensitive table in subquery", async () => {
    const result = await exec(
      "SELECT * FROM (SELECT * FROM sdk_sessions) AS s",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access to table");
  });

  it("blocks backtick-quoted x_accounts", async () => {
    const result = await exec("SELECT * FROM `x_accounts`");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access to table");
  });

  it("blocks PUBLIC (uppercase) schema prefix stripped correctly", async () => {
    const result = await exec("SELECT * FROM PUBLIC.x_accounts");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access to table");
  });

  it("blocks x_accounts reference with inline comment above it", async () => {
    const result = await exec(
      "-- this is safe\nSELECT id FROM x_accounts WHERE 1=1",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Access to table");
  });

  it("does NOT block table named 'accounts' (not in denylist, word boundary)", async () => {
    // 'accounts' (without x_ prefix) is not in the denylist.
    const result = await exec("SELECT * FROM accounts");
    if (result.isError) {
      // Only DB errors are OK; table-denylist must NOT fire.
      expect(result.output).not.toContain('Access to table "accounts"');
    }
  });

  it("does NOT block table named 'sessions' (only sdk_sessions is denied)", async () => {
    const result = await exec("SELECT * FROM sessions");
    if (result.isError) {
      expect(result.output).not.toContain('Access to table "sessions"');
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2f — credential column denylist (normalisation variants)
// ---------------------------------------------------------------------------

describe("db-query unit — credential column denylist", () => {
  const BLOCKED_COLUMNS = [
    "auth_token",
    "ct0",
    "session_cookie",
    "token_cookie",
    "cookies_json",
    "value_json",
    "sdk_session_id",
    "password",
    "secret",
    "api_key",
    "access_token",
    "refresh_token",
    "private_key",
  ];

  for (const col of BLOCKED_COLUMNS) {
    it(`blocks SELECT ${col} from any table`, async () => {
      const result = await exec(`SELECT ${col} FROM some_table`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("restricted for security");
    });

    it(`blocks SELECT t.${col} (table-qualified column)`, async () => {
      const result = await exec(`SELECT t.${col} FROM some_table t`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("restricted for security");
    });

    it(`blocks double-quoted "${col}"`, async () => {
      const result = await exec(`SELECT "${col}" FROM some_table`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("restricted for security");
    });

    it(`blocks uppercase ${col.toUpperCase()}`, async () => {
      const result = await exec(`SELECT ${col.toUpperCase()} FROM some_table`);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("restricted for security");
    });
  }

  it("blocks credential column in WHERE clause", async () => {
    const result = await exec(
      "SELECT id FROM users WHERE auth_token = 'abc'",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("blocks credential column in ORDER BY", async () => {
    const result = await exec(
      "SELECT id FROM users ORDER BY api_key ASC",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("blocks credential column after inline comment", async () => {
    const result = await exec(
      "SELECT id, -- safe cols\nauth_token FROM users",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("blocks credential column after block comment", async () => {
    const result = await exec(
      "SELECT /* safe */ auth_token FROM users",
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("does NOT block column 'user_id' or 'post_count' (safe columns)", async () => {
    const result = await exec("SELECT user_id, post_count FROM analytics");
    if (result.isError) {
      expect(result.output).not.toContain("restricted for security");
    }
  });

  it("does NOT block column 'secrets_count' (word boundary: secret != secrets_count)", async () => {
    // \bsecret\b does NOT match 'secrets_count' because 'secrets' has a letter
    // following 'secret', so the word boundary after 'secret' does not fire.
    const result = await exec("SELECT secrets_count FROM analytics");
    if (result.isError) {
      expect(result.output).not.toContain('Access to column "secret"');
    }
  });

  it("does NOT block column 'token_count' (not in denylist)", async () => {
    const result = await exec("SELECT id, token_count FROM usage_stats");
    if (result.isError) {
      expect(result.output).not.toContain("restricted for security");
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2g — normalization obfuscation attempts
// ---------------------------------------------------------------------------

describe("db-query unit — normalization bypass attempts blocked", () => {
  it("blocks x_accounts with extra whitespace around dot", async () => {
    const result = await exec("SELECT * FROM public . x_accounts");
    expect(result.isError).toBe(true);
  });

  it("blocks x_accounts with mixed case", async () => {
    const result = await exec("SELECT * FROM X_Accounts");
    expect(result.isError).toBe(true);
  });

  it("blocks double-quoted schema-qualified x_accounts", async () => {
    const result = await exec(`SELECT * FROM "public"."x_accounts"`);
    expect(result.isError).toBe(true);
  });

  it("blocks pg_shadow with mixed-case letters", async () => {
    const result = await exec("SELECT * FROM Pg_Shadow");
    expect(result.isError).toBe(true);
  });

  it("blocks auth_token with block comment before it in SELECT list", async () => {
    const result = await exec("SELECT id, /* comment */ auth_token FROM t");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("blocks backtick-quoted credential column", async () => {
    const result = await exec("SELECT `auth_token` FROM users");
    expect(result.isError).toBe(true);
    expect(result.output).toContain("restricted for security");
  });

  it("blocks information_schema with uppercase", async () => {
    const result = await exec("SELECT * FROM INFORMATION_SCHEMA.tables");
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legitimate analytics queries — guards must pass
// ---------------------------------------------------------------------------

describe("db-query unit — legitimate analytics queries pass all guards", () => {
  // These queries contain no blocked keywords, tables, or columns.
  // They will fail at the DB (no DB in unit lane) but must NOT be blocked by
  // any code-level guard.

  const LEGITIMATE_QUERIES = [
    { desc: "simple SELECT 1", q: "SELECT 1" },
    { desc: "count from pipeline_runs", q: "SELECT COUNT(*) FROM pipeline_runs" },
    {
      desc: "join agents and pipeline_runs",
      q: "SELECT a.name, COUNT(pr.id) FROM agents a LEFT JOIN pipeline_runs pr ON pr.agent_id = a.id GROUP BY a.name",
    },
    { desc: "select with LIMIT", q: "SELECT id, name FROM agents LIMIT 10" },
    { desc: "select with WHERE", q: "SELECT * FROM jobs WHERE status = 'done'" },
    {
      desc: "select with ORDER BY",
      q: "SELECT id, created_at FROM pipeline_runs ORDER BY created_at DESC",
    },
    {
      desc: "aggregate with HAVING",
      q: "SELECT agent_id, COUNT(*) AS cnt FROM jobs GROUP BY agent_id HAVING COUNT(*) > 5",
    },
    { desc: "safe columns only", q: "SELECT id, username, created_at FROM users" },
    {
      desc: "non-credential column token_count",
      q: "SELECT id, token_count FROM usage_stats",
    },
    {
      desc: "subquery on safe table",
      q: "SELECT * FROM (SELECT id, name FROM agents WHERE active = true) AS a",
    },
  ];

  for (const { desc, q } of LEGITIMATE_QUERIES) {
    it(`passes guards for: ${desc}`, async () => {
      const result = await exec(q);
      // In unit lane there is no DB, so the query will error at execution time.
      // We assert that the failure is NOT from any code-level guard.
      if (result.isError) {
        expect(result.output).not.toContain("Only SELECT queries are allowed");
        expect(result.output).not.toContain("CTEs with write operations");
        expect(result.output).not.toContain("No DDL or DML");
        expect(result.output).not.toContain("restricted PostgreSQL function");
        expect(result.output).not.toContain("restricted for security");
        expect(result.output).not.toContain("Access to table");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Tool definition contract
// ---------------------------------------------------------------------------

describe("db-query unit — tool definition", () => {
  it("has name db_query", () => {
    const tool = createDbQueryTool();
    expect(tool.name).toBe("db_query");
  });

  it("includes analytics category", () => {
    const tool = createDbQueryTool();
    expect(tool.categories).toContain("analytics");
  });

  it("includes system category", () => {
    const tool = createDbQueryTool();
    expect(tool.categories).toContain("system");
  });

  it("requires query parameter", () => {
    const tool = createDbQueryTool();
    expect(tool.inputSchema.required).toContain("query");
  });

  it("defines query, params, limit in inputSchema", () => {
    const tool = createDbQueryTool();
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props["query"]).toBeDefined();
    expect(props["params"]).toBeDefined();
    expect(props["limit"]).toBeDefined();
  });

  it("query property has type string", () => {
    const tool = createDbQueryTool();
    const props = tool.inputSchema.properties as Record<string, { type: string }>;
    expect(props["query"]?.type).toBe("string");
  });

  it("createDbTools returns array with db_query", () => {
    const { createDbTools } = require("./db-query");
    const tools = createDbTools();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.map((t: { name: string }) => t.name)).toContain("db_query");
  });
});
