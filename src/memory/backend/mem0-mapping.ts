import type { Mem0Memory } from "../../sige/knowledge/mem0-client";
import { MEMORY_SOURCE_KINDS } from "../types";
import type {
  MemoryChunk,
  MemorySource,
  MemorySourceKind,
  SearchResult,
} from "../types";

/**
 * Metadata shape stored on every mem0 memory the memory backend writes. mem0
 * round-trips this object verbatim, so search reconstructs the OpenCrow
 * `SearchResult` (chunk + source) entirely from it — there is no Postgres
 * chunk/source row in the mem0 path.
 *
 * String-valued caller metadata is merged in alongside these reserved keys
 * (reserved keys win on collision).
 */
export interface Mem0ChunkMetadata {
  readonly source_type: MemorySourceKind;
  readonly source_id: string;
  readonly agent_id: string;
  readonly chunk_index: number;
  readonly created_at: number;
  readonly channel?: string;
}

const KIND_SET = new Set<string>(MEMORY_SOURCE_KINDS);

function isMemorySourceKind(value: unknown): value is MemorySourceKind {
  return typeof value === "string" && KIND_SET.has(value);
}

/**
 * Build the reserved metadata for one chunk, merging caller-supplied string
 * metadata underneath the reserved keys. `channel` is omitted when absent so the
 * payload shape matches the Qdrant path (which has no channel for scraped pools).
 */
export function buildChunkMetadata(args: {
  readonly kind: MemorySourceKind;
  readonly sourceId: string;
  readonly agentId: string;
  readonly chunkIndex: number;
  readonly createdAt: number;
  readonly channel?: string;
  readonly callerMetadata?: Record<string, string>;
}): Record<string, unknown> {
  const reserved: Record<string, unknown> = {
    source_type: args.kind,
    source_id: args.sourceId,
    agent_id: args.agentId,
    chunk_index: args.chunkIndex,
    created_at: args.createdAt,
  };
  if (args.channel !== undefined) {
    reserved.channel = args.channel;
  }
  // Caller metadata is passthrough context; reserved keys must not be
  // overwritten by it, so they spread last.
  return { ...(args.callerMetadata ?? {}), ...reserved };
}

function readString(
  meta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = meta?.[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(
  meta: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const v = meta?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Reconstruct a `SearchResult` from a mem0 hit using the round-tripped metadata.
 * Returns null when the hit lacks the reserved keys (i.e. it was not written by
 * this backend), so foreign memories are skipped rather than mis-mapped.
 */
export function mem0HitToSearchResult(hit: Mem0Memory): SearchResult | null {
  const meta = hit.metadata;
  const kind = meta?.source_type;
  if (!isMemorySourceKind(kind)) return null;

  const sourceId = readString(meta, "source_id");
  const agentId = readString(meta, "agent_id");
  if (!sourceId || !agentId) return null;

  const chunkIndex = readNumber(meta, "chunk_index") ?? 0;
  const createdAt = readNumber(meta, "created_at") ?? 0;
  const channel = readString(meta, "channel") ?? null;
  const content = hit.memory;

  const chunk: MemoryChunk = {
    id: hit.id,
    sourceId,
    content,
    chunkIndex,
    tokenCount: estimateTokenCount(content),
    createdAt,
  };

  const source: MemorySource = {
    id: sourceId,
    kind,
    agentId,
    channel,
    chatId: null,
    metadata: {},
    createdAt,
  };

  return { chunk, source, score: hit.score ?? 0 };
}
