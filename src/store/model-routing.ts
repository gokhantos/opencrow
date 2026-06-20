import { z } from "zod";
import { getAllOverrides, getOverride, setOverride } from "./config-overrides";

const NAMESPACE = "model-routing";

export const MODEL_ROUTING_KEYS = [
  "signal.facets",
  "signal.observations",
  "sige.fast-agent",
  "sige.judge.0",
  "sige.judge.1",
  "sige.judge.2",
  "pipeline.generator",
  "agent-templates",
] as const;

export type ModelRoutingKey = (typeof MODEL_ROUTING_KEYS)[number];

export const MODEL_PROVIDERS = [
  "anthropic",
  "alibaba",
  "openrouter",
  "agent-sdk",
  "opencode",
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const modelRouteSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string().min(1),
});

export type ModelRoute = z.infer<typeof modelRouteSchema>;

export const MODEL_ROUTING_DEFAULTS: Readonly<Record<ModelRoutingKey, ModelRoute>> = {
  "signal.facets": { provider: "alibaba", model: "deepseek-v4-flash" },
  "signal.observations": { provider: "alibaba", model: "deepseek-v4-flash" },
  "sige.fast-agent": { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  "sige.judge.0": { provider: "anthropic", model: "claude-haiku-4-5" },
  "sige.judge.1": { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
  "sige.judge.2": { provider: "alibaba", model: "qwen3.7-plus" },
  "pipeline.generator": { provider: "anthropic", model: "claude-sonnet-4-6" },
  "agent-templates": { provider: "agent-sdk", model: "claude-haiku-4-5" },
};

function isKey(key: string): key is ModelRoutingKey {
  return (MODEL_ROUTING_KEYS as readonly string[]).includes(key);
}

export function isModelRoutingKey(key: string): key is ModelRoutingKey {
  return isKey(key);
}

/**
 * Resolve a process's model route. Reads the DB override on every call (hot
 * reload). Falls back to the seeded default if the row is missing or invalid,
 * so a never-seeded DB still works.
 */
export async function getModelRoute(key: ModelRoutingKey): Promise<ModelRoute> {
  const raw = await getOverride(NAMESPACE, key);
  const parsed = modelRouteSchema.safeParse(raw);
  return parsed.success ? parsed.data : MODEL_ROUTING_DEFAULTS[key];
}

export async function setModelRoute(key: ModelRoutingKey, route: ModelRoute): Promise<void> {
  await setOverride(NAMESPACE, key, modelRouteSchema.parse(route));
}

export async function getAllModelRoutes(): Promise<Record<ModelRoutingKey, ModelRoute>> {
  const overrides = await getAllOverrides(NAMESPACE);
  const byKey = new Map(overrides.map((o) => [o.key, o.value] as const));
  const result = {} as Record<ModelRoutingKey, ModelRoute>;
  for (const key of MODEL_ROUTING_KEYS) {
    const parsed = modelRouteSchema.safeParse(byKey.get(key));
    result[key] = parsed.success ? parsed.data : MODEL_ROUTING_DEFAULTS[key];
  }
  return result;
}
