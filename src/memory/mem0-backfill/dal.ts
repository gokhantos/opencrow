import type { SQL } from "bun";
import { MEMORY_SOURCE_KINDS } from "../types";
import type { MemorySourceKind } from "../types";

const KIND_SET = new Set<string>(MEMORY_SOURCE_KINDS);

/**
 * Build a PostgreSQL `text[]` array literal for `= ANY(...)`. Bun.sql misformats
 * JS arrays in ANY() (see search.ts), so we hand-build the literal. Every value
 * MUST be a known memory kind (closed enum, `[a-z_]` only), so the literal is
 * injection-safe — we assert this rather than trust the caller.
 */
function kindsArrayLiteral(kinds: readonly MemorySourceKind[]): string {
  for (const k of kinds) {
    if (!KIND_SET.has(k)) {
      throw new Error(`Unknown memory kind in backfill filter: ${String(k)}`);
    }
  }
  return `{${kinds.join(",")}}`;
}

/**
 * Read-only data-access layer for the mem0 backfill.
 *
 * The backfill replays existing Qdrant-indexed memory (tracked in Postgres) into
 * mem0. It reads two tables and NEVER mutates them:
 *   - `memory_sources`: one row per indexed source (id, kind, agent_id, channel,
 *     chat_id, metadata_json, created_at).
 *   - `memory_chunks`: the verbatim chunk text per source, ordered by chunk_index.
 *
 * All functions take the `Bun.sql` handle explicitly (via `getDb()`) so callers
 * control the connection and tests can inject a stub (per the isolated-lane mock
 * seam). Queries are parameterized; the only writes the backfill performs live in
 * the existing `mem0-chunk-map` DAL, not here.
 */

type Db = InstanceType<typeof SQL>;

/** Raw `memory_sources` row as returned by Postgres. */
interface MemorySourceRow {
  readonly id: string;
  readonly kind: string;
  readonly agent_id: string;
  readonly channel: string | null;
  readonly chat_id: string | null;
  readonly metadata_json: string;
  readonly created_at: number;
}

/** Raw `memory_chunks` row as returned by Postgres. */
interface MemoryChunkRow {
  readonly content: string;
  readonly chunk_index: number;
}

/** A source row to backfill, in domain shape. */
export interface BackfillSource {
  readonly id: string;
  readonly kind: MemorySourceKind;
  readonly agentId: string;
  readonly channel: string | null;
  readonly chatId: string | null;
  /** Parsed caller metadata (string values only); `{}` when unparseable. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: number;
}

/** One verbatim chunk of a source, in domain shape. */
export interface BackfillChunk {
  readonly content: string;
  readonly chunkIndex: number;
}

function parseMetadata(json: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function rowToSource(row: MemorySourceRow): BackfillSource {
  return {
    id: row.id,
    kind: row.kind as MemorySourceKind,
    agentId: row.agent_id,
    channel: row.channel,
    chatId: row.chat_id,
    metadata: parseMetadata(row.metadata_json),
    createdAt: Number(row.created_at),
  };
}

/**
 * Page through `memory_sources` in deterministic (created_at, id) order so the
 * backfill is resumable and repeatable. Optional `kinds`/`agentId` filters narrow
 * the set; `limit`/`offset` page it. Returns rows in domain shape.
 *
 * Ordering is stable across runs because (created_at, id) is unique enough — id
 * is a UUID — so re-running with the same offset yields the same page.
 */
export async function readSourcesPage(
  db: Db,
  opts: {
    readonly kinds?: readonly MemorySourceKind[];
    readonly agentId?: string;
    readonly limit: number;
    readonly offset: number;
  },
): Promise<readonly BackfillSource[]> {
  const hasKinds = opts.kinds !== undefined && opts.kinds.length > 0;
  const kindsLit = hasKinds ? kindsArrayLiteral(opts.kinds as readonly MemorySourceKind[]) : "{}";
  const hasAgent = opts.agentId !== undefined;
  const agent = opts.agentId ?? "";

  // Filters are composed via always-true fallbacks (`${!hasX} OR ...`) so the
  // query is a single statement. The kinds array is a hand-built `text[]` literal
  // (Bun.sql misformats JS arrays in ANY()); agent_id is a bound parameter.
  const rows = (await db`
    SELECT id, kind, agent_id, channel, chat_id, metadata_json, created_at
    FROM memory_sources
    WHERE (${!hasKinds} OR kind = ANY(${kindsLit}::text[]))
      AND (${!hasAgent} OR agent_id = ${agent})
    ORDER BY created_at ASC, id ASC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `) as MemorySourceRow[];

  return rows.map(rowToSource);
}

/**
 * Count the sources matching the same filters, for progress reporting and
 * dry-run totals. Mirrors `readSourcesPage`'s WHERE exactly.
 */
export async function countSources(
  db: Db,
  opts: {
    readonly kinds?: readonly MemorySourceKind[];
    readonly agentId?: string;
  },
): Promise<number> {
  const hasKinds = opts.kinds !== undefined && opts.kinds.length > 0;
  const kindsLit = hasKinds ? kindsArrayLiteral(opts.kinds as readonly MemorySourceKind[]) : "{}";
  const hasAgent = opts.agentId !== undefined;
  const agent = opts.agentId ?? "";

  const rows = (await db`
    SELECT COUNT(*)::int AS n
    FROM memory_sources
    WHERE (${!hasKinds} OR kind = ANY(${kindsLit}::text[]))
      AND (${!hasAgent} OR agent_id = ${agent})
  `) as { n: number }[];

  return Number(rows[0]?.n ?? 0);
}

/**
 * Read a source's chunks in `chunk_index` order. The verbatim chunk text is what
 * the Qdrant indexer stored; the backfill replays it into mem0 unchanged.
 */
export async function readChunks(
  db: Db,
  sourceId: string,
): Promise<readonly BackfillChunk[]> {
  const rows = (await db`
    SELECT content, chunk_index
    FROM memory_chunks
    WHERE source_id = ${sourceId}
    ORDER BY chunk_index ASC
  `) as MemoryChunkRow[];

  return rows.map((r) => ({
    content: r.content,
    chunkIndex: Number(r.chunk_index),
  }));
}

/**
 * True when the source already has rows in `mem0_chunk_map` — i.e. it was
 * already backfilled (or live-indexed under the mem0 backend). The backfill
 * skips such sources so a half-run + re-run never double-writes.
 */
export async function isAlreadyBackfilled(
  db: Db,
  sourceId: string,
): Promise<boolean> {
  const rows = (await db`
    SELECT 1 FROM mem0_chunk_map WHERE source_id = ${sourceId} LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}
