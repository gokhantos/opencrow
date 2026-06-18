import { SQL } from "bun";
import type { ToolDefinition, ToolCategory } from "./types";
import { inputError, permissionError, serviceError } from "./error-helpers";
import { createLogger } from "../logger";

// ============================================================================
// Database Query Tool — least-privilege edition
// ============================================================================

const logger = createLogger("db-query");

/**
 * Per-query statement timeout (ms) enforced at the PostgreSQL level via
 * `SET LOCAL statement_timeout`. Caps runaway/expensive agent queries.
 */
const QUERY_STATEMENT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Read-only connection (Layer 1 — DB-level enforcement)
// ---------------------------------------------------------------------------

/**
 * Lazily-initialised connection that authenticates as the `opencrow_readonly`
 * PostgreSQL role. Populated on first use when OPENCROW_READONLY_DATABASE_URL
 * is set. The role must be created and granted via the 023_readonly_role
 * migration before this is useful.
 *
 * SECURITY: When the env var is absent this function throws rather than
 * silently falling back to the privileged getDb(). The denylist (Layer 2) is
 * defence-in-depth only — a parser-divergence attack (e.g. U& identifier
 * escapes) can bypass it. The DB-role boundary is the authoritative control;
 * removing it silently would make every Layer-2 bypass exploitable.
 */
let _readonlyDb: InstanceType<typeof SQL> | null = null;

function getReadonlyDb(): InstanceType<typeof SQL> {
  const url = process.env.OPENCROW_READONLY_DATABASE_URL;
  if (!url) {
    throw new Error(
      "OPENCROW_READONLY_DATABASE_URL is not set. " +
        "The db_query tool requires a dedicated read-only database connection " +
        "to enforce least-privilege access. " +
        "Create the opencrow_readonly role (migration 022) and set " +
        "OPENCROW_READONLY_DATABASE_URL in your environment before using this tool.",
    );
  }

  if (!_readonlyDb) {
    _readonlyDb = new SQL({ url, max: 2 });
    logger.warn(
      "db_query: using dedicated read-only DB connection (OPENCROW_READONLY_DATABASE_URL)",
      {},
    );
  }
  return _readonlyDb;
}

// ---------------------------------------------------------------------------
// Code-level denylist / allowlist (Layer 2 — defence-in-depth)
// ---------------------------------------------------------------------------

/**
 * Tables that hold live credentials or secret configuration. Any query that
 * references these — even via schema-qualified or double-quoted identifiers —
 * is rejected before touching the database.
 *
 * Sync this list with the REVOKE statements in 023_readonly_role.sql.
 */
const SENSITIVE_TABLES: readonly string[] = [
  // Application credential tables
  "x_accounts",
  "ph_accounts",
  "reddit_accounts",
  "sdk_sessions",
  "config_overrides",
  // PostgreSQL system catalog (exact names)
  "pg_shadow",
  "pg_authid",
  "pg_auth_members",
  "pg_user_mappings",
  "pg_settings",
  // Information schema (reflection)
  "information_schema",
  "pg_catalog",
];

/**
 * Credential column names. A query that selects or mentions any of these
 * columns is blocked regardless of the table name (column-level guard).
 * Values returned in result rows whose column names are in this set are also
 * redacted before the output reaches the model (Layer 3).
 */
const CREDENTIAL_COLUMNS: readonly string[] = [
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

/**
 * Regex that matches values that look like bearer tokens, cookies, or other
 * opaque secrets. Thresholds are intentionally conservative so that chunked
 * exfil (e.g. substring(...,1,30)) is still caught.
 *
 * Patterns:
 *   - base64url / base64 ≥ 20 chars (down from 40; catches 30-char chunks)
 *   - hex ≥ 16 chars (down from 32; catches 16-char half-tokens)
 *   - JWT header.payload (ey...)
 */
const TOKEN_VALUE_RE =
  /^(?:[A-Za-z0-9+/=_-]{20,}|[0-9a-f]{16,}|ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})$/;

// ---------------------------------------------------------------------------
// Query normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Strip SQL single-line and block comments.
 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Decode PostgreSQL U& unicode-escaped identifier literals.
 *
 * Postgres supports two Unicode escape forms inside U&"..." identifiers:
 *   \XXXX       (exactly 4 hex digits → BMP codepoint)
 *   \+XXXXXX    (exactly 6 hex digits → supplementary codepoint)
 *
 * This function resolves those escapes to their actual characters so that
 * the normalizer can match them against the denylist. It handles both the
 * quoted-identifier form (U&"...") and the string literal form (U&'...').
 */
function decodeUnicodeEscapes(s: string): string {
  // Replace \+XXXXXX (6 hex digits, supplementary plane) first (longer match wins).
  let decoded = s.replace(/\\[+]([0-9a-fA-F]{6})/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  // Replace \XXXX (exactly 4 hex digits, BMP).
  decoded = decoded.replace(/\\([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
  return decoded;
}

/**
 * Detect and hard-reject any query containing Postgres U& identifier or string
 * escapes BEFORE normalisation.  These are decoded by PostgreSQL's parser but
 * left literal by our normalizer if not handled, making every denylist check
 * bypass-able via U&"\0078_accounts" → x_accounts at the DB level.
 *
 * We take the safer route of outright rejecting queries that contain the U&
 * prefix or residual backslash-hex sequences, since legitimate analytics
 * queries never need them.
 *
 * Returns a rejection message or null if the query is clean.
 */
function detectUnicodeEscapeAttack(sql: string): string | null {
  // Reject U&"..." or U&'...' identifier/string escapes (case-insensitive).
  if (/\bU&["']/i.test(sql)) {
    return (
      "Queries containing PostgreSQL U& unicode-escaped identifiers or strings " +
      "(e.g. U&\"\\0078_accounts\") are not allowed. " +
      "Write identifiers as plain ASCII."
    );
  }
  // Also reject residual \\XXXX backslash-hex sequences anywhere in the query
  // (e.g. UESCAPE or manual escape notation). Legitimate queries never need these.
  if (/\\[0-9a-fA-F]{4}/i.test(sql)) {
    return (
      "Queries containing raw hex-escape sequences (e.g. \\0078) are not allowed. " +
      "Write identifiers and strings as plain ASCII."
    );
  }
  return null;
}

/**
 * Produce a canonical lowercase form of `sql` that strips:
 *   - SQL comments
 *   - U& unicode escapes (decoded before lowercasing)
 *   - double-quote identifiers  ("x_accounts" → x_accounts)
 *   - backtick identifiers      (`x_accounts` → x_accounts)
 *   - extra whitespace / newlines
 *   - schema qualifications     (public.x_accounts → x_accounts)
 *
 * Used only for denylist matching — the original query is executed unmodified.
 */
function normalizeForMatching(sql: string): string {
  const stripped = stripComments(sql);
  // Decode U& identifier escapes: U&"...\XXXX..." → resolved chars.
  // strip the U& prefix + surrounding quotes, then decode interior escapes.
  const withoutU = stripped
    .replace(/\bU&"([^"]*)"/gi, (_, body: string) => decodeUnicodeEscapes(body))
    .replace(/\bU&'([^']*)'/gi, (_, body: string) => decodeUnicodeEscapes(body));
  return withoutU
    .replace(/`([^`]*)`/g, "$1") // remove backtick quoting
    .replace(/"([^"]*)"/g, "$1") // remove double-quote quoting
    .replace(/\bpublic\s*\.\s*/gi, "") // strip schema prefix
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// ---------------------------------------------------------------------------
// Output redaction (Layer 3)
// ---------------------------------------------------------------------------

/**
 * Redact credential columns and long token-shaped values from a result row.
 * Returns a new record — never mutates the input.
 */
function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [col, val] of Object.entries(row)) {
    const colLower = col.toLowerCase();
    if (CREDENTIAL_COLUMNS.includes(colLower)) {
      out[col] = "[REDACTED]";
      continue;
    }
    if (typeof val === "string" && TOKEN_VALUE_RE.test(val)) {
      out[col] = "[REDACTED]";
      continue;
    }
    out[col] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

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
          description:
            "SQL query to execute (SELECT only). Use $1, $2 for parameterized values.",
        },
        params: {
          type: "array",
          description: "Optional parameters for the query (replaces $1, $2, etc.)",
          items: { type: ["string", "number"] },
        },
        limit: {
          type: "number",
          description:
            "Max rows to return (default 50, max 500). Added automatically if not in query.",
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
      const params = (input.params as (string | number)[]) ?? [];
      const limit = Math.min((input.limit as number) || 50, 500);

      // ---- Pre-normalisation: reject Postgres U& unicode escape attacks ----
      // This must run before normalizeForMatching() because the bypass relies on
      // the DB parser resolving U&"\0078_accounts" → "x_accounts" while our
      // normalizer leaves the raw escapes literal, making every denylist check
      // miss. We hard-reject rather than trying to decode and check, because the
      // decode is complex (UESCAPE overrides, supplementary planes) and any miss
      // is a critical bypass.
      const unicodeRejectReason = detectUnicodeEscapeAttack(query);
      if (unicodeRejectReason !== null) {
        logger.warn("db_query: rejected U& unicode escape attack", {});
        return permissionError(unicodeRejectReason);
      }

      // ---- Layer 2: normalise then check all guards ----

      // Strip leading comments to verify SELECT opener (existing guard).
      const stripped = query
        .replace(/^(\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*/g, "")
        .trimStart();
      if (!/^SELECT\b/i.test(stripped)) {
        return permissionError("Only SELECT queries are allowed for safety.");
      }

      // Block CTEs that could hide write operations.
      if (
        /\bWITH\b[\s\S]*?\b(DELETE|UPDATE|INSERT|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i.test(
          query,
        )
      ) {
        return permissionError(
          "CTEs with write operations are not allowed. Only pure SELECT queries permitted.",
        );
      }

      // Canonical form used for all subsequent denylist checks.
      const norm = normalizeForMatching(query);

      // Block DDL / DML keywords (case-insensitive on the lowercased norm).
      const DENIED_KEYWORD_RE =
        /\b(drop|delete|update|insert|truncate|alter|create|grant|revoke|copy)\b/;
      if (DENIED_KEYWORD_RE.test(norm)) {
        return permissionError(
          "Only read-only SELECT queries are allowed. No DDL or DML operations.",
        );
      }

      // Block dangerous built-in functions and pg_catalog reflection views.
      // This list is intentionally broad — prefer false-positives over misses.
      const DENIED_FUNCTION_RE =
        /\b(pg_read_file|pg_read_binary_file|pg_write_file|pg_execute_server_program|lo_import|lo_export|dblink|pg_stat_activity|pg_authid|pg_shadow|pg_roles|pg_user|pg_user_mappings|pg_settings|pg_hba_file_rules|pg_ident_file_mappings|pg_stat_ssl|pg_stat_gssapi)\b/;
      if (DENIED_FUNCTION_RE.test(norm)) {
        return permissionError(
          "Query uses a restricted PostgreSQL function or system view. " +
            "Access to system catalog functions, credential views, and file I/O is not allowed.",
        );
      }

      // Block any reference to pg_* catalog tables not explicitly listed above,
      // and the information_schema. This is a pattern-match allowlist inversion:
      // if the normalised query references pg_ or information_schema, reject it.
      // Legitimate analytics queries work against application tables only.
      if (/\bpg_[a-z_]+\b/.test(norm) || /\binformation_schema\b/.test(norm)) {
        logger.warn("db_query: blocked pg_catalog/information_schema reference", {});
        return permissionError(
          "Access to PostgreSQL system catalogs (pg_* tables, information_schema) is restricted. " +
            "Query application tables only.",
        );
      }

      // Block sensitive tables (normalised — quoted identifiers and schema
      // prefixes have already been stripped).
      for (const table of SENSITIVE_TABLES) {
        // Use word-boundary match on the normalised, unquoted form.
        if (new RegExp(`\\b${table}\\b`).test(norm)) {
          logger.warn("db_query: blocked access to sensitive table", { table });
          return permissionError(
            `Access to table "${table}" is restricted for security. This table may contain credentials or sensitive configuration.`,
          );
        }
      }

      // Block credential column names anywhere in the query.
      for (const col of CREDENTIAL_COLUMNS) {
        if (new RegExp(`\\b${col}\\b`).test(norm)) {
          logger.warn("db_query: blocked access to credential column", { col });
          return permissionError(
            `Access to column "${col}" is restricted for security. This column may contain credentials.`,
          );
        }
      }

      // ---- Inject LIMIT if absent ----
      let finalQuery = query;
      if (!/\blimit\s+\d+/i.test(norm)) {
        finalQuery = `${query} LIMIT ${limit}`;
      }

      // ---- Execute inside a READ ONLY transaction ----
      try {
        // getReadonlyDb() throws (fail-closed) when OPENCROW_READONLY_DATABASE_URL
        // is not set. This is intentional: the denylist is defence-in-depth only;
        // without the DB-role boundary a parser-divergence attack that slips past
        // Layer 2 would return real credentials.
        const db = getReadonlyDb();
        const startTime = Date.now();

        // DB-level enforcement: PostgreSQL rejects any write/DDL in READ ONLY
        // mode.  When OPENCROW_READONLY_DATABASE_URL points to the
        // `opencrow_readonly` role, table-level REVOKE is the authoritative
        // guard; the code checks above are defence-in-depth.
        const rawRows = (await db.begin(async (tx) => {
          await tx`SET TRANSACTION READ ONLY`;
          await tx.unsafe(
            `SET LOCAL statement_timeout = ${QUERY_STATEMENT_TIMEOUT_MS}`,
          );
          if (params.length > 0) {
            return await tx.unsafe(finalQuery, params);
          }
          return await tx.unsafe(finalQuery);
        })) as Record<string, unknown>[];

        const duration = Date.now() - startTime;

        if (!rawRows || rawRows.length === 0) {
          return {
            output: `Query executed in ${duration}ms. No rows returned.`,
            isError: false,
          };
        }

        // ---- Layer 3: redact credential columns / token-shaped values ----
        const rows = rawRows.map(redactRow);

        // Format results as a plain-text table.
        const firstRow = rows[0];
        if (!firstRow) {
          return {
            output: `Query executed in ${duration}ms. No rows returned.`,
            isError: false,
          };
        }
        const columns = Object.keys(firstRow);
        const colWidths = columns.map((col) =>
          Math.max(
            col.length,
            ...rows.slice(0, 10).map((row) => {
              const val = String(row[col] ?? "");
              return Math.min(val.length, 50);
            }),
          ),
        );

        const header = columns
          .map((col, i) => col.padEnd(colWidths[i] ?? col.length))
          .join(" | ");
        const separator = colWidths.map((w) => "-".repeat(w ?? 1)).join("-+-");

        const maxRows = Math.min(rows.length, 20);
        const rowLines = rows.slice(0, maxRows).map((row) =>
          columns
            .map((col, i) => {
              let val = String(row[col] ?? "");
              if (val.length > 50) val = `${val.slice(0, 47)}...`;
              return val.padEnd(colWidths[i] ?? val.length);
            })
            .join(" | "),
        );

        let output = `${rows.length} row(s) returned in ${duration}ms:\n\n`;
        output += `${header}\n`;
        output += `${separator}\n`;
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
