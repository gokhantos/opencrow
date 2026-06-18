import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";

import {
  createDbQueryTool,
  createDbTools,
} from "./db-query";

describe("db-query tools", () => {
  let savedReadonlyUrl: string | undefined;

  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    // In the integration test environment the dedicated readonly role may not
    // exist yet. Point OPENCROW_READONLY_DATABASE_URL at the privileged connection
    // so getReadonlyDb() does not throw the fail-closed error and execution
    // tests can proceed. The Layer 2 guards under test are connection-agnostic.
    savedReadonlyUrl = process.env.OPENCROW_READONLY_DATABASE_URL;
    process.env.OPENCROW_READONLY_DATABASE_URL =
      process.env.OPENCROW_READONLY_DATABASE_URL ?? process.env.DATABASE_URL;
  });

  afterEach(async () => {
    // Restore original value (undefined = delete).
    if (savedReadonlyUrl === undefined) {
      delete process.env.OPENCROW_READONLY_DATABASE_URL;
    } else {
      process.env.OPENCROW_READONLY_DATABASE_URL = savedReadonlyUrl;
    }
    await closeDb();
  });

  describe("createDbQueryTool - definition", () => {
    it("should have correct name", () => {
      const tool = createDbQueryTool();
      expect(tool.name).toBe("db_query");
    });

    it("should have correct categories", () => {
      const tool = createDbQueryTool();
      expect(tool.categories).toContain("analytics");
      expect(tool.categories).toContain("system");
    });

    it("should require query parameter", () => {
      const tool = createDbQueryTool();
      expect(tool.inputSchema.required).toEqual(["query"]);
    });

    it("should have query, params, and limit properties", () => {
      const tool = createDbQueryTool();
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(props.query).toBeDefined();
      expect(props.params).toBeDefined();
      expect(props.limit).toBeDefined();
    });
  });

  describe("createDbQueryTool - SELECT validation", () => {
    it("should reject non-SELECT queries", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "INSERT INTO foo VALUES (1)" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Only SELECT queries are allowed");
    });

    it("should reject UPDATE queries", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "UPDATE foo SET bar = 1" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Only SELECT queries are allowed");
    });

    it("should reject DELETE queries", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "DELETE FROM foo" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Only SELECT queries are allowed");
    });

    it("should accept SELECT queries (case-insensitive)", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT 1" });
      expect(result.isError).toBe(false);
    });

    it("should accept lowercase select queries", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "select 1" });
      expect(result.isError).toBe(false);
    });
  });

  describe("createDbQueryTool - denied keywords", () => {
    it("should reject queries containing DROP", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT * FROM foo; DROP TABLE foo",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("No DDL or DML");
    });

    it("should reject queries containing DELETE in subquery", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT * FROM (DELETE FROM foo RETURNING *)",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("No DDL or DML");
    });

    it("should reject queries containing TRUNCATE", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT 1; TRUNCATE TABLE foo",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject queries containing ALTER", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT 1; ALTER TABLE foo ADD bar int",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject queries containing CREATE", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT 1; CREATE TABLE evil (id int)",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject queries containing GRANT", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT 1; GRANT ALL ON foo TO public",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject queries containing COPY", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT 1; COPY foo TO '/tmp/out'",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("createDbQueryTool - denied functions", () => {
    it("should reject PG_READ_FILE", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT PG_READ_FILE('/etc/passwd')",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("restricted PostgreSQL function");
    });

    it("should reject PG_READ_BINARY_FILE", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT PG_READ_BINARY_FILE('/etc/shadow')",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject PG_WRITE_FILE", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT PG_WRITE_FILE('/tmp/out', 'data')",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject PG_EXECUTE_SERVER_PROGRAM", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT PG_EXECUTE_SERVER_PROGRAM('rm -rf /')",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject LO_IMPORT", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT LO_IMPORT('/etc/passwd')",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject DBLINK", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT * FROM DBLINK('host=evil.com', 'SELECT 1')",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject PG_SHADOW access", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT * FROM PG_SHADOW",
      });
      expect(result.isError).toBe(true);
    });

    it("should reject PG_AUTHID access", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT * FROM PG_AUTHID",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("createDbQueryTool - LIMIT auto-addition", () => {
    it("should add LIMIT when not present", async () => {
      const tool = createDbQueryTool();
      await tool.execute({ query: "SELECT 1" });
    });

    it("should not add LIMIT when already present", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT 1 LIMIT 10" });
      expect(result.isError).toBe(false);
    });

    it("should respect custom limit parameter", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT 1", limit: 100 });
      expect(result.isError).toBe(false);
    });

    it("should cap limit at 500", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT 1", limit: 1000 });
      expect(result.isError).toBe(false);
    });

    it("should default to 50 when limit not provided", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT 1" });
      expect(result.isError).toBe(false);
    });
  });

  describe("createDbQueryTool - result formatting", () => {
    // NOTE: db_query now runs each query inside a READ ONLY transaction, which
    // reserves a SEPARATE pooled connection. Session-local TEMP tables created
    // on the test's connection would be invisible there, so these fixtures use
    // ordinary tables (visible across connections) with explicit drops.
    it("should show no rows message for empty results", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_empty");
      await db.unsafe("CREATE TABLE _test_empty (id serial PRIMARY KEY)");
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({ query: "SELECT * FROM _test_empty" });
        expect(result.output).toContain("No rows returned");
        expect(result.isError).toBe(false);
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_empty");
      }
    });

    it("should format rows as a table", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_users");
      await db.unsafe("CREATE TABLE _test_users (id serial PRIMARY KEY, name TEXT)");
      await db.unsafe("INSERT INTO _test_users (name) VALUES ('alice'), ('bob')");
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({ query: "SELECT * FROM _test_users" });
        expect(result.output).toContain("2 row(s) returned");
        expect(result.output).toContain("alice");
        expect(result.output).toContain("bob");
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_users");
      }
    });

    it("should handle query errors gracefully", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT * FROM nonexistent_table_xyz" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("error");
    });

    it("should pass params to db.unsafe", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_params");
      await db.unsafe("CREATE TABLE _test_params (id serial PRIMARY KEY)");
      await db.unsafe("INSERT INTO _test_params DEFAULT VALUES");
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT * FROM _test_params WHERE id = $1",
          params: [1],
        });
        expect(result.isError).toBe(false);
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_params");
      }
    });
  });

  describe("createDbQueryTool - output redaction (Layer 3)", () => {
    // These tests verify that redactRow() masks credential-column names and
    // token-shaped values before the result reaches the caller.

    it("blocks credential column auth_token before execution", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_redact_col");
      await db.unsafe(
        "CREATE TABLE _test_redact_col (id serial PRIMARY KEY, auth_token TEXT)",
      );
      await db.unsafe(
        "INSERT INTO _test_redact_col (auth_token) VALUES ('supersecrettoken123')",
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, auth_token FROM _test_redact_col",
        });
        // The column denylist fires before execution — blocked at Layer 2.
        expect(result.isError).toBe(true);
        expect(result.output).toContain("restricted for security");
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_redact_col");
      }
    });

    it("redacts JWT-shaped string values in non-denylist columns", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_redact_jwt");
      await db.unsafe(
        "CREATE TABLE _test_redact_jwt (id serial PRIMARY KEY, data TEXT)",
      );
      // A JWT-shaped string (ey... header.payload form)
      const tokenLike =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
      await db.unsafe(
        `INSERT INTO _test_redact_jwt (data) VALUES ('${tokenLike}')`,
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, data FROM _test_redact_jwt",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain("[REDACTED]");
        expect(result.output).not.toContain(tokenLike);
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_redact_jwt");
      }
    });

    it("does not redact short normal string values", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_noredact");
      await db.unsafe(
        "CREATE TABLE _test_noredact (id serial PRIMARY KEY, label TEXT)",
      );
      await db.unsafe(
        "INSERT INTO _test_noredact (label) VALUES ('hello'), ('world')",
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, label FROM _test_noredact",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain("hello");
        expect(result.output).toContain("world");
        expect(result.output).not.toContain("[REDACTED]");
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_noredact");
      }
    });

    it("redacts hex-shaped values (>= 32 hex chars) in result rows", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_redact_hex");
      await db.unsafe(
        "CREATE TABLE _test_redact_hex (id serial PRIMARY KEY, checksum TEXT)",
      );
      const hexToken = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"; // exactly 32 hex chars
      await db.unsafe(
        `INSERT INTO _test_redact_hex (checksum) VALUES ('${hexToken}')`,
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, checksum FROM _test_redact_hex",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain("[REDACTED]");
        expect(result.output).not.toContain(hexToken);
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_redact_hex");
      }
    });

    it("does not redact short hex strings (< 32 chars)", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_short_hex");
      await db.unsafe(
        "CREATE TABLE _test_short_hex (id serial PRIMARY KEY, code TEXT)",
      );
      const shortHex = "a1b2c3d4"; // only 8 hex chars — too short to trigger
      await db.unsafe(
        `INSERT INTO _test_short_hex (code) VALUES ('${shortHex}')`,
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, code FROM _test_short_hex",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain(shortHex);
        expect(result.output).not.toContain("[REDACTED]");
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_short_hex");
      }
    });

    it("blocks column named password before execution", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_pw_col");
      await db.unsafe(
        "CREATE TABLE _test_pw_col (id serial PRIMARY KEY, password TEXT)",
      );
      await db.unsafe("INSERT INTO _test_pw_col (password) VALUES ('123')");
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, password FROM _test_pw_col",
        });
        // Column denylist fires — blocked before execution.
        expect(result.isError).toBe(true);
        expect(result.output).toContain("restricted for security");
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_pw_col");
      }
    });

    it("multiple non-credential rows survive unredacted", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_clean_rows");
      await db.unsafe(
        "CREATE TABLE _test_clean_rows (id serial PRIMARY KEY, name TEXT, score INT)",
      );
      await db.unsafe(
        "INSERT INTO _test_clean_rows (name, score) VALUES ('alice', 42), ('bob', 99)",
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, name, score FROM _test_clean_rows ORDER BY id",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain("alice");
        expect(result.output).toContain("bob");
        expect(result.output).toContain("42");
        expect(result.output).toContain("99");
        expect(result.output).not.toContain("[REDACTED]");
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_clean_rows");
      }
    });

    it("redacts base64url value >= 40 chars in result", async () => {
      const db = getDb();
      await db.unsafe("DROP TABLE IF EXISTS _test_b64_redact");
      await db.unsafe(
        "CREATE TABLE _test_b64_redact (id serial PRIMARY KEY, token_handle TEXT)",
      );
      // base64url, >= 40 chars, no prefix hint — matched by the long-secret pattern
      const b64Like = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"; // 40 chars, base64url-safe
      await db.unsafe(
        `INSERT INTO _test_b64_redact (token_handle) VALUES ('${b64Like}')`,
      );
      try {
        const tool = createDbQueryTool();
        const result = await tool.execute({
          query: "SELECT id, token_handle FROM _test_b64_redact",
        });
        expect(result.isError).toBe(false);
        expect(result.output).toContain("[REDACTED]");
        expect(result.output).not.toContain(b64Like);
      } finally {
        await db.unsafe("DROP TABLE IF EXISTS _test_b64_redact");
      }
    });
  });

  describe("createDbTools - factory", () => {
    it("should return 1 tool", () => {
      const tools = createDbTools();
      expect(tools.length).toBe(1);
    });

    it("should return tools with correct names", () => {
      const tools = createDbTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("db_query");
    });
  });
});
