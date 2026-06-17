import { createLogger } from "../logger";

const log = createLogger("qdrant");

const HEALTH_CHECK_INTERVAL_MS = 30_000; // Re-probe every 30s when down

export interface QdrantPoint {
  readonly id: string;
  readonly vector: readonly number[];
  readonly payload: Readonly<Record<string, string | number>>;
}

export interface QdrantSearchResult {
  readonly id: string;
  readonly score: number;
  readonly payload: Readonly<Record<string, string | number>>;
}

export interface QdrantFilter {
  readonly must?: readonly QdrantFilterCondition[];
}

/** A numeric range condition (Qdrant `range`), used for the importance floor. */
export interface QdrantRangeCondition {
  readonly key: string;
  readonly range: {
    readonly gte?: number;
    readonly lte?: number;
    readonly gt?: number;
    readonly lt?: number;
  };
}

interface QdrantMatchCondition {
  readonly key: string;
  readonly match: { readonly value: string | number };
}

export type QdrantFilterCondition = QdrantMatchCondition | QdrantRangeCondition;

export interface QdrantSearchOptions {
  readonly filter?: QdrantFilter;
  readonly scoreThreshold?: number;
}

export interface QdrantClient {
  readonly available: boolean;
  ensureCollection(name: string, vectorSize: number): Promise<boolean>;
  upsertPoints(
    collection: string,
    points: readonly QdrantPoint[],
  ): Promise<void>;
  searchPoints(
    collection: string,
    vector: readonly number[],
    limit: number,
    opts?: QdrantSearchOptions,
  ): Promise<readonly QdrantSearchResult[]>;
  deletePoints(collection: string, filter: QdrantFilter): Promise<void>;
  /**
   * Patch (merge) payload fields onto existing points without re-upserting
   * their vectors. Used by non-blocking, after-index signal enrichment so the
   * ranking payload can be attached once the LLM has scored a batch. Targets
   * points either by explicit ids or by a filter; a no-op when neither selects
   * anything.
   */
  setPayload(
    collection: string,
    target: SetPayloadTarget,
    payload: Readonly<Record<string, string | number>>,
  ): Promise<void>;
  healthCheck(): Promise<boolean>;
  dispose(): void;
}

/** Selector for {@link QdrantClient.setPayload}: explicit point ids or a filter. */
export type SetPayloadTarget =
  | { readonly ids: readonly string[] }
  | { readonly filter: QdrantFilter };

interface QdrantClientConfig {
  readonly url: string;
  readonly apiKey?: string;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["api-key"] = apiKey;
  }
  return headers;
}

export async function createQdrantClient(
  config: QdrantClientConfig,
): Promise<QdrantClient> {
  const baseUrl = config.url.replace(/\/+$/, "");
  const headers = buildHeaders(config.apiKey);
  let isAvailable = false;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Qdrant ${method} ${path} failed (${resp.status}): ${text}`,
      );
    }

    return resp.json() as Promise<T>;
  }

  async function probeHealth(): Promise<boolean> {
    try {
      const resp = await fetch(`${baseUrl}/healthz`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  function startRecoveryProbe(): void {
    if (recoveryTimer) return;
    recoveryTimer = setInterval(async () => {
      const healthy = await probeHealth();
      if (healthy) {
        isAvailable = true;
        log.info("Qdrant recovered", { url: baseUrl });
        stopRecoveryProbe();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  function stopRecoveryProbe(): void {
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
  }

  function markUnavailable(): void {
    if (isAvailable) {
      isAvailable = false;
      log.warn("Qdrant marked unavailable, starting recovery probe", {
        url: baseUrl,
      });
      startRecoveryProbe();
    }
  }

  // Probe health on creation
  isAvailable = await probeHealth();

  if (isAvailable) {
    log.info("Qdrant connected", { url: baseUrl });
  } else {
    log.warn("Qdrant unavailable — vector search will fall back to text-only", {
      url: baseUrl,
    });
    startRecoveryProbe();
  }

  const client: QdrantClient = {
    get available() {
      return isAvailable;
    },

    async healthCheck(): Promise<boolean> {
      const healthy = await probeHealth();
      if (healthy && !isAvailable) {
        isAvailable = true;
        stopRecoveryProbe();
      } else if (!healthy && isAvailable) {
        markUnavailable();
      }
      return healthy;
    },

    async ensureCollection(name, vectorSize): Promise<boolean> {
      if (!isAvailable) return false;

      try {
        // Check if collection exists
        const resp = await fetch(`${baseUrl}/collections/${name}`, { headers });
        const collectionExists = resp.ok;

        if (!collectionExists) {
          // Create collection with HNSW indexing always on
          try {
            await request("PUT", `/collections/${name}`, {
              vectors: {
                size: vectorSize,
                distance: "Cosine",
              },
              optimizers_config: {
                indexing_threshold: 0,
              },
            });
            log.info("Qdrant collection created", { name, vectorSize });
          } catch (err) {
            // 409 = another process created it between our check and create (race condition)
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("409") || msg.includes("already exists")) {
              log.debug("Collection already created by another process", { name });
            } else {
              throw err;
            }
          }
        } else {
          // Ensure HNSW indexing threshold is set (segments < 20k default
          // would otherwise do flat O(n) scans instead of HNSW)
          await request("PATCH", `/collections/${name}`, {
            optimizers_config: {
              indexing_threshold: 0,
            },
          }).catch((err) =>
            log.warn("Failed to update optimizers_config", { name, error: err }),
          );
        }

        // Ensure payload indices exist (idempotent — Qdrant ignores if already present)
        // Facet fields are populated only when signal-facet extraction is enabled
        // (pipelines.ideas.smart.signalFacets); indexing them is harmless otherwise.
        const keywordIndices = [
          "sourceId",
          "agentId",
          "kind",
          "facetSentiment",
          "facetProblemType",
          "facetTargetAudience",
          "facetEntities",
          // Ranking fields (populated only when signalRanking is enabled).
          "signalImportance",
          "signalCategory",
        ];
        for (const field of keywordIndices) {
          try {
            await request("PUT", `/collections/${name}/index`, {
              field_name: field,
              field_schema: "keyword",
            });
          } catch {
            // Index already exists — ignore
          }
        }

        // Numeric/integer indices for range-filterable ranking payload.
        // `signalImportanceRank` is the ordinal (noise=0 … high=3) used for the
        // importance-floor range filter; `signalRelevance` is the [0,1] score.
        const numericIndices: ReadonlyArray<[string, "integer" | "float"]> = [
          ["signalImportanceRank", "integer"],
          ["signalRelevance", "float"],
        ];
        for (const [field, schema] of numericIndices) {
          try {
            await request("PUT", `/collections/${name}/index`, {
              field_name: field,
              field_schema: schema,
            });
          } catch {
            // Index already exists — ignore
          }
        }

        if (collectionExists) {
          log.debug("Qdrant collection verified", { name });
        }
        return true;
      } catch (error) {
        log.error("Failed to ensure Qdrant collection", { name, error });
        markUnavailable();
        return false;
      }
    },

    async upsertPoints(collection, points): Promise<void> {
      if (!isAvailable || points.length === 0) return;

      try {
        await request("PUT", `/collections/${collection}/points?wait=true`, {
          points: points.map((p) => ({
            id: p.id,
            vector: p.vector,
            payload: p.payload,
          })),
        });
        log.debug("Qdrant upserted points", {
          collection,
          count: points.length,
        });
      } catch (error) {
        log.error("Qdrant upsert failed", { collection, error });
        markUnavailable();
      }
    },

    async searchPoints(
      collection,
      vector,
      limit,
      opts,
    ): Promise<readonly QdrantSearchResult[]> {
      if (!isAvailable) return [];

      try {
        const body: Record<string, unknown> = {
          vector,
          limit,
          with_payload: true,
        };

        if (opts?.filter) {
          body.filter = opts.filter;
        }

        if (opts?.scoreThreshold !== undefined) {
          body.score_threshold = opts.scoreThreshold;
        }

        const result = await request<{ result: QdrantSearchResult[] }>(
          "POST",
          `/collections/${collection}/points/search`,
          body,
        );

        return result.result;
      } catch (error) {
        log.error("Qdrant search failed", { collection, error });
        markUnavailable();
        return [];
      }
    },

    async setPayload(collection, target, payload): Promise<void> {
      if (!isAvailable) return;

      const hasIds = "ids" in target && target.ids.length > 0;
      const hasFilter = "filter" in target;
      if (!hasIds && !hasFilter) return;
      if (Object.keys(payload).length === 0) return;

      try {
        const body: Record<string, unknown> = { payload };
        if (hasIds) {
          body.points = [...(target as { ids: readonly string[] }).ids];
        } else {
          body.filter = (target as { filter: QdrantFilter }).filter;
        }

        await request(
          "POST",
          `/collections/${collection}/points/payload?wait=true`,
          body,
        );
        log.debug("Qdrant set payload", {
          collection,
          by: hasIds ? "ids" : "filter",
        });
      } catch (error) {
        log.error("Qdrant set payload failed", { collection, error });
        markUnavailable();
      }
    },

    async deletePoints(collection, filter): Promise<void> {
      if (!isAvailable) return;

      try {
        await request(
          "POST",
          `/collections/${collection}/points/delete?wait=true`,
          { filter },
        );
        log.debug("Qdrant deleted points", { collection });
      } catch (error) {
        log.error("Qdrant delete failed", { collection, error });
        markUnavailable();
      }
    },

    dispose(): void {
      stopRecoveryProbe();
    },
  };

  return client;
}
