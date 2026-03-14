import type { ToolDefinition, ToolCategory } from "./types";
import type { SigeSessionStatus } from "../sige/types";
import {
  createSession,
  getSession,
  listSessions,
  getIdeaScores,
  getPopulationDynamics,
} from "../sige/store";
import { requireString, getString, getNumber, getEnum, isToolError } from "./input-helpers";
import { createLogger } from "../logger";

const log = createLogger("tool:sige");

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

export interface SigeToolDeps {
  readonly generateId: () => string;
  readonly defaultConfigJson: () => string;
}

// ─── sige_start_session ───────────────────────────────────────────────────────

function createStartSessionTool(deps: SigeToolDeps): ToolDefinition {
  return {
    name: "sige_start_session",
    description:
      "Start a new SIGE (Strategic Idea Generation Engine) session. Provide a seed input describing the domain or problem space to explore. An optional config override JSON can fine-tune expert rounds, social agent count, and scoring weights. Returns the new session ID.",
    inputSchema: {
      type: "object",
      properties: {
        seed_input: {
          type: "string",
          description:
            "The domain, problem space, or strategic question to explore (e.g. 'AI productivity tools for remote teams').",
        },
        config_override: {
          type: "string",
          description:
            "Optional JSON string with partial SigeSessionConfig overrides (e.g. '{\"expertRounds\": 3, \"socialAgentCount\": 20}').",
        },
      },
      required: ["seed_input"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const seedInput = requireString(input, "seed_input", { maxLength: 2000 });
      if (isToolError(seedInput)) return seedInput;

      let configJson = deps.defaultConfigJson();

      const configOverride = getString(input, "config_override", { allowEmpty: false });
      if (configOverride !== undefined) {
        try {
          const base = JSON.parse(configJson) as Record<string, unknown>;
          const override = JSON.parse(configOverride) as Record<string, unknown>;
          configJson = JSON.stringify({ ...base, ...override });
        } catch {
          return {
            output: "Invalid config_override: must be valid JSON.",
            isError: true,
          };
        }
      }

      const id = deps.generateId();

      try {
        await createSession({
          id,
          seedInput,
          status: "pending",
          configJson,
        });

        log.info("SIGE session created", { sessionId: id });

        return {
          output: JSON.stringify({ sessionId: id, status: "pending", seedInput }),
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to create SIGE session", { err });
        return { output: `Error creating session: ${msg}`, isError: true };
      }
    },
  };
}

// ─── sige_get_session ─────────────────────────────────────────────────────────

function createGetSessionTool(): ToolDefinition {
  return {
    name: "sige_get_session",
    description:
      "Get the current status and results of a SIGE session by ID. Returns status, config, fused scores summary, and the report markdown if the session has completed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The SIGE session ID to retrieve.",
        },
      },
      required: ["session_id"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const sessionId = requireString(input, "session_id");
      if (isToolError(sessionId)) return sessionId;

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return { output: `Session not found: ${sessionId}`, isError: true };
        }

        const summary = {
          id: session.id,
          seedInput: session.seedInput,
          status: session.status,
          createdAt: session.createdAt.toISOString(),
          finishedAt: session.finishedAt?.toISOString() ?? null,
          fusedScoreCount: session.fusedScores?.length ?? 0,
          hasReport: session.report != null,
          error: session.error ?? null,
          report: session.report ?? null,
        };

        return { output: JSON.stringify(summary, null, 2), isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to get SIGE session", { err, sessionId });
        return { output: `Error fetching session: ${msg}`, isError: true };
      }
    },
  };
}

// ─── sige_list_sessions ───────────────────────────────────────────────────────

function createListSessionsTool(): ToolDefinition {
  return {
    name: "sige_list_sessions",
    description:
      "List recent SIGE sessions with a summary view. Optionally filter by status. Returns session ID, seed input, status, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max sessions to return (default 10, max 50).",
        },
        status: {
          type: "string",
          enum: [...SESSION_STATUSES],
          description: "Filter by session status.",
        },
      },
      required: [],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const limit = getNumber(input, "limit", { defaultVal: 10, min: 1, max: 50 });
      const status = getEnum(input, "status", SESSION_STATUSES);

      try {
        const sessions = await listSessions({ status, limit });

        if (sessions.length === 0) {
          return {
            output: status
              ? `No sessions found with status: ${status}.`
              : "No SIGE sessions found.",
            isError: false,
          };
        }

        const rows = sessions.map((s) => ({
          id: s.id,
          seedInput: s.seedInput.slice(0, 100),
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          finishedAt: s.finishedAt?.toISOString() ?? null,
        }));

        return {
          output: JSON.stringify({ total: rows.length, sessions: rows }, null, 2),
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to list SIGE sessions", { err });
        return { output: `Error listing sessions: ${msg}`, isError: true };
      }
    },
  };
}

// ─── sige_query_game_history ──────────────────────────────────────────────────

function createQueryGameHistoryTool(): ToolDefinition {
  return {
    name: "sige_query_game_history",
    description:
      "Search past SIGE sessions by seed input text to find similar strategic game formulations and their outcomes. Useful for understanding what has been explored before and avoiding redundant sessions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to match against seed inputs of past sessions.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 10, max 30).",
        },
      },
      required: ["query"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const query = requireString(input, "query", { maxLength: 500 });
      if (isToolError(query)) return query;
      const limit = getNumber(input, "limit", { defaultVal: 10, min: 1, max: 30 });

      try {
        // Retrieve recent sessions and filter by seed input text match in-process.
        // The store does not expose a full-text search; we fetch a broader window
        // and match locally to avoid SQL string concatenation.
        const allSessions = await listSessions({ limit: 200 });
        const queryLower = query.toLowerCase();

        const matched = allSessions
          .filter((s) => s.seedInput.toLowerCase().includes(queryLower))
          .slice(0, limit);

        if (matched.length === 0) {
          return {
            output: `No past sessions found matching: "${query}".`,
            isError: false,
          };
        }

        const rows = matched.map((s) => ({
          id: s.id,
          seedInput: s.seedInput,
          status: s.status,
          gameType: s.gameFormulation?.gameType ?? null,
          playerCount: s.gameFormulation?.players.length ?? null,
          fusedScoreCount: s.fusedScores?.length ?? 0,
          createdAt: s.createdAt.toISOString(),
          finishedAt: s.finishedAt?.toISOString() ?? null,
        }));

        return {
          output: JSON.stringify({ total: rows.length, results: rows }, null, 2),
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to query SIGE game history", { err });
        return { output: `Error querying game history: ${msg}`, isError: true };
      }
    },
  };
}

// ─── sige_search_strategic_ideas ─────────────────────────────────────────────

function createSearchStrategicIdeasTool(): ToolDefinition {
  return {
    name: "sige_search_strategic_ideas",
    description:
      "Search SIGE-generated idea scores across all sessions. Filter by minimum fused score to surface only high-quality strategic ideas. Returns idea IDs, scores, and incentive breakdowns.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Session ID or partial text to scope the search. Use a full session ID to search within one session, or leave broad to retrieve top ideas globally.",
        },
        min_score: {
          type: "number",
          description: "Minimum fused score threshold (0.0–1.0, default 0.0).",
        },
        limit: {
          type: "number",
          description: "Max results (default 20, max 50).",
        },
      },
      required: ["query"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const query = requireString(input, "query", { maxLength: 200 });
      if (isToolError(query)) return query;
      const minScore = getNumber(input, "min_score", { defaultVal: 0, min: 0, max: 1 });
      const limit = getNumber(input, "limit", { defaultVal: 20, min: 1, max: 50 });

      try {
        // Resolve candidate session IDs: exact match first, then text fallback.
        let sessionIds: string[] = [];

        const exactSession = await getSession(query);
        if (exactSession) {
          sessionIds = [exactSession.id];
        } else {
          const allSessions = await listSessions({ limit: 200 });
          const queryLower = query.toLowerCase();
          sessionIds = allSessions
            .filter((s) => s.seedInput.toLowerCase().includes(queryLower))
            .map((s) => s.id);
        }

        if (sessionIds.length === 0) {
          return {
            output: `No sessions matched query: "${query}".`,
            isError: false,
          };
        }

        // Gather idea scores across resolved sessions.
        const allScores = (
          await Promise.all(sessionIds.map((sid) => getIdeaScores(sid)))
        ).flat();

        const filtered = allScores
          .filter((s) => (s.fusedScore ?? 0) >= minScore)
          .sort((a, b) => (b.fusedScore ?? 0) - (a.fusedScore ?? 0))
          .slice(0, limit);

        if (filtered.length === 0) {
          return {
            output: `No ideas found with fused score >= ${minScore}.`,
            isError: false,
          };
        }

        return {
          output: JSON.stringify({ total: filtered.length, ideas: filtered }, null, 2),
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to search SIGE strategic ideas", { err });
        return { output: `Error searching strategic ideas: ${msg}`, isError: true };
      }
    },
  };
}

// ─── sige_get_report ──────────────────────────────────────────────────────────

function createGetReportTool(): ToolDefinition {
  return {
    name: "sige_get_report",
    description:
      "Retrieve the full strategic report for a completed SIGE session. Returns the report as markdown. The session must have status 'completed' for a report to be available.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The SIGE session ID to get the report for.",
        },
      },
      required: ["session_id"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const sessionId = requireString(input, "session_id");
      if (isToolError(sessionId)) return sessionId;

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return { output: `Session not found: ${sessionId}`, isError: true };
        }

        if (session.status !== "completed") {
          return {
            output: `Session is not completed (current status: ${session.status}). Report is only available after completion.`,
            isError: true,
          };
        }

        if (!session.report) {
          return {
            output: `Session completed but report is missing for: ${sessionId}`,
            isError: true,
          };
        }

        return { output: session.report, isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to get SIGE report", { err, sessionId });
        return { output: `Error fetching report: ${msg}`, isError: true };
      }
    },
  };
}

// ─── sige_get_population_dynamics ────────────────────────────────────────────

function createGetPopulationDynamicsTool(): ToolDefinition {
  return {
    name: "sige_get_population_dynamics",
    description:
      "Get evolutionary strategy fitness data across generations for a SIGE session. Shows how strategies competed and evolved during the expert game simulation.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The SIGE session ID to retrieve population dynamics for.",
        },
      },
      required: ["session_id"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const sessionId = requireString(input, "session_id");
      if (isToolError(sessionId)) return sessionId;

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return { output: `Session not found: ${sessionId}`, isError: true };
        }

        const dynamics = await getPopulationDynamics(sessionId);

        if (dynamics.length === 0) {
          return {
            output: `No population dynamics data available for session: ${sessionId}`,
            isError: false,
          };
        }

        // Group by generation for a cleaner summary.
        const byGeneration = dynamics.reduce<Record<number, ReadonlyArray<{ strategy: string; fitness: number }>>>(
          (acc, entry) => ({
            ...acc,
            [entry.generation]: [
              ...(acc[entry.generation] ?? []),
              { strategy: entry.strategy, fitness: entry.fitness },
            ],
          }),
          {},
        );

        const generationCount = Object.keys(byGeneration).length;
        const topStrategies = [...dynamics]
          .sort((a, b) => b.fitness - a.fitness)
          .slice(0, 5)
          .map((e) => ({ strategy: e.strategy, fitness: e.fitness, generation: e.generation }));

        return {
          output: JSON.stringify(
            {
              sessionId,
              totalEntries: dynamics.length,
              generationCount,
              topStrategies,
              byGeneration,
            },
            null,
            2,
          ),
          isError: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("Failed to get SIGE population dynamics", { err, sessionId });
        return { output: `Error fetching population dynamics: ${msg}`, isError: true };
      }
    },
  };
}

// ─── Public factory ───────────────────────────────────────────────────────────

export function createSigeTools(
  _agentId: string,
  deps: SigeToolDeps,
): readonly ToolDefinition[] {
  return [
    createStartSessionTool(deps),
    createGetSessionTool(),
    createListSessionsTool(),
    createQueryGameHistoryTool(),
    createSearchStrategicIdeasTool(),
    createGetReportTool(),
    createGetPopulationDynamicsTool(),
  ];
}
