import type { ToolDefinition } from "./types";
import type { EmbeddingProvider } from "../memory/types";
import type { QdrantClient } from "../memory/qdrant";
import { createLogger } from "../logger";

const log = createLogger("tool:semantic-index");

const COLLECTION = "tool_routing";
const VECTOR_SIZE = 512;
// Stable prefix so we can identify tool routing points from memory points
const POINT_ID_PREFIX = "tool-";

export interface SemanticToolIndex {
  init(tools: readonly ToolDefinition[]): Promise<void>;
  search(query: string, limit: number): Promise<readonly string[]>;
  isAvailable(): boolean;
}

async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic UUID from a tool name — Qdrant requires UUID or unsigned int IDs. */
async function toolPointId(name: string): Promise<string> {
  const hex = await hashText(`tool-routing:${name}`);
  // Format as UUID: 8-4-4-4-12
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const SENTINEL_NAME = "__sentinel__";

export function createSemanticToolIndex(
  embeddingProvider: EmbeddingProvider,
  qdrantClient: QdrantClient,
): SemanticToolIndex {
  let ready = false;

  return {
    isAvailable(): boolean {
      return ready && qdrantClient.available;
    },

    async init(tools: readonly ToolDefinition[]): Promise<void> {
      if (!qdrantClient.available) {
        log.warn("Qdrant unavailable — semantic tool routing disabled");
        return;
      }

      const ok = await qdrantClient.ensureCollection(COLLECTION, VECTOR_SIZE);
      if (!ok) {
        log.warn("Failed to ensure tool_routing collection");
        return;
      }

      // Build corpus strings
      const texts = tools.map((t) => `${t.name}: ${t.description}`);
      const corpusHash = await hashText(texts.join("|"));

      // Check if corpus has changed via sentinel point
      const sentinelId = await toolPointId(SENTINEL_NAME);
      try {
        // Use a small non-zero vector to avoid cosine edge cases with zero vectors
        const probeVec = new Array<number>(VECTOR_SIZE).fill(0);
        probeVec[0] = 1;
        const existing = await qdrantClient.searchPoints(
          COLLECTION,
          probeVec,
          1,
          { filter: { must: [{ key: "kind", match: { value: "sentinel" } }] } },
        );
        if (existing.length > 0) {
          const storedHash = existing[0]?.payload?.["corpusHash"];
          if (storedHash === corpusHash) {
            log.info("Tool semantic index up-to-date, skipping re-embed", {
              toolCount: tools.length,
            });
            ready = true;
            return;
          }
        }
      } catch {
        // Sentinel lookup failed — proceed to (re)index
      }

      log.info("Embedding tool descriptions for semantic routing", {
        toolCount: tools.length,
      });

      let embeddings: Float32Array[];
      try {
        embeddings = await embeddingProvider.embed(texts);
      } catch (err) {
        log.error("Failed to embed tool descriptions", { err });
        return;
      }

      // Upsert tool points
      const toolPoints = await Promise.all(
        tools.map(async (tool, i) => ({
          id: await toolPointId(tool.name),
          vector: Array.from(embeddings[i]!),
          payload: { name: tool.name, kind: "tool" },
        })),
      );

      // Upsert sentinel with corpus hash (small non-zero vector for cosine compat)
      const sentinelVec = new Array<number>(VECTOR_SIZE).fill(0);
      sentinelVec[0] = 1;
      const sentinelPoint = {
        id: sentinelId,
        vector: sentinelVec,
        payload: { name: SENTINEL_NAME, kind: "sentinel", corpusHash },
      };

      try {
        await qdrantClient.upsertPoints(COLLECTION, [
          ...toolPoints,
          sentinelPoint,
        ]);
        ready = true;
        log.info("Semantic tool index built", { toolCount: tools.length });
      } catch (err) {
        log.error("Failed to upsert tool vectors", { err });
      }
    },

    async search(query: string, limit: number): Promise<readonly string[]> {
      if (!this.isAvailable()) return [];

      let queryVec: Float32Array;
      try {
        const [vec] = await embeddingProvider.embed([query]);
        if (!vec) return [];
        queryVec = vec;
      } catch (err) {
        log.warn("Failed to embed query for tool routing", { err });
        return [];
      }

      try {
        const results = await qdrantClient.searchPoints(
          COLLECTION,
          Array.from(queryVec),
          limit + 1, // +1 because sentinel might slip through
          { filter: { must: [{ key: "kind", match: { value: "tool" } }] } },
        );

        return results
          .map((r) => String(r.payload["name"] ?? ""))
          .filter((name) => name && name !== "__sentinel__")
          .slice(0, limit);
      } catch (err) {
        log.warn("Semantic tool search failed", { err });
        return [];
      }
    },
  };
}
