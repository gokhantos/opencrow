import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";

// ============================================================================
// Database Query Tool
// ============================================================================

interface TableInfo {
  table_name: string;
  table_schema: string;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
}

export function createDbQueryTool(): ToolDefinition {
  return {
    name: "db_query",
    description:
      "Execute read-only SQL queries against the OpenCrow database. Use for exploring data, debugging, or answering questions about stored data. Only SELECT queries are allowed for safety.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "SQL query to execute (SELECT only). Use $1, $2 for parameterized values.",
        },
        params: {
          type: "array",
          description: "Optional parameters for the query (replaces $1, $2, etc.)",
          items: { type: ["string", "number"] },
        },
        limit: {
          type: "number",
          description: "Max rows to return (default 50, max 500). Added automatically if not in query.",
        },
      },
      required: ["query"],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const rawQuery = input.query as string | undefined;
      if (!rawQuery) {
        return { output: "Error: query is required", isError: true };
      }
      const query = rawQuery.trim();
      const params = (input.params as (string | number)[]) || [];
      const limit = Math.min((input.limit as number) || 50, 500);

      // Security: Only allow SELECT queries (strip leading whitespace, comments)
      const stripped = query.replace(/^(\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*/g, "").trimStart();
      if (!/^SELECT\b/i.test(stripped)) {
        return {
          output: "Only SELECT queries are allowed for safety. Use mcp__dbhub__execute_sql for write operations.",
          isError: true,
        };
      }

      // Block CTEs that could hide write operations (WITH ... DELETE/UPDATE/INSERT)
      if (/\bWITH\b[\s\S]*?\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i.test(query)) {
        return {
          output: "CTEs with write operations are not allowed. Only pure SELECT queries permitted.",
          isError: true,
        };
      }

      // Prevent dangerous operations using word-boundary regex (not bypassable with comments/whitespace)
      const DENIED_KEYWORD_PATTERN = /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|COPY)\b/i;
      const DENIED_FUNCTION_PATTERN = /\b(PG_READ_FILE|PG_READ_BINARY_FILE|PG_WRITE_FILE|PG_EXECUTE_SERVER_PROGRAM|LO_IMPORT|LO_EXPORT|DBLINK|PG_STAT_ACTIVITY|PG_AUTHID|PG_SHADOW|PG_ROLES|PG_USER)\b/i;

      // Strip SQL comments before checking keywords (prevents bypass via /* */ or --)
      const decommented = query
        .replace(/--[^\n]*/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");

      if (DENIED_KEYWORD_PATTERN.test(decommented)) {
        return {
          output: "Only read-only SELECT queries are allowed. No DDL or DML operations.",
          isError: true,
        };
      }

      if (DENIED_FUNCTION_PATTERN.test(decommented)) {
        return {
          output: "Query uses a restricted PostgreSQL function. Access to system catalog functions and file I/O is not allowed.",
          isError: true,
        };
      }

      // Block access to sensitive tables that may contain secrets or credentials
      const SENSITIVE_TABLES = [
        "config_overrides",
        "pg_shadow",
        "pg_authid",
        "pg_auth_members",
      ];
      const lowerDecommented = decommented.toLowerCase();
      const accessedSensitive = SENSITIVE_TABLES.find((t) =>
        new RegExp(`\\b${t}\\b`).test(lowerDecommented),
      );
      if (accessedSensitive) {
        return {
          output: `Access to table "${accessedSensitive}" is restricted for security. This table may contain sensitive configuration.`,
          isError: true,
        };
      }

      // Add LIMIT if not present (use regex to handle whitespace/comments around LIMIT)
      let finalQuery = query;
      if (!/\bLIMIT\s+\d+/i.test(decommented)) {
        finalQuery = `${query} LIMIT ${limit}`;
      }

      try {
        const db = getDb();
        const startTime = Date.now();

        // Security: relies on the regex blocklist above — no DB-level read-only guarantee.
        // db.unsafe() is required here because the query is dynamic (agent-supplied).
        let rows;
        if (params.length > 0) {
          rows = await db.unsafe(finalQuery, params);
        } else {
          rows = await db.unsafe(finalQuery);
        }

        const duration = Date.now() - startTime;

        if (!rows || rows.length === 0) {
          return {
            output: `Query executed in ${duration}ms. No rows returned.`,
            isError: false,
          };
        }

        // Format results as a table
        const columns = Object.keys(rows[0] as Record<string, unknown>);
        const colWidths = columns.map((col) =>
          Math.max(
            col.length,
            ...rows.slice(0, 10).map((row: Record<string, unknown>) => {
              const val = String(row[col] ?? "");
              return Math.min(val.length, 50);
            })
          )
        );

        // Header
        const header = columns
          .map((col, i) => col.padEnd(colWidths[i] ?? col.length))
          .join(" | ");
        const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");

        // Rows
        const maxRows = Math.min(rows.length, 20);
        const rowLines = rows.slice(0, maxRows).map((row: Record<string, unknown>) => {
          return columns
            .map((col, i) => {
              let val = String(row[col] ?? "");
              if (val.length > 50) val = val.slice(0, 47) + "...";
              return val.padEnd(colWidths[i] ?? val.length);
            })
            .join(" | ");
        });

        let output = `${rows.length} row(s) returned in ${duration}ms:\n\n`;
        output += header + "\n";
        output += separator + "\n";
        output += rowLines.join("\n");

        if (rows.length > maxRows) {
          output += `\n... and ${rows.length - maxRows} more rows (use lower limit to see fewer)`;
        }

        return { output, isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Query error: ${msg}`, isError: true };
      }
    },
  };
}

export function createDbListTablesTool(): ToolDefinition {
  return {
    name: "db_list_tables",
    description:
      "List all tables in the OpenCrow database with their schemas. Useful for exploring what data is available.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Filter by schema name (default: public)",
        },
        pattern: {
          type: "string",
          description: "Filter tables by name pattern (case-insensitive)",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const schema = (input.schema as string) || "public";
      const pattern = (input.pattern as string) || "%";

      try {
        const db = getDb();
        const rows = await db`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = ${schema}
            AND table_name ILIKE ${pattern}
          ORDER BY table_name
        ` as TableInfo[];

        if (rows.length === 0) {
          return {
            output: `No tables found in schema "${schema}" matching "${pattern}".`,
            isError: false,
          };
        }

        const tableList = rows.map((r) => `  - ${r.table_name}`).join("\n");
        return {
          output: `Tables in ${schema} (${rows.length}):\n\n${tableList}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error listing tables: ${msg}`, isError: true };
      }
    },
  };
}

export function createDbTableInfoTool(): ToolDefinition {
  return {
    name: "db_table_info",
    description:
      "Show column information for a specific table. Useful for understanding table structure before writing queries.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description: "Table name (can include schema like 'public.messages' or just 'messages')",
        },
      },
      required: ["table"],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const tableInput = (input.table as string).trim();

      // Parse schema.table if provided
      const parts = tableInput.split(".");
      const schema = parts.length > 1 ? parts[0] : "public";
      const table = parts.length > 1 ? parts[1] : parts[0];

      try {
        const db = getDb();
        const rows = await db`
          SELECT
            column_name,
            data_type,
            is_nullable,
            column_default,
            character_maximum_length
          FROM information_schema.columns
          WHERE table_schema = ${schema}
            AND table_name = ${table}
          ORDER BY ordinal_position
        ` as ColumnInfo[];

        if (rows.length === 0) {
          return {
            output: `Table "${schema}.${table}" not found. Use db_list_tables to see available tables.`,
            isError: true,
          };
        }

        const lines = rows.map((col) => {
          const nullable = col.is_nullable === "YES" ? "NULL" : "NOT NULL";
          const def = col.column_default ? ` DEFAULT ${col.column_default}` : "";
          const len = col.character_maximum_length ? `(${col.character_maximum_length})` : "";
          return `  ${col.column_name}: ${col.data_type}${len} ${nullable}${def}`;
        });

        return {
          output: `Columns in ${schema}.${table} (${rows.length}):\n\n${lines.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error getting table info: ${msg}`, isError: true };
      }
    },
  };
}

export function createDbRowCountTool(): ToolDefinition {
  return {
    name: "db_row_counts",
    description:
      "Get row counts for all tables in the database. Useful for understanding data volume.",
    categories: ["analytics", "system"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Schema to query (default: public)",
        },
        min_rows: {
          type: "number",
          description: "Only show tables with at least this many rows (default: 0)",
        },
      },
      required: [],
    },
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const schema = (input.schema as string) || "public";
      const minRows = (input.min_rows as number) || 0;

      try {
        const db = getDb();

        // Get all tables
        const tables = await db`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = ${schema}
            AND table_type = 'BASE TABLE'
          ORDER BY table_name
        ` as TableInfo[];

        // Get row counts using estimate for large tables
        const counts: Array<{ table: string; count: number }> = [];

        for (const t of tables) {
          // Try exact count first, fallback to estimate for speed
          let countResult;
          try {
            countResult = await db`
              SELECT COUNT(*) as cnt FROM ${db(t.table_name)}
            `;
          } catch {
            // Fallback to estimate
            countResult = await db`
              SELECT n_live_tup as cnt
              FROM pg_stat_user_tables
              WHERE schemaname = ${schema} AND relname = ${t.table_name}
            `;
          }

          const cnt = Number(countResult[0]?.cnt || 0);
          if (cnt >= minRows) {
            counts.push({ table: t.table_name, count: cnt });
          }
        }

        if (counts.length === 0) {
          return {
            output: `No tables with >= ${minRows} rows found in schema "${schema}".`,
            isError: false,
          };
        }

        // Sort by count descending
        counts.sort((a, b) => b.count - a.count);

        const lines = counts.map((c) => {
          const countStr = c.count.toLocaleString();
          return `  ${c.table}: ${countStr} rows`;
        });

        const total = counts.reduce((sum, c) => sum + c.count, 0);

        return {
          output: `Row counts in ${schema} (tables with >= ${minRows} rows):\n\n${lines.join("\n")}\n\nTotal: ${total.toLocaleString()} rows across ${counts.length} tables`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error getting row counts: ${msg}`, isError: true };
      }
    },
  };
}

// Export all tools
export function createDbTools(): ToolDefinition[] {
  return [
    createDbQueryTool(),
    createDbListTablesTool(),
    createDbTableInfoTool(),
    createDbRowCountTool(),
  ];
}