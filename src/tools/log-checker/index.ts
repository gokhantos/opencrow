import type { ToolDefinition } from "../types";
import { createSearchLogsTool } from "./search-logs";
import { createAggregateLogsTool } from "./aggregate-logs";
import { createErrorAnalysisTool } from "./error-analysis";
import { createLogTimelineTool } from "./log-timeline";
import { createComparePeriodsTool } from "./compare-periods";

export function createLogCheckerTools(): ToolDefinition[] {
  return [
    createSearchLogsTool(),
    createAggregateLogsTool(),
    createErrorAnalysisTool(),
    createLogTimelineTool(),
    createComparePeriodsTool(),
  ];
}
