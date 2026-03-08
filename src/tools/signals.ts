import type { ToolDefinition, ToolCategory } from "./types";
import { requireString, getString, getNumber, isToolError } from "./input-helpers";
import {
  insertSignal,
  getUnconsumedSignals,
  getRecentSignals,
  markSignalsConsumed,
  getSignalThemes,
  getCrossDomainSignals,
  getCrossDomainThemes,
} from "../sources/ideas/signals-store";

const SIGNAL_TYPES = ["trend", "pain_point", "capability", "gap", "catalyst", "competition"] as const;

function createSaveSignalTool(agentId: string): ToolDefinition {
  return {
    name: "save_signal",
    description:
      "Save a research signal you discovered. Signals are raw observations — a trend, pain point, new capability, market gap, or catalyst. Save signals liberally during research. They will be synthesized into ideas in a later phase. Each signal should be a SPECIFIC observation with a concrete source, not a vague trend.",
    inputSchema: {
      type: "object",
      properties: {
        signal_type: {
          type: "string",
          enum: [...SIGNAL_TYPES],
          description: "Type: trend (growing pattern), pain_point (user frustration), capability (new tech), gap (missing product), catalyst (recent change), competition (existing product weakness).",
        },
        title: {
          type: "string",
          description: "Short, specific title. 'HN users frustrated with Notion mobile performance' >> 'mobile app issues'.",
        },
        detail: {
          type: "string",
          description: "Detailed observation. Include specific quotes, numbers, dates, names. What exactly did you observe and where?",
        },
        source: {
          type: "string",
          description: "Where you found this (e.g., 'Hacker News', 'r/androidapps', 'Product Hunt', 'github.com/user/repo').",
        },
        source_url: {
          type: "string",
          description: "URL to the source if available.",
        },
        strength: {
          type: "number",
          description: "Signal strength 1-5. 1=weak/anecdotal, 3=moderate/multiple sources, 5=strong/quantified trend.",
        },
        themes: {
          type: "string",
          description: "Comma-separated theme tags (e.g., 'on-device-ai,privacy,mobile-ml'). Used for cross-signal pattern matching.",
        },
      },
      required: ["signal_type", "title", "detail", "source"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const signalType = getString(input, "signal_type") ?? "trend";
      const title = requireString(input, "title", { maxLength: 300 });
      if (isToolError(title)) return title;
      const detail = requireString(input, "detail");
      if (isToolError(detail)) return detail;
      const source = requireString(input, "source");
      if (isToolError(source)) return source;
      const sourceUrl = getString(input, "source_url") ?? "";
      const strength = getNumber(input, "strength", { defaultVal: 3, min: 1, max: 5 });
      const themes = getString(input, "themes") ?? "";

      try {
        const signal = await insertSignal({
          agent_id: agentId,
          signal_type: signalType,
          title,
          detail,
          source,
          source_url: sourceUrl,
          strength,
          themes,
        });

        return {
          output: `Signal saved (id: ${signal.id}). "${signal.title}" [${signalType}, strength: ${strength}]`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error saving signal: ${msg}`, isError: true };
      }
    },
  };
}

function createGetSignalsTool(agentId: string): ToolDefinition {
  return {
    name: "get_signals",
    description:
      "Get accumulated research signals from previous research runs. These are raw observations waiting to be synthesized into ideas. Signals marked as unconsumed are fresh — use them as building blocks for idea generation. After using signals to generate ideas, mark them as consumed.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["unconsumed", "recent"],
          description: "unconsumed = fresh signals not yet used for ideas. recent = all recent signals.",
        },
        limit: {
          type: "number",
          description: "Max signals to return (default 30).",
        },
        max_age_days: {
          type: "number",
          description: "Only return signals from the last N days (default 14). Older signals are likely stale. Set to 0 for no age limit.",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const mode = getString(input, "mode") ?? "unconsumed";
      const limit = getNumber(input, "limit", { defaultVal: 30, min: 1, max: 50 });
      const maxAgeDays = getNumber(input, "max_age_days", { defaultVal: 14, min: 0, max: 90 });

      try {
        const signals = mode === "recent"
          ? await getRecentSignals(agentId, limit)
          : await getUnconsumedSignals(agentId, limit, maxAgeDays);

        if (signals.length === 0) {
          return {
            output: mode === "unconsumed"
              ? "No unconsumed signals. Run a research phase first to accumulate signals before generating ideas."
              : "No recent signals found.",
            isError: false,
          };
        }

        const lines = signals.map((s, i) => {
          const consumed = s.consumed ? " [consumed]" : "";
          const ageDays = Math.floor((Date.now() / 1000 - s.created_at) / 86400);
          const ageTag = ageDays > 7 ? ` [${ageDays}d old]` : "";
          return [
            `${i + 1}. [${s.signal_type}] ${s.title} (strength: ${s.strength}/5)${consumed}${ageTag}`,
            `   Source: ${s.source}${s.source_url ? ` — ${s.source_url}` : ""}`,
            `   ${s.detail.slice(0, 300)}${s.detail.length > 300 ? "..." : ""}`,
            s.themes ? `   Themes: ${s.themes}` : "",
            `   ID: ${s.id}`,
          ].filter(Boolean).join("\n");
        });

        return {
          output: `${signals.length} signals (${mode}, max ${maxAgeDays}d):\n\n${lines.join("\n\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching signals: ${msg}`, isError: true };
      }
    },
  };
}

function createConsumeSignalsTool(): ToolDefinition {
  return {
    name: "consume_signals",
    description:
      "Mark signals as consumed after using them to generate ideas. This prevents the same signals from being re-used in future ideation runs.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of signal IDs to mark as consumed.",
        },
      },
      required: ["ids"],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const ids = input.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return { output: "No signal IDs provided.", isError: true };
      }

      try {
        await markSignalsConsumed(ids as string[]);
        return {
          output: `Marked ${ids.length} signal(s) as consumed.`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error consuming signals: ${msg}`, isError: true };
      }
    },
  };
}

function createGetSignalThemesTool(agentId: string): ToolDefinition {
  return {
    name: "get_signal_themes",
    description:
      "Get recurring themes across your research signals. Shows which themes appear most frequently — these convergence points are where the best ideas live. Use this to identify patterns spanning multiple signals and sources.",
    inputSchema: {
      type: "object",
      properties: {
        days_back: {
          type: "number",
          description: "How many days to look back (default 14).",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const daysBack = getNumber(input, "days_back", { defaultVal: 14, min: 1, max: 90 });

      try {
        const themes = await getSignalThemes(agentId, daysBack);

        if (themes.length === 0) {
          return { output: "No signal themes found. Save more signals with theme tags first.", isError: false };
        }

        const lines = themes.map((t) => `  ${t.theme}: ${t.count} signal(s)`);
        return {
          output: `Signal themes (last ${daysBack} days):\n${lines.join("\n")}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching themes: ${msg}`, isError: true };
      }
    },
  };
}

function createGetCrossDomainSignalsTool(agentId: string): ToolDefinition {
  return {
    name: "get_cross_domain_signals",
    description:
      "Get research signals from OTHER agents (not your own). Use this to discover cross-domain opportunities — a crypto signal might inspire an AI idea, or a mobile pain point might suggest an OSS tool. Only returns high-strength (3+) unconsumed signals from the last 14 days. Look for convergences across domains.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max signals to return (default 15).",
        },
        max_age_days: {
          type: "number",
          description: "Only signals from the last N days (default 14).",
        },
        include_themes: {
          type: "boolean",
          description: "Also return cross-domain theme summary (default true).",
        },
      },
      required: [],
    },
    categories: ["ideas"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const limit = getNumber(input, "limit", { defaultVal: 15, min: 1, max: 30 });
      const maxAgeDays = getNumber(input, "max_age_days", { defaultVal: 14, min: 1, max: 30 });
      const includeThemes = input.include_themes !== false;

      try {
        const signals = await getCrossDomainSignals(agentId, limit, maxAgeDays);

        const parts: string[] = [];

        if (includeThemes) {
          const themes = await getCrossDomainThemes(agentId, maxAgeDays);
          if (themes.length > 0) {
            const themeLines = themes.map((t) => `  ${t.theme}: ${t.count} signal(s) from ${t.agents}`);
            parts.push(`Cross-domain themes:\n${themeLines.join("\n")}`);
          }
        }

        if (signals.length === 0) {
          parts.push("No cross-domain signals found. Other agents haven't saved strong signals recently.");
          return { output: parts.join("\n\n"), isError: false };
        }

        const lines = signals.map((s, i) => {
          return [
            `${i + 1}. [${s.agent_id}] [${s.signal_type}] ${s.title} (strength: ${s.strength}/5)`,
            `   Source: ${s.source}${s.source_url ? ` — ${s.source_url}` : ""}`,
            `   ${s.detail.slice(0, 300)}${s.detail.length > 300 ? "..." : ""}`,
            s.themes ? `   Themes: ${s.themes}` : "",
            `   ID: ${s.id}`,
          ].filter(Boolean).join("\n");
        });

        parts.push(`${signals.length} cross-domain signals:\n\n${lines.join("\n\n")}`);

        return { output: parts.join("\n\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching cross-domain signals: ${msg}`, isError: true };
      }
    },
  };
}

export function createSignalTools(agentId: string): readonly ToolDefinition[] {
  return [
    createSaveSignalTool(agentId),
    createGetSignalsTool(agentId),
    createConsumeSignalsTool(),
    createGetSignalThemesTool(agentId),
    createGetCrossDomainSignalsTool(agentId),
  ];
}
