import { Hono } from "hono";
import { createLogger } from "../../logger";
import { getAllOverrides } from "../../store/config-overrides";
import { loadConfigWithOverrides } from "../../config/loader";
import type { OpenCrowConfig } from "../../config/schema";
import {
  CONFIG_FIELD_SPECS,
  type ConfigFieldSpec,
} from "../../config/field-specs";

const log = createLogger("web-config-introspect");

/**
 * Effective-config introspection route — the PROOF tool for config-as-data.
 *
 * GET /api/config/effective returns, for every config field the scheme covers,
 * its EFFECTIVE value (what the app actually reads, via loadConfigWithOverrides)
 * plus its SOURCE:
 *   - "db":      a config_overrides row drives the subtree this field lives in
 *   - "env":     no override row, but the field's env var is present
 *   - "default": neither — the schema default is in effect
 *
 * Source precedence mirrors the loader (DB > env > schema default): an override
 * row for the field's (namespace,key) is reported as "db" even if an env var is
 * also set, because the DB row wins in loadConfigWithOverrides.
 *
 * This is read-only and never mutates config — it reports state so we can
 * confirm the DB drives everything before stripping .env.
 */

interface FieldReport {
  readonly path: string;
  readonly value: unknown;
  readonly source: "db" | "env" | "default";
  readonly overrideKey: string | null;
  readonly envVars: readonly string[];
}

interface DomainReport {
  readonly domain: string;
  readonly fields: readonly FieldReport[];
}

/** Read a dotted path out of the config object without mutating it. */
function readPath(config: OpenCrowConfig, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = config;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** True if any of the field's env vars is present (non-empty) in the process. */
function hasEnv(spec: ConfigFieldSpec): boolean {
  return spec.envVars.some((name) => {
    const raw = process.env[name];
    return raw !== undefined && raw !== "";
  });
}

/**
 * Compute the source for a single field. An override row keyed by the field's
 * (namespace, key) means the DB drives it; otherwise env presence wins over the
 * schema default.
 */
function computeSource(
  spec: ConfigFieldSpec,
  dbOverrideKeys: ReadonlySet<string>,
): "db" | "env" | "default" {
  if (spec.overrideKey !== null && dbOverrideKeys.has(spec.overrideKey)) {
    return "db";
  }
  if (hasEnv(spec)) {
    return "env";
  }
  return "default";
}

export function createConfigIntrospectRoutes(): Hono {
  const app = new Hono();

  app.get("/config/effective", async (c) => {
    try {
      const config = await loadConfigWithOverrides();

      // Build the set of present override keys as "namespace/key" so a field's
      // overrideKey can be looked up in O(1). Pull every namespace the scheme
      // touches; absent namespaces simply contribute nothing.
      const namespaces = new Set(
        CONFIG_FIELD_SPECS.flatMap((d) =>
          d.fields
            .map((f) => f.overrideKey)
            .filter((k): k is string => k !== null)
            .map((k) => k.split("/")[0] ?? ""),
        ),
      );
      const dbOverrideKeys = new Set<string>();
      for (const ns of namespaces) {
        if (ns === "") continue;
        const rows = await getAllOverrides(ns);
        for (const row of rows) {
          dbOverrideKeys.add(`${row.namespace}/${row.key}`);
        }
      }

      const domains: DomainReport[] = CONFIG_FIELD_SPECS.map((domain) => ({
        domain: domain.domain,
        fields: domain.fields.map((spec) => ({
          path: spec.path,
          value: readPath(config, spec.path),
          source: computeSource(spec, dbOverrideKeys),
          overrideKey: spec.overrideKey,
          envVars: spec.envVars,
        })),
      }));

      const counts = domains
        .flatMap((d) => d.fields)
        .reduce(
          (acc, f) => ({ ...acc, [f.source]: (acc[f.source] ?? 0) + 1 }),
          {} as Record<string, number>,
        );

      return c.json({
        success: true,
        data: {
          domains,
          summary: {
            db: counts.db ?? 0,
            env: counts.env ?? 0,
            default: counts.default ?? 0,
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to introspect effective config", err);
      return c.json({ success: false, error: message }, 500);
    }
  });

  return app;
}
