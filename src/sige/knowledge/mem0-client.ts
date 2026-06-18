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

// A transport-level failure means the Mem0 service is unreachable (not
// configured, container down, DNS failure). These are distinct from
// Mem0ApiError, which is a structured HTTP response from a reachable server.
// How long the breaker stays fully open before letting a single probe through.
const BREAKER_COOLDOWN_MS = 30_000;

function isConnectionError(err: unknown): boolean {
  if (err instanceof Mem0ApiError) return false;
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    err.name === "ConnectionRefused" ||
    err.name === "TypeError" ||
    msg.includes("unable to connect") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to fetch")
  );
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class Mem0Client {
  private readonly baseUrl: string;

  // Optional shared bearer token. The mem0 sidecar has no upstream auth
  // (GHSA-jfv9-68m5-gjjr); when set, this is sent as `Authorization: Bearer
  // <token>` on every request. Never logged.
  private readonly apiToken?: string;

  // Circuit breaker: once a transport-level failure proves the service is
  // unreachable, short-circuit subsequent requests instead of re-dialing a dead
  // endpoint on every graph query. SIGE degrades to an empty graph gracefully,
  // so failing fast beats retry-amplifying a known-down service across dozens of
  // expert/social agents.
  //
  // Half-open recovery: after BREAKER_COOLDOWN_MS, exactly one request is let
  // through as a probe (single-flight via `probing`). If it reaches the server
  // the breaker closes and Mem0 resumes; if it fails the cooldown restarts. This
  // lets a transient startup race (Mem0 not ready yet) heal without a process
  // restart, while still bounding dials to one per cooldown window.
  private unavailable = false;
  private openedAt = 0;
  private probing = false;

  constructor(config: { readonly baseUrl: string; readonly apiToken?: string }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    // Treat empty/whitespace token as absent so we never send "Bearer ".
    // Store the trimmed value: the sidecar strips its expected token, so
    // surrounding whitespace must not survive here or it would mismatch.
    const trimmedToken = config.apiToken?.trim();
    this.apiToken = trimmedToken ? trimmedToken : undefined;
  }

  /** True while the circuit breaker is open (short-circuiting requests). */
  isUnavailable(): boolean {
    return this.unavailable;
  }

  /** Endpoint reachable → close the breaker (even on an HTTP 4xx/5xx). */
  private recordReachable(): void {
    if (this.unavailable) {
      log.info("Mem0 reachable again — closing circuit breaker", { baseUrl: this.baseUrl });
    }
    this.unavailable = false;
    this.openedAt = 0;
    this.probing = false;
  }

  /** Transport-level failure → (re)open the breaker and restart the cooldown. */
  private recordUnreachable(): void {
    if (!this.unavailable) {
      log.warn("Mem0 unreachable — opening circuit breaker, skipping graph", {
        baseUrl: this.baseUrl,
      });
    }
    this.unavailable = true;
    this.openedAt = Date.now();
    this.probing = false;
  }

  // ─── Low-level fetch ───────────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    // Circuit breaker. While open, short-circuit — unless the cooldown has
    // elapsed and no probe is in flight, in which case THIS request becomes the
    // single half-open probe (check-and-set is synchronous, so concurrent
    // callers can't both win the probe).
    if (this.unavailable) {
      if (this.probing || Date.now() - this.openedAt < BREAKER_COOLDOWN_MS) {
        throw new Error("Mem0 unavailable (circuit breaker open)");
      }
      this.probing = true;
    }

    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120_000); // 2 min timeout

    const init: RequestInit = {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      // Transport-level failure → (re)open the breaker so the rest of the
      // session skips Mem0 instead of failing one query at a time. A probe that
      // fails any other way still clears `probing` so the cooldown restarts.
      if (isConnectionError(err)) {
        this.recordUnreachable();
      } else if (this.probing) {
        this.probing = false;
        this.openedAt = Date.now();
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // fetch resolved → the endpoint is reachable (even a 4xx/5xx is a live
    // server), so close the breaker / complete a successful probe.
    this.recordReachable();

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
      // Once the breaker is open, every call fails the same way — don't spam.
      if (this.unavailable) log.debug("addMemory skipped (Mem0 unavailable)");
      else log.error("addMemory failed", { err });
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
    readonly filters?: Record<string, unknown>;
  }): Promise<Mem0SearchResult> {
    // The self-hosted mem0 OSS server accepts a top-level `filters` object on
    // /v1/memories/search/ for simple metadata-equality matching (top-level keys
    // only; equality/inequality/containment — no nested paths, array matching, or
    // numeric comparisons). Support is version-dependent and silently ignored by
    // older server builds, so callers MUST also apply a client-side post-filter
    // as the net rather than trusting server-side filtering alone. Omitting
    // `filters` produces a byte-identical request body to before this field
    // existed (conditional spread below).
    const body = {
      query: params.query,
      user_id: params.userId,
      limit: params.limit ?? 30,
      enable_graph: params.enableGraph ?? true,
      ...(params.filters ? { filters: params.filters } : {}),
    };

    let res: Mem0ApiSearchResponse | undefined;

    try {
      res = await this.requestWithRetry<Mem0ApiSearchResponse>("POST", "/v1/memories/search/", body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Once the breaker is open, every call fails the same way — don't spam.
      if (this.unavailable) log.debug("search skipped (Mem0 unavailable)", { query: params.query });
      else log.error("search failed", { err, query: params.query });
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
