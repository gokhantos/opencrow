/**
 * Factory for creating semantic search tools over indexed data sources.
 * Replaces 9 nearly-identical search tool implementations with a single
 * configurable factory while preserving exact API compatibility.
 */

import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type {
  MemoryManager,
  MemorySourceKind,
  SearchResult,
} from "../memory/types";
import { requireString, getNumber, isToolError } from "./input-helpers";

export interface SemanticSearchToolConfig {
  readonly name: string;
  readonly description: string;
  readonly agentId: string;
  readonly kinds: readonly MemorySourceKind[];
  readonly memoryManager: MemoryManager;
  /** Extra input fields beyond query/limit. */
  readonly extraInputFields?: Record<string, Record<string, unknown>>;
  /** Filter results after search (e.g. by source or time). */
  readonly postFilter?: (
    results: readonly SearchResult[],
    input: Record<string, unknown>,
  ) => readonly SearchResult[];
  /** Custom result formatting. Default: "${i}. (score: X.XX)\n{content}" */
  readonly formatResult?: (result: SearchResult, index: number) => string;
  readonly emptyMessage?: string;
  readonly errorPrefix?: string;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  /** Fetch limit * N to allow for post-filter shrinkage. Default 1. */
  readonly fetchMultiplier?: number;
}

export function createSemanticSearchTool(
  config: SemanticSearchToolConfig,
): ToolDefinition {
  const defaultLimit = config.defaultLimit ?? 10;
  const maxLimit = config.maxLimit ?? 20;
  const fetchMultiplier = config.fetchMultiplier ?? 1;
  const emptyMessage = config.emptyMessage ?? "No matching results found.";
  const errorPrefix = config.errorPrefix ?? "Error searching";

  const properties: Record<string, unknown> = {
    query: {
      type: "string",
      description: "Natural language search query.",
    },
    limit: {
      type: "number",
      description: `Max results (default ${defaultLimit}, max ${maxLimit}).`,
    },
    ...config.extraInputFields,
  };

  const defaultFormat = (r: SearchResult, i: number): string =>
    `${i + 1}. (score: ${r.score.toFixed(2)})\n${r.chunk.content}`;

  const formatFn = config.formatResult ?? defaultFormat;

  return {
    name: config.name,
    description: config.description,
    categories: ["research"] as readonly ToolCategory[],
    inputSchema: {
      type: "object",
      properties,
      required: ["query"],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = requireString(input, "query", { maxLength: 1000 });
      if (isToolError(query)) return query;

      const limit = getNumber(input, "limit", {
        defaultVal: defaultLimit,
        min: 1,
        max: maxLimit,
      });

      try {
        const fetchLimit = Math.ceil(limit * fetchMultiplier);
        const searchPromise = config.memoryManager.search(
          config.agentId,
          query,
          { limit: fetchLimit, kinds: config.kinds as MemorySourceKind[] },
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Search timed out (30s)")), 30_000),
        );
        const results = await Promise.race([searchPromise, timeoutPromise]);

        const filtered = config.postFilter
          ? config.postFilter(results, input)
          : results;

        const top = filtered.slice(0, limit);

        if (top.length === 0) {
          return { output: emptyMessage, isError: false };
        }

        const lines = top.map(formatFn);
        return { output: lines.join("\n\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `${errorPrefix}: ${msg}`, isError: true };
      }
    },
  };
}
