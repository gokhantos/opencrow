/**
 * Idempotent config_overrides seeder for the config-as-data cutover.
 *
 * `seedOverridesFromEnv()` reads the CURRENT process.env (the load-bearing vars
 * the real .env sets) and, for each scheme override key, writes the partial JSON
 * the loader already deep-merges onto that subtree — but ONLY if no row for that
 * (namespace,key) exists yet. It NEVER clobbers an existing DB row, so it is safe
 * to run repeatedly and safe to run after Settings forms have written values.
 *
 * Behavior-neutral by construction: the partial it writes is exactly what
 * applyEnvOverrides would have produced from the same env, so loadConfigWithOverrides
 * yields the same effective config after seeding (DB > env, same values).
 *
 * One exception by product requirement: config/smart.sigeAuto is ALWAYS seeded
 * with `enabled:false` (SIGE manual-only) even when the env var is unset — the
 * user wants the self-scheduler off by default.
 *
 * CLI: `bun run src/config/seed-overrides.ts [--dry-run]` (see import.meta.main).
 */

import { initDb, closeDb } from "../store/db";
import { getOverride, setOverride } from "../store/config-overrides";
import { createLogger } from "../logger";
import {
  CONFIG_FIELD_SPECS,
  type ConfigFieldSpec,
  type EnvParse,
} from "./field-specs";

const log = createLogger("config-seed-overrides");

export interface SeedOptions {
  /** Log what WOULD be written without persisting anything. Default false. */
  readonly dryRun?: boolean;
}

export interface SeededRow {
  readonly namespace: string;
  readonly key: string;
  readonly value: Record<string, unknown>;
}

export interface SeedResult {
  /** Rows written (or that WOULD be written in dry-run). */
  readonly written: readonly SeededRow[];
  /** Rows skipped because a DB override already existed. */
  readonly skipped: readonly string[];
  /** Override keys that had no env input and nothing forced (not written). */
  readonly empty: readonly string[];
}

/** Coerce a raw env string into the typed value the override JSON should hold. */
function coerce(raw: string, parse: EnvParse): unknown {
  switch (parse) {
    case "number": {
      const n = Number(raw);
      return Number.isNaN(n) ? undefined : n;
    }
    case "boolean":
      return raw === "true" || raw === "1";
    case "csv-string":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    case "csv-number":
      return raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n));
    default:
      return raw;
  }
}

/** First present (non-empty) env var value for a field, coerced; else undefined. */
function readField(spec: ConfigFieldSpec): unknown {
  for (const name of spec.envVars) {
    const raw = process.env[name];
    if (raw !== undefined && raw !== "") {
      return coerce(raw, spec.parse);
    }
  }
  return undefined;
}

/** Set a (possibly dotted) subKey on a partial object, immutably. */
function setSubKey(
  obj: Record<string, unknown>,
  subKey: string,
  value: unknown,
): Record<string, unknown> {
  const segments = subKey.split(".");
  if (segments.length === 1) {
    return { ...obj, [subKey]: value };
  }
  const [head, ...rest] = segments as [string, ...string[]];
  const child = (obj[head] ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: setSubKey(child, rest.join("."), value) };
}

/**
 * Build, per overrideKey, the partial JSON object derived from the current env.
 * Returns a map keyed by "namespace/key". A key only appears if at least one of
 * its fields produced a value.
 */
function buildPartialsFromEnv(): Map<string, Record<string, unknown>> {
  const partials = new Map<string, Record<string, unknown>>();
  for (const domain of CONFIG_FIELD_SPECS) {
    for (const spec of domain.fields) {
      if (spec.overrideKey === null || spec.subKey === null) continue;
      const value = readField(spec);
      if (value === undefined) continue;
      const existing = partials.get(spec.overrideKey) ?? {};
      partials.set(spec.overrideKey, setSubKey(existing, spec.subKey, value));
    }
  }
  return partials;
}

/**
 * Product-forced seed values that must be written regardless of env presence.
 * config/smart.sigeAuto.enabled = false → SIGE stays manual-only by default.
 * These are merged UNDER the env-derived partial so an explicit env value still
 * wins for the same field.
 */
const FORCED_PARTIALS: ReadonlyMap<string, Record<string, unknown>> = new Map([
  ["config/smart.sigeAuto", { enabled: false }],
]);

const ALL_OVERRIDE_KEYS: readonly string[] = Array.from(
  new Set(
    CONFIG_FIELD_SPECS.flatMap((d) =>
      d.fields
        .map((field) => field.overrideKey)
        .filter((k): k is string => k !== null),
    ),
  ),
);

function splitKey(overrideKey: string): readonly [string, string] {
  const idx = overrideKey.indexOf("/");
  return [overrideKey.slice(0, idx), overrideKey.slice(idx + 1)] as const;
}

/**
 * Seed config_overrides from the current process.env. Idempotent: only writes a
 * row when none exists for that (namespace,key). Returns a structured report.
 */
export async function seedOverridesFromEnv(
  opts: SeedOptions = {},
): Promise<SeedResult> {
  const dryRun = opts.dryRun ?? false;
  const envPartials = buildPartialsFromEnv();

  const written: SeededRow[] = [];
  const skipped: string[] = [];
  const empty: string[] = [];

  for (const overrideKey of ALL_OVERRIDE_KEYS) {
    const [namespace, key] = splitKey(overrideKey);

    // Compose env-derived + forced partials (env wins on field conflicts).
    const forced = FORCED_PARTIALS.get(overrideKey) ?? {};
    const fromEnv = envPartials.get(overrideKey) ?? {};
    const value = { ...forced, ...fromEnv };

    if (Object.keys(value).length === 0) {
      empty.push(overrideKey);
      continue;
    }

    // Idempotency: never clobber an existing DB row.
    const existing = await getOverride(namespace, key);
    if (existing !== null) {
      skipped.push(overrideKey);
      log.info("Override already present — skipping", { overrideKey });
      continue;
    }

    written.push({ namespace, key, value });
    if (dryRun) {
      log.info("[dry-run] would seed override", { overrideKey, value });
    } else {
      await setOverride(namespace, key, value);
      log.info("Seeded override from env", { overrideKey, value });
    }
  }

  log.info("Seed complete", {
    dryRun,
    written: written.length,
    skipped: skipped.length,
    empty: empty.length,
  });

  return { written, skipped, empty };
}

/**
 * CLI entry: `bun run src/config/seed-overrides.ts [--dry-run]`.
 * Opens its own DB connection (the app is not assumed to be running) and closes
 * it afterward so the script exits cleanly.
 */
if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    await initDb(process.env.DATABASE_URL);
    const result = await seedOverridesFromEnv({ dryRun });
    log.info("Seed run finished", {
      dryRun,
      written: result.written.map((r) => `${r.namespace}/${r.key}`),
      skipped: result.skipped,
    });
  } catch (err) {
    log.error("Seed run failed", err);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
