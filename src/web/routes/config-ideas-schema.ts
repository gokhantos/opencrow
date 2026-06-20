import { z } from "zod";
import type { OpenCrowConfig } from "../../config/schema";

/**
 * Zod PUT-body schemas + pure response builder for the Ideas/funnel
 * config-as-data route. Kept separate from the Hono wiring so the pure
 * validation/transform logic is unit-testable without a DB or HTTP layer.
 *
 * IMPORTANT (Foundation contract): the loader deep-merges each override JSON's
 * keys VERBATIM onto its config subtree before the final zod parse, so every
 * field below MUST use the ACTUAL schema field names (e.g. competability's
 * `builderProfile`, outcomeMemory's `writeBack` with a capital B). Unknown keys
 * would be silently stripped by the config parse, so we additionally `.strict()`
 * to reject them at the route boundary instead.
 *
 * Each schema is a PARTIAL of its config subtree: the UI sends only changed
 * fields, deep-merged onto the effective config. `.strict()` + bounded ranges
 * mirror the config schema so an invalid PUT is a 400, not a silent no-op.
 */

// config/smart.outcomeMemory — gotcha: field is `writeBack` (capital B), not `writeback`.
export const outcomeMemoryOverrideSchema = z
  .object({
    writeBack: z.boolean(),
    readAtSynthesis: z.boolean(),
    reinforceCap: z.number().int().min(1).max(20),
    avoidCap: z.number().int().min(1).max(20),
    searchLimit: z.number().int().min(1).max(50),
  })
  .partial()
  .strict();

// config/smart.incumbentExclusion
export const incumbentExclusionOverrideSchema = z
  .object({
    enabled: z.boolean(),
    topN: z.number().int().min(1).max(1000),
  })
  .partial()
  .strict();

// config/smart.diversityGuard
export const diversityGuardOverrideSchema = z
  .object({
    enabled: z.boolean(),
    maxBucketShare: z.number().min(0).max(1),
    bucketBy: z.enum(["archetype", "category"]),
  })
  .partial()
  .strict();

// builderProfile sub-object of competability. expertiseDomains is a string list.
const builderProfileOverrideSchema = z
  .object({
    capital: z.enum(["none", "bootstrap", "seed", "funded"]),
    teamSize: z.number().int().min(1).max(1000),
    expertiseDomains: z.array(z.string().max(80)).max(50),
    regulatoryAppetite: z.enum(["none", "low", "high"]),
    opsAppetite: z.enum(["none", "low", "high"]),
  })
  .partial()
  .strict();

// config/competability — note the schema field is `builderProfile`, not `builder`.
export const competabilityOverrideSchema = z
  .object({
    enabled: z.boolean(),
    enforceGate: z.boolean(),
    rejectThreshold: z.number().min(0).max(5),
    softPenaltyThreshold: z.number().min(0).max(5),
    topNIncumbents: z.number().int().min(1).max(1000),
    builderProfile: builderProfileOverrideSchema,
  })
  .partial()
  .strict();

export interface IdeasOverrideSection {
  /** Stable id used in the PUT path (`/ideas/:section`) and GET response. */
  readonly id: string;
  /** config_overrides namespace column. */
  readonly namespace: string;
  /** config_overrides key column. */
  readonly key: string;
  /** Zod schema validating the PARTIAL PUT body. */
  readonly schema: z.ZodTypeAny;
}

export const IDEAS_OVERRIDE_SECTIONS: readonly IdeasOverrideSection[] = [
  {
    id: "outcomeMemory",
    namespace: "config",
    key: "smart.outcomeMemory",
    schema: outcomeMemoryOverrideSchema,
  },
  {
    id: "incumbentExclusion",
    namespace: "config",
    key: "smart.incumbentExclusion",
    schema: incumbentExclusionOverrideSchema,
  },
  {
    id: "diversityGuard",
    namespace: "config",
    key: "smart.diversityGuard",
    schema: diversityGuardOverrideSchema,
  },
  {
    id: "competability",
    namespace: "config",
    key: "competability",
    schema: competabilityOverrideSchema,
  },
] as const;

/**
 * Pure builder: maps the merged effective config + the raw per-section DB
 * overrides into the GET response shape. No I/O. The `effective` values come
 * from `config.pipelines.ideas.smart.*` (already DB > env > default merged by
 * the loader). `override` is the raw JSON stored in config_overrides for that
 * section, or null when no override row exists, so the UI can flag "overridden".
 */
export function buildIdeasConfigResponse(
  config: OpenCrowConfig,
  overrides: Readonly<Record<string, unknown>>,
): {
  readonly effective: {
    readonly outcomeMemory: OpenCrowConfig["pipelines"]["ideas"]["smart"]["outcomeMemory"];
    readonly incumbentExclusion: OpenCrowConfig["pipelines"]["ideas"]["smart"]["incumbentExclusion"];
    readonly diversityGuard: OpenCrowConfig["pipelines"]["ideas"]["smart"]["diversityGuard"];
    readonly competability: OpenCrowConfig["pipelines"]["ideas"]["smart"]["competability"];
  };
  readonly overrides: Readonly<Record<string, unknown>>;
} {
  const smart = config.pipelines.ideas.smart;
  return {
    effective: {
      outcomeMemory: smart.outcomeMemory,
      incumbentExclusion: smart.incumbentExclusion,
      diversityGuard: smart.diversityGuard,
      competability: smart.competability,
    },
    overrides: {
      outcomeMemory: overrides.outcomeMemory ?? null,
      incumbentExclusion: overrides.incumbentExclusion ?? null,
      diversityGuard: overrides.diversityGuard ?? null,
      competability: overrides.competability ?? null,
    },
  };
}
