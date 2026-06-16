/**
 * Runtime response schemas for hot API paths.
 *
 * These use `z.looseObject` so a forward-compatible server can add fields
 * without breaking the UI (unknown keys pass through untouched). They exist to
 * catch shape regressions (missing arrays, wrong primitive types) at the
 * network boundary rather than mid-render.
 *
 * Migrating a call site is opt-in: pass the schema via `apiFetch(path, opts,
 * { schema })` or `apiFetchValidated(path, schema)`.
 */
import { z } from "zod";

// ── Agents list (GET /api/agents) ──────────────────────────────────────────

const toolFilterSchema = z.object({
  mode: z.enum(["all", "allowlist", "blocklist"]),
  tools: z.array(z.string()),
});

const subagentConfigSchema = z.object({
  allowAgents: z.array(z.string()),
  maxChildren: z.number(),
});

const agentInfoSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic"]),
  model: z.string(),
  isDefault: z.boolean(),
  toolFilter: toolFilterSchema,
  subagents: subagentConfigSchema,
});

export const agentsResponseSchema = z.object({
  success: z.boolean(),
  data: z.array(agentInfoSchema),
  configHash: z.string().optional(),
});

// ── Processes (GET /api/processes) ──────────────────────────────────────────

const processInfoSchema = z.looseObject({
  name: z.string(),
  pid: z.number(),
  status: z.enum(["alive", "stale", "dead"]),
  startedAt: z.number(),
  lastHeartbeat: z.number(),
  uptimeSeconds: z.number(),
  metadata: z.record(z.string(), z.unknown()),
});

export const processesResponseSchema = z.object({
  data: z.array(processInfoSchema),
});

// ── System metrics (GET /api/system/metrics) ────────────────────────────────

const diskInfoSchema = z.looseObject({
  filesystem: z.string(),
  mount: z.string(),
  total: z.number(),
  used: z.number(),
  available: z.number(),
  percentage: z.number(),
});

export const systemMetricsSchema = z.object({
  timestamp: z.number(),
  cpu: z.object({
    usage: z.number(),
    loadAvg: z.tuple([z.number(), z.number(), z.number()]),
  }),
  memory: z.object({
    total: z.number(),
    used: z.number(),
    free: z.number(),
    available: z.number(),
    percentage: z.number(),
  }),
  disk: z.array(diskInfoSchema),
  processes: z.array(
    z.object({
      pid: z.number(),
      name: z.string(),
      cpu: z.number(),
      memory: z.number(),
      memoryMB: z.number(),
    }),
  ),
});
