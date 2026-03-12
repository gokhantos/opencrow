import type { ToolDefinition, ToolCategory } from "./types";
import { getDb } from "../store/db";
import { getNumber, getString, getEnum } from "./input-helpers";

// ============================================================================
// Economic Calendar Tool
// ============================================================================

interface EconomicEventRow {
  id: string;
  event_name: string;
  country: string;
  currency: string;
  importance: string;
  event_datetime: string;
  actual: string;
  forecast: string;
  previous: string;
  source_url: string;
  scraped_at: number;
}

export function createEconomicCalendarTool(): ToolDefinition[] {
  return [createGetEconomicCalendarTool()];
}

function createGetEconomicCalendarTool(): ToolDefinition {
  return {
    name: "get_calendar",
    description:
      "Get economic calendar events (GDP, CPI, interest rates, employment data). Shows actual vs forecast vs previous values. Filter by currency and importance.",
    inputSchema: {
      type: "object",
      properties: {
        currency: {
          type: "string",
          description: "Filter by currency code (e.g., 'USD', 'EUR', 'GBP').",
        },
        importance: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Filter by importance level.",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 20, max 50).",
        },
        days_back: {
          type: "number",
          description: "How many days to look back (default 7, max 30).",
        },
      },
      required: [],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const currency = getString(input, "currency", { allowEmpty: true });
      const importance = getEnum(input, "importance", ["low", "medium", "high"] as const);
      const limit = getNumber(input, "limit", { defaultVal: 20, min: 1, max: 50 });
      const daysBack = getNumber(input, "days_back", { defaultVal: 7, min: 1, max: 30 });

      try {
        const db = getDb();
        const since = Math.floor(Date.now() / 1000) - daysBack * 86400;

        let rows: readonly EconomicEventRow[];

        if (currency && importance) {
          rows = await db`
            SELECT * FROM economic_calendar_events
            WHERE scraped_at >= ${since}
              AND currency = ${currency.toUpperCase()}
              AND importance = ${importance}
            ORDER BY event_datetime ASC
            LIMIT ${limit}
          `;
        } else if (currency) {
          rows = await db`
            SELECT * FROM economic_calendar_events
            WHERE scraped_at >= ${since}
              AND currency = ${currency.toUpperCase()}
            ORDER BY event_datetime ASC
            LIMIT ${limit}
          `;
        } else if (importance) {
          rows = await db`
            SELECT * FROM economic_calendar_events
            WHERE scraped_at >= ${since}
              AND importance = ${importance}
            ORDER BY event_datetime ASC
            LIMIT ${limit}
          `;
        } else {
          rows = await db`
            SELECT * FROM economic_calendar_events
            WHERE scraped_at >= ${since}
            ORDER BY event_datetime ASC
            LIMIT ${limit}
          `;
        }

        if (rows.length === 0) {
          return {
            output: `No economic events found for the specified filters (last ${daysBack} days).`,
            isError: false,
          };
        }

        const lines: string[] = [];
        let highImpactCount = 0;

        for (const event of rows) {
          if (event.importance === "high") highImpactCount++;

          // Build comparison string
          const comparisons: string[] = [];
          if (event.actual && event.forecast) {
            const diff = parseFloat(event.actual) - parseFloat(event.forecast);
            const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "=";
            comparisons.push(`Actual: ${event.actual} (Forecast: ${event.forecast}) ${arrow}`);
          } else if (event.actual) {
            comparisons.push(`Actual: ${event.actual}`);
          }
          if (event.previous) {
            comparisons.push(`Previous: ${event.previous}`);
          }

          const importanceMark = event.importance === "high" ? "🔥" : event.importance === "medium" ? "⚠️" : "";
          const dateStr = event.event_datetime || "TBD";

          lines.push(
            `${dateStr} | ${event.currency} | ${event.event_name} ${importanceMark}`,
          );
          if (comparisons.length > 0) {
            lines.push(`  ${comparisons.join(" | ")}`);
          }
        }

        const summary = `\n--- Summary ---\nTotal: ${rows.length} events | High impact: ${highImpactCount}`;
        return {
          output: `Economic Calendar (last ${daysBack} days):\n\n${lines.join("\n\n")}${summary}`,
          isError: false,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error fetching economic calendar: ${msg}`, isError: true };
      }
    },
  };
}