import type { ToolDefinition, ToolCategory } from "./types";
import { requireString, getNumber, getEnum, isToolError } from "./input-helpers";
import {
  getTopUnvalidatedIdeas,
  updateIdeaStage,
  getIdeaById,
} from "../sources/ideas/store";

const VALIDATION_STAGES = ["signal", "synthesis", "validated", "archived"] as const;

function createGetUnvalidatedIdeasTool(): ToolDefinition {
  return {
    name: "get_unvalidated_ideas",
    description:
      "Get top-rated ideas that haven't been validated yet. These are in the 'idea' stage with rating >= 3. Review them for competitive viability, market size, and technical feasibility before promoting or archiving.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max ideas to return (default 10, max 20).",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const limit = getNumber(input, "limit", { defaultVal: 10, min: 1, max: 20 });

      try {
        const ideas = await getTopUnvalidatedIdeas(limit);

        if (ideas.length === 0) {
          return { output: "No unvalidated ideas with rating >= 3. Either no ideas have been rated yet, or all rated ideas have been processed.", isError: false };
        }

        const lines = ideas.map((idea, i) => {
          const rating = idea.rating != null ? `${idea.rating}/5` : "unrated";
          const score = idea.quality_score != null ? ` (self-score: ${idea.quality_score.toFixed(1)})` : "";
          return [
            `${i + 1}. ${idea.title} [${idea.category}] — ${rating}${score}`,
            `   Agent: ${idea.agent_id}`,
            `   ID: ${idea.id}`,
            `   ${idea.summary}`,
            `   Sources: ${idea.sources_used || "none listed"}`,
          ].join("\n");
        });

        return {
          output: `${ideas.length} unvalidated ideas (rated 3+ stars):\n\n${lines.join("\n\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching unvalidated ideas: ${msg}`, isError: true };
      }
    },
  };
}

function createValidateIdeaTool(): ToolDefinition {
  return {
    name: "validate_idea",
    description:
      "Move an idea through the pipeline after validation. Use 'validated' for ideas that pass competitive analysis and feasibility check. Use 'archived' for ideas that fail validation. Include your reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The idea ID to validate.",
        },
        stage: {
          type: "string",
          enum: [...VALIDATION_STAGES],
          description: "Target stage: 'validated' (passes checks) or 'archived' (fails). Can also use 'signal' or 'synthesis' for intermediate stages.",
        },
        reasoning: {
          type: "string",
          description: "Why you're moving this idea to this stage. Include competitive findings, feasibility notes, market assessment.",
        },
      },
      required: ["id", "stage", "reasoning"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const id = requireString(input, "id");
      if (isToolError(id)) return id;
      const stage = getEnum(input, "stage", VALIDATION_STAGES);
      if (!stage) {
        return {
          output: `Invalid stage. Must be one of: ${VALIDATION_STAGES.join(", ")}`,
          isError: true,
        };
      }
      const reasoning = requireString(input, "reasoning");
      if (isToolError(reasoning)) return reasoning;

      try {
        const updated = await updateIdeaStage(id, stage);
        if (!updated) {
          return { output: `Idea not found: ${id}`, isError: true };
        }
        return {
          output: `Idea "${updated.title}" moved to stage: ${stage}. Validation reasoning recorded.`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error validating idea: ${msg}`, isError: true };
      }
    },
  };
}

function createGetIdeaDetailTool(): ToolDefinition {
  return {
    name: "get_idea_detail",
    description:
      "Get full details of a specific idea by ID. Use this to read the full reasoning before validating an idea.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The idea ID.",
        },
      },
      required: ["id"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const id = requireString(input, "id");
      if (isToolError(id)) return id;

      try {
        const idea = await getIdeaById(id);
        if (!idea) {
          return { output: `Idea not found: ${id}`, isError: true };
        }

        const rating = idea.rating != null ? `${idea.rating}/5` : "unrated";
        const score = idea.quality_score != null ? `${idea.quality_score.toFixed(1)}` : "none";
        const lines = [
          `Title: ${idea.title}`,
          `Category: ${idea.category}`,
          `Agent: ${idea.agent_id}`,
          `Rating: ${rating} | Self-score: ${score}`,
          `Stage: ${idea.pipeline_stage || "idea"}`,
          `Created: ${new Date(idea.created_at * 1000).toISOString()}`,
          "",
          `Summary:\n${idea.summary}`,
          "",
          `Reasoning:\n${idea.reasoning}`,
          "",
          `Sources: ${idea.sources_used || "none"}`,
        ];

        return { output: lines.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching idea: ${msg}`, isError: true };
      }
    },
  };
}

export function createValidationTools(): readonly ToolDefinition[] {
  return [
    createGetUnvalidatedIdeasTool(),
    createValidateIdeaTool(),
    createGetIdeaDetailTool(),
  ];
}
