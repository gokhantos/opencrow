import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";
import { inputError, permissionError, serviceError } from "./error-helpers";

// ============================================================================
// Database Query Tool
// ============================================================================

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
        return inputError("Error: query is required");
      }
      const query = rawQuery.trim();
      const params = (input.params as (string | number)[]) || [];
      const limit = Math.min((input.limit as number) || 50, 500);

      // Security: Only allow SELECT queries (strip leading whitespace, comments)
      const stripped = query.replace(/^(\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*/g, "").trimStart();
      if (!/^SELECT\b/i.test(stripped)) {
        return permissionError(
          "Only SELECT queries are allowed for safety. Use mcp__dbhub__execute_sql for write operations.",
        );
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
        return permissionError(
          "Only read-only SELECT queries are allowed. No DDL or DML operations.",
        );
      }

      if (DENIED_FUNCTION_PATTERN.test(decommented)) {
        return permissionError(
          "Query uses a restricted PostgreSQL function. Access to system catalog functions and file I/O is not allowed.",
        );
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
        return serviceError(`Query error: ${msg}`);
      }
    },
  };
}

// Export all tools
export function createDbTools(): ToolDefinition[] {
  return [createDbQueryTool()];
}