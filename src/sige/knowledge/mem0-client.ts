import { retryAsync } from "../../infra/retry";
import { createLogger } from "../../logger";

const log = createLogger("sige:mem0-client");

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface Mem0Memory {
  readonly id: string;
  readonly memory: string;
  readonly score?: number;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt?: string;
}

export interface Mem0Relation {
  readonly source: string;
  readonly relationship: string;
  readonly target: string;
}

export interface Mem0AddResult {
  readonly memories: readonly Mem0Memory[];
  readonly relations: readonly Mem0Relation[];
}

export interface Mem0SearchResult {
  readonly memories: readonly Mem0Memory[];
  readonly relations: readonly Mem0Relation[];
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class Mem0ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, context: string) {
    super(`Mem0 API error ${status} (${context}): ${body}`);
    this.name = "Mem0ApiError";
    this.status = status;
    this.body = body;
  }
}

// ─── Internal API Response Shapes ────────────────────────────────────────────

interface Mem0ApiMemory {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

interface Mem0ApiRelation {
  source: string;
  relationship: string;
  target: string;
}

interface Mem0ApiAddResponse {
  results?: Mem0ApiMemory[];
  relations?: Mem0ApiRelation[];
}

interface Mem0ApiSearchResponse {
  results?: Mem0ApiMemory[];
  relations?: Mem0ApiRelation[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapMemory(m: Mem0ApiMemory): Mem0Memory {
  return {
    id: m.id,
    memory: m.memory,
    score: m.score,
    metadata: m.metadata,
    createdAt: m.created_at,
  };
}

function mapRelation(r: Mem0ApiRelation): Mem0Relation {
  return {
    source: r.source,
    relationship: r.relationship,
    target: r.target,
  };
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Mem0ApiError) {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class Mem0Client {
  private readonly baseUrl: string;

  constructor(config: { readonly baseUrl: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  // ─── Low-level fetch ───────────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const init: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };

    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch(() => "(unreadable)");
      throw new Mem0ApiError(res.status, text, `${method} ${path}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as unknown as T;
    }

    const text = await res.text();
    if (!text.trim()) {
      return undefined as unknown as T;
    }

    return JSON.parse(text) as T;
  }

  private async requestWithRetry<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return retryAsync(() => this.request<T>(method, path, body), {
      label: `mem0:${method} ${path}`,
      attempts: 3,
      minDelayMs: 1_000,
      maxDelayMs: 16_000,
      shouldRetry: isRetryableError,
    });
  }

  // ─── Memory Operations ────────────────────────────────────────────────────

  async addMemory(params: {
    readonly content: string;
    readonly userId: string;
    readonly metadata?: Record<string, unknown>;
    readonly enableGraph?: boolean;
  }): Promise<Mem0AddResult> {
    const body = {
      messages: [{ role: "user", content: params.content }],
      user_id: params.userId,
      metadata: params.metadata ?? {},
      enable_graph: params.enableGraph ?? true,
    };

    let res: Mem0ApiAddResponse | undefined;

    try {
      res = await this.requestWithRetry<Mem0ApiAddResponse>("POST", "/v1/memories/", body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("addMemory failed", { err });
      throw new Error(`Mem0 addMemory failed: ${msg}`);
    }

    const memories = (res?.results ?? []).map(mapMemory);
    const relations = (res?.relations ?? []).map(mapRelation);

    log.debug("addMemory: done", {
      userId: params.userId,
      memoriesExtracted: memories.length,
      relationsExtracted: relations.length,
    });

    return { memories, relations };
  }

  async addMemories(params: {
    readonly items: readonly { readonly content: string; readonly metadata?: Record<string, unknown> }[];
    readonly userId: string;
    readonly enableGraph?: boolean;
    readonly maxConcurrent?: number;
  }): Promise<void> {
    const { items, userId, enableGraph, maxConcurrent = 3 } = params;

    if (items.length === 0) return;

    // Process in batches to respect the concurrency limit
    for (let i = 0; i < items.length; i += maxConcurrent) {
      const batch = items.slice(i, i + maxConcurrent);

      await Promise.all(
        batch.map((item) =>
          this.addMemory({
            content: item.content,
            userId,
            metadata: item.metadata,
            enableGraph,
          }),
        ),
      );
    }

    log.debug("addMemories: done", { userId, count: items.length });
  }

  async search(params: {
    readonly query: string;
    readonly userId: string;
    readonly limit?: number;
    readonly enableGraph?: boolean;
  }): Promise<Mem0SearchResult> {
    const body = {
      query: params.query,
      user_id: params.userId,
      limit: params.limit ?? 30,
      enable_graph: params.enableGraph ?? true,
    };

    let res: Mem0ApiSearchResponse | undefined;

    try {
      res = await this.requestWithRetry<Mem0ApiSearchResponse>("POST", "/v1/memories/search/", body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("search failed", { err, query: params.query });
      throw new Error(`Mem0 search failed: ${msg}`);
    }

    const memories = (res?.results ?? []).map(mapMemory);
    const relations = (res?.relations ?? []).map(mapRelation);

    log.debug("search: done", {
      userId: params.userId,
      query: params.query,
      hits: memories.length,
      relations: relations.length,
    });

    return { memories, relations };
  }

  async getAll(params: {
    readonly userId: string;
    readonly limit?: number;
  }): Promise<readonly Mem0Memory[]> {
    const limit = params.limit ?? 100;
    const qs = new URLSearchParams({
      user_id: params.userId,
      limit: String(limit),
    });

    let res: { results?: Mem0ApiMemory[] } | Mem0ApiMemory[] | undefined;

    try {
      res = await this.requestWithRetry<
        { results?: Mem0ApiMemory[] } | Mem0ApiMemory[]
      >("GET", `/v1/memories/?${qs.toString()}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("getAll failed", { err });
      throw new Error(`Mem0 getAll failed: ${msg}`);
    }

    const raw: Mem0ApiMemory[] = Array.isArray(res) ? res : (res?.results ?? []);

    log.debug("getAll: done", { userId: params.userId, count: raw.length });

    return raw.map(mapMemory);
  }

  async deleteMemory(memoryId: string): Promise<void> {
    try {
      await this.requestWithRetry<unknown>("DELETE", `/v1/memories/${encodeURIComponent(memoryId)}/`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("deleteMemory failed", { err, memoryId });
      throw new Error(`Mem0 deleteMemory failed: ${msg}`);
    }

    log.debug("deleteMemory: done", { memoryId });
  }
}
