import type { ModelRoute } from "../../store/model-routing";
import type { PipelineConfig } from "../types";

/**
 * Resolve the idea generator's {provider, model} as a COUPLED PAIR.
 *
 * A model id is only valid for its own provider (e.g. `claude-sonnet-4-6` only
 * on `anthropic`, `glm-5.2` only on `alibaba`). Resolving model and provider
 * independently (config.model ?? route.model alongside config.provider ??
 * route.provider) can mix a config model with the route's provider and send the
 * model to the wrong API → Alibaba "Model not exist".
 *
 * Rule: an explicit operator override is honored ONLY when BOTH `model` and
 * `provider` are set in the config (they travel together). Otherwise the
 * dashboard-controlled `pipeline.generator` route supplies BOTH. Pure.
 */
export function resolveGeneratorRoute(
  config: Pick<PipelineConfig, "model" | "provider">,
  route: ModelRoute,
): ModelRoute {
  if (config.model != null && config.provider != null) {
    return { model: config.model, provider: config.provider };
  }
  return { model: route.model, provider: route.provider };
}
