import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import {
  createSession,
  getSession,
  listSessions,
  updateSessionStatus,
  getIdeaScores,
  getPopulationDynamics,
  countPendingSessions,
  getSessionProgressRaw,
} from "../../sige/store";
import { deriveSessionProgress } from "../../sige/progress";
import type { SigeSessionStatus, SigeSessionConfig } from "../../sige/types";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import { getFullGraph } from "../../sige/knowledge/graph-query";
import type { GraphView } from "../../sige/knowledge/graph-query";
import { loadSnapshot, saveSnapshot } from "../../sige/knowledge/graph-snapshot";
import { loadConfig } from "../../config/loader";

const log = createLogger("web:sige");

const TERMINAL_STATUSES = new Set<SigeSessionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const SESSION_STATUSES: readonly SigeSessionStatus[] = [
  "pending",
  "knowledge_construction",
  "game_formulation",
  "expert_game",
  "social_simulation",
  "scoring",
  "report_generation",
  "completed",
  "failed",
  "cancelled",
];

const incentiveWeightsSchema = z.object({
  diversity: z.number().min(0).max(1),
  building: z.number().min(0).max(1),
  surprise: z.number().min(0).max(1),
  accuracyPenalty: z.number().min(0).max(1),
  socialViability: z.number().min(0).max(1),
});

const sessionConfigSchema = z.object({
  expertRounds: z.number().int().min(1).optional(),
  socialAgentCount: z.number().int().min(1).optional(),
  socialRounds: z.number().int().min(1).optional(),
  maxConcurrentAgents: z.number().int().min(1).optional(),
  alpha: z.number().min(0).max(1).optional(),
  incentiveWeights: incentiveWeightsSchema.optional(),
  provider: z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic"]).optional(),
  model: z.string().max(200).optional(),
  agentModel: z.string().max(200).optional(),
});

const createSessionSchema = z.object({
  // Optional: an absent seedInput selects the autonomous (seedless) path. When
  // present it must be non-empty — an empty string is a client error, not an
  // autonomous request.
  seedInput: z
    .string()
    .min(1, "seedInput must be non-empty if provided")
    .max(10_000)
    .optional(),
  config: sessionConfigSchema.optional(),
});

/** Max sessions allowed in the pending queue before new creates are rejected. */
const MAX_PENDING_SESSIONS = 3;

const DEFAULT_CONFIG: SigeSessionConfig = {
  expertRounds: 4,
  socialAgentCount: 20,
  socialRounds: 3,
  maxConcurrentAgents: 4,
  alpha: 0.5,
  incentiveWeights: {
    diversity: 0.25,
    building: 0.2,
    surprise: 0.15,
    accuracyPenalty: 0.1,
    socialViability: 0.3,
  },
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  agentModel: "claude-sonnet-4-6",
};

function mergeConfig(
  partial?: Partial<SigeSessionConfig>,
): SigeSessionConfig {
  if (!partial) return DEFAULT_CONFIG;
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    incentiveWeights: partial.incentiveWeights
      ? { ...DEFAULT_CONFIG.incentiveWeights, ...partial.incentiveWeights }
      : DEFAULT_CONFIG.incentiveWeights,
  };
}

// ─── Graph endpoint — 10s in-memory cache + stampede guard ──────────────────
//
// The Mem0Client is hoisted to module scope alongside the cache so the
// circuit-breaker state (private fields) persists across requests. A per-request
// instantiation would reset the breaker on every call, making it useless.
//
// The `graphPending` map is a simple stampede guard: if a fetch is already
// in-flight for a given userId, subsequent callers wait for the same Promise
// instead of firing independent upstream requests. Combined with the 10 s cache
// TTL this bounds concurrent Mem0 searches to 1 per userId per polling cycle
// regardless of how many browser tabs are open.

interface GraphCacheEntry {
  readonly view: GraphView;
  readonly expiresAt: number;
}

const graphCache = new Map<string, GraphCacheEntry>();
const GRAPH_CACHE_TTL_MS = 10_000;

// In-flight de-duplication: userId → pending Promise<GraphView>
const graphPending = new Map<string, Promise<GraphView>>();

// Module-level Mem0Client singleton — lazily initialised from config on first
// request so the circuit-breaker state (unavailable/openedAt/probing) persists
// across the lifetime of the web process rather than resetting per-request.
let _graphMem0: Mem0Client | null = null;

function getGraphMem0Client(baseUrl: string, apiToken: string | undefined): Mem0Client {
  if (_graphMem0 === null) {
    _graphMem0 = new Mem0Client({ baseUrl, apiToken });
  }
  return _graphMem0;
}

function getCachedGraph(userId: string): GraphView | undefined {
  const entry = graphCache.get(userId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    graphCache.delete(userId);
    return undefined;
  }
  return entry.view;
}

function setCachedGraph(userId: string, view: GraphView): void {
  graphCache.set(userId, { view, expiresAt: Date.now() + GRAPH_CACHE_TTL_MS });
}

const EMPTY_GRAPH: GraphView = { nodes: [], edges: [], summary: "" };

export function createSigeRoutes(): Hono {
  const app = new Hono();

  // ─── POST /api/sige/sessions — Start a new session ──────────────────────────

  app.post("/sige/sessions", async (c) => {
    const body = await c.req.json().catch((err: unknown) => {
      log.warn("Malformed JSON body", { path: c.req.path, err });
      return null;
    });

    if (!body) {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Validation failed",
        },
        400,
      );
    }

    const { seedInput, config: partialConfig } = parsed.data;
    const config = mergeConfig(partialConfig as Partial<SigeSessionConfig>);
    const id = crypto.randomUUID();

    // DoS guard: reject creation when the pending queue is already saturated. The
    // same ceiling applies to human and autonomous enqueues.
    // NOTE: Stage C introduces countRunnableSessions() in run-guard.ts which also
    // counts in-flight sessions; switch this check to it once that lands.
    try {
      const pending = await countPendingSessions();
      if (pending >= MAX_PENDING_SESSIONS) {
        log.warn("Rejecting SIGE session create — pending queue saturated", { pending });
        return c.json(
          { success: false, error: "Too many pending sessions" },
          429,
        );
      }
    } catch (err) {
      log.error("Failed to check pending session count", { err });
      return c.json({ success: false, error: "Failed to create session" }, 500);
    }

    try {
      await createSession({
        id,
        seedInput: seedInput ?? null,
        origin: "human",
        status: "pending",
        configJson: JSON.stringify(config),
      });

      log.info("SIGE session created", { id });
      return c.json({ success: true, data: { id, status: "pending" } }, 201);
    } catch (err) {
      log.error("Failed to create SIGE session", { err });
      return c.json({ success: false, error: "Failed to create session" }, 500);
    }
  });

  // ─── GET /api/sige/sessions — List sessions ──────────────────────────────────

  app.get("/sige/sessions", async (c) => {
    const limitParam = c.req.query("limit");
    const statusParam = c.req.query("status");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "50") || 50, 200));

    if (statusParam && !SESSION_STATUSES.includes(statusParam as SigeSessionStatus)) {
      return c.json(
        {
          success: false,
          error: `status must be one of: ${SESSION_STATUSES.join(", ")}`,
        },
        400,
      );
    }

    try {
      const sessions = await listSessions({
        status: statusParam as SigeSessionStatus | undefined,
        limit,
      });
      return c.json({ success: true, data: { sessions } });
    } catch (err) {
      log.error("Failed to list SIGE sessions", { err });
      return c.json({ success: false, error: "Failed to fetch sessions" }, 500);
    }
  });

  // ─── GET /api/sige/sessions/:id — Get session detail ────────────────────────

  app.get("/sige/sessions/:id", async (c) => {
    const id = c.req.param("id");

    try {
      const session = await getSession(id);
      if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
      }
      return c.json({ success: true, data: session });
    } catch (err) {
      log.error("Failed to get SIGE session", { err, id });
      return c.json({ success: false, error: "Failed to fetch session" }, 500);
    }
  });

  // ─── GET /api/sige/sessions/:id/stream — SSE progress stream ────────────────

  app.get("/sige/sessions/:id/stream", async (c) => {
    const id = c.req.param("id");

    const initial = await getSession(id).catch(() => null);
    if (!initial) {
      return c.json({ success: false, error: "Session not found" }, 404);
    }

    const encoder = new TextEncoder();
    const POLL_INTERVAL_MS = 2_000;
    const SSE_MAX_DURATION_MS = 30 * 60 * 1_000; // 30 minutes

    const stream = new ReadableStream({
      start(controller) {
        let closed = false;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let ttlTimer: ReturnType<typeof setTimeout> | null = null;

        function send(event: unknown): void {
          if (closed) return;
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }

        function close(): void {
          if (closed) return;
          closed = true;
          if (pollTimer !== null) clearTimeout(pollTimer);
          if (ttlTimer !== null) clearTimeout(ttlTimer);
          try { controller.close(); } catch { /* already closed */ }
        }

        function scheduleNextPoll(): void {
          if (closed) return;
          pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
        }

        async function poll(): Promise<void> {
          if (closed) return;
          try {
            const session = await getSession(id);
            if (!session) {
              send({ type: "error", message: "Session not found" });
              close();
              return;
            }
            send({ type: "status", id: session.id, status: session.status });
            if (TERMINAL_STATUSES.has(session.status)) {
              close();
              return;
            }
          } catch (err) {
            log.error("SSE poll error", { err, sessionId: id });
          }
          scheduleNextPoll();
        }

        // Send initial snapshot then begin polling
        send({ type: "status", id: initial.id, status: initial.status });

        if (TERMINAL_STATUSES.has(initial.status)) {
          close();
          return;
        }

        scheduleNextPoll();

        ttlTimer = setTimeout(() => {
          log.warn("SIGE SSE stream TTL expired", { sessionId: id });
          close();
        }, SSE_MAX_DURATION_MS);

        c.req.raw.signal.addEventListener("abort", () => {
          close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // ─── GET /api/sige/sessions/:id/ideas — Get scored ideas ────────────────────

  app.get("/sige/sessions/:id/ideas", async (c) => {
    const id = c.req.param("id");
    const limitParam = c.req.query("limit");
    const minScoreParam = c.req.query("minScore");
    const limit = Math.max(1, Math.min(Number(limitParam ?? "20") || 20, 200));
    const minScore = minScoreParam != null ? Number(minScoreParam) : undefined;

    try {
      const session = await getSession(id);
      if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
      }

      const scores = await getIdeaScores(id);

      const filtered =
        minScore !== undefined && !Number.isNaN(minScore)
          ? scores.filter((s) => s.fusedScore >= minScore)
          : scores;

      const sliced = filtered.slice(0, limit);

      return c.json({ success: true, data: { ideas: sliced } });
    } catch (err) {
      log.error("Failed to get SIGE idea scores", { err, id });
      return c.json({ success: false, error: "Failed to fetch ideas" }, 500);
    }
  });

  // ─── GET /api/sige/sessions/:id/report — Get session report ─────────────────

  app.get("/sige/sessions/:id/report", async (c) => {
    const id = c.req.param("id");

    try {
      const session = await getSession(id);
      if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
      }

      if (session.status !== "completed") {
        return c.json(
          {
            success: false,
            error: `Report is only available for completed sessions (current status: ${session.status})`,
          },
          400,
        );
      }

      return c.json({ success: true, data: { report: session.report ?? "" } });
    } catch (err) {
      log.error("Failed to get SIGE report", { err, id });
      return c.json({ success: false, error: "Failed to fetch report" }, 500);
    }
  });

  // ─── GET /api/sige/sessions/:id/population — Get population dynamics ─────────

  app.get("/sige/sessions/:id/population", async (c) => {
    const id = c.req.param("id");

    try {
      const session = await getSession(id);
      if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
      }

      const population = await getPopulationDynamics(id);
      return c.json({ success: true, data: { population } });
    } catch (err) {
      log.error("Failed to get SIGE population dynamics", { err, id });
      return c.json({ success: false, error: "Failed to fetch population dynamics" }, 500);
    }
  });

  // ─── GET /api/sige/sessions/:id/graph — Knowledge graph (graceful-empty) ────
  //
  // Enhancements over the original MVP:
  //
  // 1. Seed-scoped query: the session's seedInput (if present) is passed as
  //    `scopeQuery` to getFullGraph so Mem0 returns memories relevant to THIS
  //    session's topic rather than a generic blob.
  //
  // 2. Snapshot fallback: after a successful non-empty fetch the graph is
  //    persisted to `sige_graph_snapshots`. When the live fetch returns empty
  //    (or the circuit-breaker is open / fetch throws), we load the last saved
  //    snapshot and return it with `stale: true` so the UI can indicate the
  //    data is not fresh. If there is no snapshot either, we fall back to the
  //    original empty-graph behaviour.

  app.get("/sige/sessions/:id/graph", async (c) => {
    const sessionId = c.req.param("id");

    let config;
    try {
      config = loadConfig();
    } catch (err) {
      log.warn("graph: failed to load config — returning empty graph", { err });
      return c.json({ success: true, data: EMPTY_GRAPH });
    }

    const sigeConfig = config.sige;
    if (!sigeConfig) {
      log.debug("graph: SIGE not configured — returning empty graph");
      return c.json({ success: true, data: EMPTY_GRAPH });
    }

    const userId = sigeConfig.mem0.userId;

    const cached = getCachedGraph(userId);
    if (cached) {
      return c.json({ success: true, data: cached });
    }

    // ── Load the session to extract seedInput for scope-scoped querying ────────
    let scopeQuery: string | undefined;
    try {
      const session = await getSession(sessionId);
      if (session?.seedInput) {
        scopeQuery = session.seedInput;
      }
    } catch (err) {
      // Non-fatal: if the session can't be loaded we fall back to the broad query.
      log.warn("graph: could not load session for scopeQuery — using broad query", {
        err,
        sessionId,
      });
    }

    // ── Helper: serve a stale snapshot (or empty if none exists) ──────────────
    async function serveStaleOrEmpty(): Promise<Response> {
      try {
        const snapshot = await loadSnapshot(userId);
        if (snapshot) {
          log.debug("graph: serving stale snapshot", { userId });
          return c.json({ success: true, stale: true, data: snapshot.graph });
        }
      } catch (snapshotErr) {
        log.warn("graph: snapshot load failed — falling back to empty", { snapshotErr });
      }
      return c.json({ success: true, data: EMPTY_GRAPH });
    }

    // Stampede guard: if another request is already fetching this userId's graph,
    // share the same Promise instead of firing a second upstream call.
    const existing = graphPending.get(userId);
    if (existing) {
      let view: GraphView;
      try {
        view = await existing;
      } catch {
        return serveStaleOrEmpty();
      }
      if (view.nodes.length === 0) {
        return serveStaleOrEmpty();
      }
      return c.json({ success: true, data: view });
    }

    const mem0 = getGraphMem0Client(sigeConfig.mem0.baseUrl, sigeConfig.mem0.apiToken);

    const fetchPromise = getFullGraph(
      mem0,
      userId,
      scopeQuery ? { scopeQuery } : undefined,
    );
    graphPending.set(userId, fetchPromise);

    let view: GraphView;
    try {
      view = await fetchPromise;
    } catch (err) {
      log.warn("graph: getFullGraph failed — serving stale snapshot or empty", { err });
      graphPending.delete(userId);
      return serveStaleOrEmpty();
    }

    graphPending.delete(userId);

    if (view.nodes.length === 0) {
      // Live graph is empty — serve stale snapshot if available
      return serveStaleOrEmpty();
    }

    // Non-empty: cache locally and persist a snapshot for future fallback
    setCachedGraph(userId, view);
    saveSnapshot(userId, view).catch((snapshotErr: unknown) => {
      log.warn("graph: failed to save snapshot (non-fatal)", { snapshotErr });
    });

    return c.json({ success: true, data: view });
  });

  // ─── GET /api/sige/sessions/:id/progress — Step-level progress + stall ───────

  app.get("/sige/sessions/:id/progress", async (c) => {
    const id = c.req.param("id");

    const idSchema = z.string().uuid();
    const idParsed = idSchema.safeParse(id);
    if (!idParsed.success) {
      return c.json({ success: false, error: "Invalid session id" }, 400);
    }

    try {
      const raw = await getSessionProgressRaw(id);
      if (raw === null) {
        return c.json({ success: false, error: "Session not found" }, 404);
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const progress = deriveSessionProgress(raw, nowSec);
      return c.json({ success: true, data: progress });
    } catch (err) {
      log.error("Failed to get SIGE session progress", { err, id });
      return c.json({ success: false, error: "Failed to fetch progress" }, 500);
    }
  });

  // ─── DELETE /api/sige/sessions/:id — Cancel a session ───────────────────────

  app.delete("/sige/sessions/:id", async (c) => {
    const id = c.req.param("id");

    try {
      const session = await getSession(id);
      if (!session) {
        return c.json({ success: false, error: "Session not found" }, 404);
      }

      if (TERMINAL_STATUSES.has(session.status)) {
        return c.json(
          {
            success: false,
            error: `Session cannot be cancelled (current status: ${session.status})`,
          },
          400,
        );
      }

      await updateSessionStatus(id, "cancelled");

      const xForwardedFor = c.req.header("x-forwarded-for");
      const firstHop = xForwardedFor?.split(",")[0]?.trim();
      const clientIp = firstHop ?? c.req.header("x-real-ip") ?? undefined;
      const userAgent = c.req.header("user-agent");
      const referer = c.req.header("referer");
      const origin = c.req.header("origin");

      log.info("SIGE session cancelled", {
        id,
        clientIp,
        userAgent,
        referer,
        origin,
        priorStatus: session.status,
        sessionOrigin: session.origin,
      });
      return c.json({ success: true });
    } catch (err) {
      log.error("Failed to cancel SIGE session", { err, id });
      return c.json({ success: false, error: "Failed to cancel session" }, 500);
    }
  });

  return app;
}
