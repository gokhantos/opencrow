import type { ToolDefinition, ToolCategory } from "./types";
import type { MemoryManager } from "../memory/types";
import { requireString, getString, getNumber, getEnum, isToolError } from "./input-helpers";
import {
  insertIdea,
  getRecentIdeaTitles,
  getIdeaStats,
  getStageCounts,
  updateIdeaStage,
  getIdeas,
  getIdeasByStage,
  getStageTransitions,
} from "../sources/ideas/store";
import { createLogger } from "../logger";

const log = createLogger("tool:ideas");

export function createSaveIdeaTool(agentId: string, memoryManager?: MemoryManager | null): ToolDefinition {
  return {
    name: "save_idea",
    description:
      "Save a generated idea to the database. Use this after researching trends and formulating an idea. Each idea should have a clear title, concise summary, detailed reasoning explaining the opportunity, sources that informed it, and a category.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short, catchy title for the idea (max 200 chars).",
        },
        summary: {
          type: "string",
          description:
            "Concise 2-3 sentence summary of what the idea is and why it matters.",
        },
        reasoning: {
          type: "string",
          description:
            "Detailed reasoning: what trends/signals led to this idea, target audience, competitive landscape, key differentiators.",
        },
        sources_used: {
          type: "string",
          description:
            'Comma-separated list of sources consulted (e.g. "X timeline, Hacker News, Product Hunt").',
        },
        category: {
          type: "string",
          enum: ["mobile_app", "crypto_project", "ai_app", "open_source", "general"],
          description: "Category for the idea.",
        },
        quality_score: {
          type: "number",
          description: "Self-assessed quality score: average of your scoring dimensions (1.0-5.0).",
        },
      },
      required: ["title", "summary", "reasoning", "category"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const title = requireString(input, "title", { maxLength: 200 });
      if (isToolError(title)) return title;
      const summary = requireString(input, "summary");
      if (isToolError(summary)) return summary;
      const reasoning = requireString(input, "reasoning");
      if (isToolError(reasoning)) return reasoning;
      const category = requireString(input, "category");
      if (isToolError(category)) return category;
      const sourcesUsed = getString(input, "sources_used", { allowEmpty: true }) ?? "";
      const rawScore = input.quality_score != null ? Number(input.quality_score) : undefined;
      const qualityScore = rawScore != null && !isNaN(rawScore)
        ? Math.min(Math.max(rawScore, 1), 5)
        : 1;

      try {
        const idea = await insertIdea({
          agent_id: agentId,
          title,
          summary,
          reasoning,
          sources_used: sourcesUsed,
          category,
          quality_score: qualityScore,
        });

        // Index into Qdrant for semantic dedup
        if (memoryManager) {
          try {
            await memoryManager.indexIdea(agentId, {
              id: idea.id,
              title,
              summary,
              category,
              reasoning,
            });
          } catch (err) {
            log.error("Failed to index idea in memory", { ideaId: idea.id, err });
          }
        }

        return {
          output: `Idea saved successfully (id: ${idea.id}). Title: "${idea.title}"`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error saving idea: ${msg}`, isError: true };
      }
    },
  };
}

function createGetPreviousIdeasTool(agentId: string): ToolDefinition {
  return {
    name: "get_previous_ideas",
    description:
      "Get a compact list of your previously generated idea titles and categories. Call this FIRST before generating new ideas to avoid duplicates. Use this list ONLY to avoid repeating past ideas. Prioritize novelty and unexplored directions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max ideas to return (default 50).",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      try {
        const limit = getNumber(input, "limit", { defaultVal: 50, min: 1, max: 100 });
        const ideas = await getRecentIdeaTitles(agentId, limit);

        if (ideas.length === 0) {
          return {
            output: "No previous ideas found. You are starting fresh.",
            isError: false,
          };
        }

        const lines = ideas.map((idea) => {
          return `- ${idea.title} (${idea.category})`;
        });

        return {
          output: `${ideas.length} previous ideas:\n${lines.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          output: `Error fetching previous ideas: ${msg}`,
          isError: true,
        };
      }
    },
  };
}

const PIPELINE_STAGES = ["idea", "signal", "synthesis", "validated", "archived"] as const;

function createGetIdeaStatsTool(): ToolDefinition {
  return {
    name: "get_idea_stats",
    description:
      "Get aggregate statistics about generated ideas: counts by agent and category, plus pipeline stage breakdown. Useful for understanding what's been generated and where ideas sit in the pipeline.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(): Promise<{ output: string; isError: boolean }> {
      try {
        const [stats, stages] = await Promise.all([
          getIdeaStats(),
          getStageCounts(),
        ]);

        const lines: string[] = [];

        if (stats.length > 0) {
          lines.push("By agent & category:");
          for (const s of stats) {
            lines.push(`  ${s.agent_id} / ${s.category}: ${s.count}`);
          }
        }

        if (stages.length > 0) {
          lines.push("\nBy pipeline stage:");
          for (const s of stages) {
            lines.push(`  ${s.stage}: ${s.count}`);
          }
        }

        if (lines.length === 0) {
          return { output: "No ideas in the database yet.", isError: false };
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching idea stats: ${msg}`, isError: true };
      }
    },
  };
}

function createUpdateIdeaStageTool(): ToolDefinition {
  return {
    name: "update_idea_stage",
    description:
      "Move an idea through the pipeline. Stages: idea → signal → synthesis → validated → archived.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The idea ID to update.",
        },
        stage: {
          type: "string",
          enum: [...PIPELINE_STAGES],
          description: "Target pipeline stage.",
        },
      },
      required: ["id", "stage"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const id = requireString(input, "id");
      if (isToolError(id)) return id;
      const stage = getEnum(input, "stage", PIPELINE_STAGES);
      if (!stage) {
        return {
          output: `Invalid or missing stage. Must be one of: ${PIPELINE_STAGES.join(", ")}`,
          isError: true,
        };
      }

      try {
        const updated = await updateIdeaStage(id, stage);
        if (!updated) {
          return { output: `Idea not found: ${id}`, isError: true };
        }
        return {
          output: `Idea "${updated.title}" moved to stage: ${stage}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error updating idea stage: ${msg}`, isError: true };
      }
    },
  };
}

function createQueryIdeasTool(): ToolDefinition {
  return {
    name: "query_ideas",
    description:
      "Query ideas with filters. Use to browse ideas by pipeline stage, category, or agent. Returns full idea details including summary and reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          enum: [...PIPELINE_STAGES],
          description: "Filter by pipeline stage.",
        },
        category: {
          type: "string",
          enum: ["mobile_app", "crypto_project", "ai_app", "open_source", "general"],
          description: "Filter by category.",
        },
        limit: {
          type: "number",
          description: "Max results (default 20, max 50).",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const stage = getEnum(input, "stage", PIPELINE_STAGES);
      const category = getEnum(input, "category", ["mobile_app", "crypto_project", "ai_app", "open_source", "general"] as const);
      const limit = getNumber(input, "limit", { defaultVal: 20, min: 1, max: 50 });

      try {
        const ideas = stage
          ? await getIdeasByStage(stage, limit)
          : await getIdeas({ category, limit });

        if (ideas.length === 0) {
          return { output: "No ideas found matching filters.", isError: false };
        }

        const lines = ideas.map((idea, i) => {
          const stage = idea.pipeline_stage || "idea";
          return [
            `${i + 1}. ${idea.title} (${idea.category}) [${stage}]`,
            `  ID: ${idea.id}`,
            `  ${idea.summary}`,
          ].join("\n");
        });

        return {
          output: `${ideas.length} ideas:\n\n${lines.join("\n\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error querying ideas: ${msg}`, isError: true };
      }
    },
  };
}

function createSearchSimilarIdeasTool(memoryManager: MemoryManager): ToolDefinition {
  return {
    name: "search_similar_ideas",
    description:
      "Semantic search over previously generated ideas. Use BEFORE saving a new idea to check if something similar already exists. Returns ideas ranked by semantic similarity. Score > 0.8 means too similar — discard your candidate.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The idea title + summary to search for similarity.",
        },
        limit: {
          type: "number",
          description: "Max results (default 5, max 10).",
        },
      },
      required: ["query"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const query = requireString(input, "query", { maxLength: 1000 });
      if (isToolError(query)) return query;
      const limit = getNumber(input, "limit", { defaultVal: 5, min: 1, max: 10 });

      try {
        const results = await memoryManager.search("shared", query, {
          limit,
          kinds: ["idea"],
        });

        if (results.length === 0) {
          return { output: "No similar ideas found. Safe to proceed.", isError: false };
        }

        const lines = results.map((r, i) => {
          const title = r.source.metadata.title ?? "";
          const cat = r.source.metadata.category ?? "";
          return `${i + 1}. (similarity: ${r.score.toFixed(2)}) ${title} [${cat}]\n  ${r.chunk.content.slice(0, 200)}`;
        });

        const maxScore = Math.max(...results.map((r) => r.score));
        const warning = maxScore > 0.8
          ? "\n\nWARNING: High similarity detected (>0.8). Your idea is likely a duplicate — generate something different."
          : "";

        return { output: lines.join("\n\n") + warning, isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error searching similar ideas: ${msg}`, isError: true };
      }
    },
  };
}

// ============================================================================
// Ideas Pipeline Enhancement Tools
// ============================================================================

function createGetIdeasTrendsTool(): ToolDefinition {
  return {
    name: "get_ideas_trends",
    description:
      "Get stage transition trends over time. Shows how ideas move through the pipeline (idea → signal → synthesis → validated → archived).",
    inputSchema: {
      type: "object",
      properties: {
        days_back: {
          type: "number",
          description: "How many days to look back (default 30, max 90).",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const daysBack = Math.min((input.days_back as number) || 30, 90);

      try {
        const [transitions, stageCounts] = await Promise.all([
          getStageTransitions(daysBack),
          getStageCounts(),
        ]);

        const lines: string[] = [];

        // Current stage distribution
        if (stageCounts.length > 0) {
          lines.push("Current pipeline distribution:");
          for (const s of stageCounts) {
            lines.push(`  ${s.stage}: ${s.count}`);
          }
        }

        // Period breakdown
        if (transitions.length > 0) {
          lines.push(`\nBy period (last ${daysBack} days):`);
          const byPeriod: Record<string, Record<string, number>> = {};
          for (const t of transitions) {
            if (!byPeriod[t.period]) byPeriod[t.period] = {};
            byPeriod[t.period]![t.stage] = t.count;
          }
          for (const [period, stages] of Object.entries(byPeriod).slice(0, 6)) {
            lines.push(`  ${period}: ${JSON.stringify(stages)}`);
          }
        }

        if (lines.length === 0) {
          return { output: "No idea trends data available yet.", isError: false };
        }

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching ideas trends: ${msg}`, isError: true };
      }
    },
  };
}

export function createIdeaTools(agentId: string, memoryManager?: MemoryManager | null): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createSaveIdeaTool(agentId, memoryManager),
    createGetPreviousIdeasTool(agentId),
    createGetIdeaStatsTool(),
    createUpdateIdeaStageTool(),
    createQueryIdeasTool(),
    createGetIdeasTrendsTool(),
  ];

  if (memoryManager) {
    tools.push(createSearchSimilarIdeasTool(memoryManager));
  }

  return tools;
}
