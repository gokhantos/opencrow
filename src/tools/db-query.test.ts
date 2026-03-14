import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";

import {
  createDbQueryTool,
  createDbTools,
} from "./db-query";

describe("db-query tools", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
  });

  afterEach(async () => {
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
    it("should show no rows message for empty results", async () => {
      const db = getDb();
      await db.unsafe("CREATE TEMP TABLE IF NOT EXISTS _test_empty (id serial PRIMARY KEY)");

      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT * FROM _test_empty" });
      expect(result.output).toContain("No rows returned");
      expect(result.isError).toBe(false);
    });

    it("should format rows as a table", async () => {
      const db = getDb();
      await db.unsafe("CREATE TEMP TABLE IF NOT EXISTS _test_users (id serial PRIMARY KEY, name TEXT)");
      await db.unsafe("INSERT INTO _test_users (name) VALUES ('alice'), ('bob')");

      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT * FROM _test_users" });
      expect(result.output).toContain("2 row(s) returned");
      expect(result.output).toContain("alice");
      expect(result.output).toContain("bob");
    });

    it("should handle query errors gracefully", async () => {
      const tool = createDbQueryTool();
      const result = await tool.execute({ query: "SELECT * FROM nonexistent_table_xyz" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("error");
    });

    it("should pass params to db.unsafe", async () => {
      const db = getDb();
      await db.unsafe("CREATE TEMP TABLE IF NOT EXISTS _test_params (id serial PRIMARY KEY)");
      await db.unsafe("INSERT INTO _test_params DEFAULT VALUES");

      const tool = createDbQueryTool();
      const result = await tool.execute({
        query: "SELECT * FROM _test_params WHERE id = $1",
        params: [1],
      });
      expect(result.isError).toBe(false);
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
