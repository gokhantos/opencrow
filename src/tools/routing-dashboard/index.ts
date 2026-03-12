import type { ToolDefinition } from "../types";
import { createRoutingDashboardTool } from "./dashboard-tool";
import {
  createRoutingStatsTool,
  createMcpHealthTool,
  createToolPerformanceTool,
  createCostBreakdownTool,
  createPrewarmStatsTool,
} from "./stats-tools";

export function createRoutingDashboardTools(): ToolDefinition[] {
  return [
    createRoutingDashboardTool(),
    createRoutingStatsTool(),
    createMcpHealthTool(),
    createToolPerformanceTool(),
    createCostBreakdownTool(),
    createPrewarmStatsTool(),
  ];
}
