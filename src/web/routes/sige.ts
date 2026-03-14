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
} from "../../sige/store";
import type { SigeSessionStatus, SigeSessionConfig } from "../../sige/types";

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
  provider: z.enum(["openrouter", "agent-sdk", "alibaba"]).optional(),
  model: z.string().max(200).optional(),
  agentModel: z.string().max(200).optional(),
});

const createSessionSchema = z.object({
  seedInput: z.string().min(1, "seedInput is required").max(10_000),
  config: sessionConfigSchema.optional(),
});

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
  provider: "alibaba",
  model: "qwen/qwen3.5-plus",
  agentModel: "qwen/qwen3.5-plus",
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

    try {
      await createSession({
        id,
        seedInput,
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
      log.info("SIGE session cancelled", { id });
      return c.json({ success: true });
    } catch (err) {
      log.error("Failed to cancel SIGE session", { err, id });
      return c.json({ success: false, error: "Failed to cancel session" }, 500);
    }
  });

  return app;
}
