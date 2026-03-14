import { retryAsync } from "../../infra/retry";
import { createLogger } from "../../logger";

const log = createLogger("sige:zep-client");

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ZepUser {
  readonly userId: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ZepNode {
  readonly uuid: string;
  readonly name: string;
  readonly entityType: string;
  readonly summary?: string;
  readonly attributes?: Record<string, unknown>;
}

export interface ZepEdge {
  readonly uuid: string;
  readonly sourceNodeUuid: string;
  readonly targetNodeUuid: string;
  readonly relationType: string;
  readonly fact: string;
  readonly weight?: number;
}

export interface ZepEpisode {
  readonly content: string;
  readonly source?: string;
  readonly sourceDescription?: string;
}

export interface ZepMessage {
  readonly role: "human" | "assistant" | "system";
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ZepSearchResult {
  readonly node?: ZepNode;
  readonly edge?: ZepEdge;
  readonly score: number;
  readonly fact?: string;
}

export interface ZepMemorySearchResult {
  readonly fact: string;
  readonly score: number;
  readonly createdAt: string;
}

export interface ZepSessionMemory {
  readonly messages: readonly ZepMessage[];
  readonly facts: readonly string[];
  readonly summary?: string;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class ZepApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, context: string) {
    super(`Zep API error ${status} (${context}): ${body}`);
    this.name = "ZepApiError";
    this.status = status;
    this.body = body;
  }
}

// ─── Internal API Response Shapes ────────────────────────────────────────────

interface ZepApiUser {
  user_id: string;
  metadata?: Record<string, unknown>;
}

interface ZepApiNode {
  uuid: string;
  name: string;
  labels?: readonly string[];
  summary?: string;
  attributes?: Record<string, unknown>;
}

interface ZepApiEdge {
  uuid: string;
  source_node_uuid: string;
  target_node_uuid: string;
  relation_type: string;
  fact: string;
  weight?: number;
}

interface ZepApiSearchResult {
  node?: ZepApiNode;
  edge?: ZepApiEdge;
  score?: number;
  fact?: string;
}

interface ZepApiMemorySearchResult {
  fact: string;
  score?: number;
  created_at: string;
}

interface ZepApiMessage {
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface ZepApiSessionMemory {
  messages?: ZepApiMessage[];
  facts?: string[];
  summary?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mapRole(role: string): "human" | "assistant" | "system" {
  if (role === "human" || role === "assistant" || role === "system") {
    return role;
  }
  return "human";
}

function mapNode(n: ZepApiNode): ZepNode {
  const entityType =
    n.labels && n.labels.length > 0 ? (n.labels[0] ?? "Entity") : "Entity";
  return {
    uuid: n.uuid,
    name: n.name,
    entityType,
    summary: n.summary,
    attributes: n.attributes,
  };
}

function mapEdge(e: ZepApiEdge): ZepEdge {
  return {
    uuid: e.uuid,
    sourceNodeUuid: e.source_node_uuid,
    targetNodeUuid: e.target_node_uuid,
    relationType: e.relation_type,
    fact: e.fact,
    weight: e.weight,
  };
}

function mapSearchResult(r: ZepApiSearchResult): ZepSearchResult {
  return {
    node: r.node ? mapNode(r.node) : undefined,
    edge: r.edge ? mapEdge(r.edge) : undefined,
    score: r.score ?? 0,
    fact: r.fact,
  };
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof ZepApiError && err.status === 429;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ZepClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: { readonly apiKey: string; readonly baseUrl: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  // ─── Low-level fetch ───────────────────────────────────────────────────────

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      Authorization: `Api-Key ${this.apiKey}`,
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

      if (res.status === 401 || res.status === 403) {
        throw new ZepApiError(
          res.status,
          text,
          `${method} ${path} — authentication failure, check ZEP_API_KEY`,
        );
      }

      throw new ZepApiError(res.status, text, `${method} ${path}`);
    }

    // Some Zep endpoints return 200/201 with an empty body on success
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
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<T> {
    return retryAsync(() => this.request<T>(method, path, body), {
      label: `zep:${method} ${path}`,
      attempts: 3,
      minDelayMs: 1_000,
      maxDelayMs: 16_000,
      shouldRetry: isRateLimitError,
    });
  }

  // ─── User Management ──────────────────────────────────────────────────────

  async ensureUser(
    userId: string,
    metadata?: Record<string, unknown>,
  ): Promise<ZepUser> {
    try {
      const existing = await this.requestWithRetry<ZepApiUser>(
        "GET",
        `/api/v2/users/${encodeURIComponent(userId)}`,
      );
      return { userId: existing.user_id, metadata: existing.metadata };
    } catch (err) {
      if (err instanceof ZepApiError && err.status === 404) {
        log.debug("Zep user not found, creating", { userId });
      } else {
        throw err;
      }
    }

    const created = await this.requestWithRetry<ZepApiUser>("POST", "/api/v2/users", {
      user_id: userId,
      metadata: metadata ?? {},
    });

    return { userId: created.user_id, metadata: created.metadata };
  }

  // ─── Episode Ingestion ────────────────────────────────────────────────────

  async addEpisodes(userId: string, episodes: readonly ZepEpisode[]): Promise<void> {
    if (episodes.length === 0) return;

    const payload = {
      episodes: episodes.map((ep) => ({
        content: ep.content,
        source: ep.source,
        source_description: ep.sourceDescription,
      })),
    };

    await this.requestWithRetry<unknown>(
      "POST",
      `/api/v2/users/${encodeURIComponent(userId)}/graph/episodes`,
      payload,
    );

    log.debug("Added Zep episodes", { userId, count: episodes.length });
  }

  // ─── Graph Queries ────────────────────────────────────────────────────────

  async getGraphNodes(userId: string): Promise<ZepNode[]> {
    const res = await this.requestWithRetry<{ nodes?: ZepApiNode[] }>(
      "GET",
      `/api/v2/users/${encodeURIComponent(userId)}/graph/nodes`,
    );
    return (res?.nodes ?? []).map(mapNode);
  }

  async getGraphEdges(userId: string): Promise<ZepEdge[]> {
    const res = await this.requestWithRetry<{ edges?: ZepApiEdge[] }>(
      "GET",
      `/api/v2/users/${encodeURIComponent(userId)}/graph/edges`,
    );
    return (res?.edges ?? []).map(mapEdge);
  }

  async searchGraph(
    userId: string,
    query: string,
    options?: {
      readonly limit?: number;
      readonly scope?: "edges" | "nodes";
    },
  ): Promise<ZepSearchResult[]> {
    const body: Record<string, unknown> = {
      query,
      limit: options?.limit ?? 20,
    };
    if (options?.scope) {
      body.scope = options.scope;
    }

    const res = await this.requestWithRetry<
      ZepApiSearchResult[] | { results?: ZepApiSearchResult[] }
    >(
      "POST",
      `/api/v2/users/${encodeURIComponent(userId)}/graph/search`,
      body,
    );

    const raw: ZepApiSearchResult[] = Array.isArray(res)
      ? res
      : (res?.results ?? []);

    return raw.map(mapSearchResult);
  }

  // ─── Memory Operations ────────────────────────────────────────────────────

  async addMemory(
    userId: string,
    sessionId: string,
    messages: readonly ZepMessage[],
  ): Promise<void> {
    const payload = {
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        metadata: m.metadata,
      })),
    };

    await this.requestWithRetry<unknown>(
      "POST",
      `/api/v2/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/memory`,
      payload,
    );

    log.debug("Added Zep memory messages", {
      userId,
      sessionId,
      count: messages.length,
    });
  }

  async searchMemory(
    userId: string,
    query: string,
    options?: { readonly limit?: number },
  ): Promise<ZepMemorySearchResult[]> {
    const body = { query, limit: options?.limit ?? 20 };

    const res = await this.requestWithRetry<
      ZepApiMemorySearchResult[] | { results?: ZepApiMemorySearchResult[] }
    >(
      "POST",
      `/api/v2/users/${encodeURIComponent(userId)}/memory/search`,
      body,
    );

    const raw: ZepApiMemorySearchResult[] = Array.isArray(res)
      ? res
      : (res?.results ?? []);

    return raw.map((r) => ({
      fact: r.fact,
      score: r.score ?? 0,
      createdAt: r.created_at,
    }));
  }

  // ─── Session Management ───────────────────────────────────────────────────

  async createSession(userId: string, sessionId: string): Promise<void> {
    await this.requestWithRetry<unknown>(
      "POST",
      `/api/v2/users/${encodeURIComponent(userId)}/sessions`,
      { session_id: sessionId },
    );

    log.debug("Created Zep session", { userId, sessionId });
  }

  async getSessionMemory(
    userId: string,
    sessionId: string,
  ): Promise<ZepSessionMemory> {
    const res = await this.requestWithRetry<ZepApiSessionMemory>(
      "GET",
      `/api/v2/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/memory`,
    );

    return {
      messages: (res?.messages ?? []).map((m) => ({
        role: mapRole(m.role),
        content: m.content,
        metadata: m.metadata,
      })),
      facts: res?.facts ?? [],
      summary: res?.summary,
    };
  }

  // ─── Graph Data Retrieval ─────────────────────────────────────────────────

  async getFullGraph(
    userId: string,
  ): Promise<{ readonly nodes: ZepNode[]; readonly edges: ZepEdge[] }> {
    const [nodes, edges] = await Promise.all([
      this.getGraphNodes(userId),
      this.getGraphEdges(userId),
    ]);

    log.debug("Fetched full Zep graph", {
      userId,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    });

    return { nodes, edges };
  }
}
