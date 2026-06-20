// ─── SIGE Session Config — canonical defaults + merge helper ────────────────
//
// Leaf module (no SIGE-pipeline imports) so it can be shared by both the
// headless session library (`run.ts`) and the low-level persistence layer
// (`store.ts`) WITHOUT creating a circular dependency. `run.ts` re-exports
// these for backward compatibility with existing importers.
//
// Mirrors the DEFAULT_CONFIG used by the web route (src/web/routes/sige.ts) so
// that callers without a persisted SigeSession (e.g. the ideas pipeline) — and
// rows hydrated from a stale/partial `config_json` — can always obtain a
// complete, valid SigeSessionConfig without duplicating magic numbers.

import type { SigeSessionConfig } from "./types";

export const DEFAULT_SIGE_SESSION_CONFIG: SigeSessionConfig = {
  expertRounds: 4,
  socialAgentCount: 20,
  socialRounds: 3,
  maxConcurrentAgents: 4,
  alpha: 0.5,
  incentiveWeights: {
    diversity: 0.25,
    building: 0.2,
    surprise: 0.15,
    accuracyPenalty: 0.1,
    socialViability: 0.3,
  },
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  agentModel: "claude-sonnet-4-6",
};

/**
 * Merge a partial override onto the default session config.
 *
 * Deep-merges `incentiveWeights` so a partial weight override does not drop the
 * untouched defaults. Handy for headless callers that only want to tweak a
 * couple of fields (e.g. provider/model) without restating the whole config,
 * and for hydrating a persisted row whose `config_json` predates a field.
 */
export function buildSessionConfig(partial?: Partial<SigeSessionConfig>): SigeSessionConfig {
  if (!partial) return DEFAULT_SIGE_SESSION_CONFIG;
  return {
    ...DEFAULT_SIGE_SESSION_CONFIG,
    ...partial,
    incentiveWeights: partial.incentiveWeights
      ? { ...DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights, ...partial.incentiveWeights }
      : DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights,
  };
}
