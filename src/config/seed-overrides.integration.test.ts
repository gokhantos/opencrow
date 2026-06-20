/**
 * Integration test for the config-as-data introspection + seeder.
 *
 * Proves the cutover invariant:
 *   1. With env set (no DB rows), GET /api/config/effective reports those fields
 *      with source "env" and the env-derived effective value.
 *   2. seedOverridesFromEnv() writes those env values into config_overrides.
 *   3. After seeding, GET /api/config/effective reports the SAME values, now with
 *      source "db" — i.e. the seed is BEHAVIOR-NEUTRAL (DB reproduces env).
 *   4. config/smart.sigeAuto is seeded with enabled:false (SIGE manual-only).
 *   5. Re-running the seeder is idempotent — it skips the existing rows.
 *
 * Lane: *.integration.test.ts — `bun run test:integration` (needs postgres).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../store/db";
import { deleteOverride } from "../store/config-overrides";
import { createConfigIntrospectRoutes } from "../web/routes/config-introspect";
import { seedOverridesFromEnv } from "./seed-overrides";

const BASE = "http://localhost";

// Override keys this test seeds/inspects — cleaned up before and after so the
// shared dev DB does not leak rows between runs.
const SEEDED_KEYS: readonly (readonly [string, string])[] = [
  ["config", "server"],
  ["config", "sandbox"],
  ["config", "memory"],
  ["config", "sige"],
  ["config", "smart.signal"],
  ["config", "smart.sigeAuto"],
  ["config", "smart.outcomeMemory"],
  ["config", "smart.graphReasoning"],
  ["config", "smart.incumbentExclusion"],
  ["config", "smart.diversityGuard"],
  ["config", "competability"],
  ["features", "embeddings"],
];

// Env vars this test sets so the env path has something to seed. Captured so we
// can restore the original environment afterward (other suites share it).
const TEST_ENV: Readonly<Record<string, string>> = {
  OPENCROW_WEB_HOST: "10.20.30.40",
  OPENCROW_WEB_PORT: "49090",
  LOG_LEVEL: "warn",
  OPENCROW_MEMORY_BACKEND: "mem0",
  OPENCROW_SMART_SIGNAL_FACETS: "true",
  OPENCROW_SMART_SIGNAL_IMPORTANCE_FLOOR: "medium",
  OPENCROW_SMART_INCUMBENT_EXCLUSION_TOP_N: "42",
  OPENCROW_SMART_DIVERSITY_GUARD_MAX_BUCKET_SHARE: "0.33",
  OPENCROW_EMBEDDINGS_PROVIDER: "ollama",
  OPENCROW_EMBEDDINGS_DIMENSIONS: "768",
};

interface FieldReport {
  readonly path: string;
  readonly value: unknown;
  readonly source: "db" | "env" | "default";
  readonly overrideKey: string | null;
}
interface EffectiveData {
  readonly domains: readonly { readonly fields: readonly FieldReport[] }[];
  readonly summary: { readonly db: number; readonly env: number; readonly default: number };
}

function makeApp() {
  return createConfigIntrospectRoutes();
}

async function getEffective(
  app: ReturnType<typeof makeApp>,
): Promise<EffectiveData> {
  const res = await app.fetch(new Request(`${BASE}/config/effective`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean; data: EffectiveData };
  expect(body.success).toBe(true);
  return body.data;
}

function fieldsByPath(data: EffectiveData): Map<string, FieldReport> {
  const map = new Map<string, FieldReport>();
  for (const domain of data.domains) {
    for (const field of domain.fields) {
      map.set(field.path, field);
    }
  }
  return map;
}

const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  for (const [ns, key] of SEEDED_KEYS) {
    await deleteOverride(ns, key);
  }
  for (const [name, value] of Object.entries(TEST_ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterEach(async () => {
  for (const [ns, key] of SEEDED_KEYS) {
    await deleteOverride(ns, key);
  }
  for (const [name, prev] of savedEnv.entries()) {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
  savedEnv.clear();
  await closeDb();
});

describe("GET /api/config/effective (pre-seed)", () => {
  it("reports env-driven fields with source 'env' and the env value", async () => {
    const app = makeApp();
    const before = fieldsByPath(await getEffective(app));

    const host = before.get("web.host");
    expect(host?.value).toBe("10.20.30.40");
    expect(host?.source).toBe("env");

    const port = before.get("web.port");
    expect(port?.value).toBe(49090);
    expect(port?.source).toBe("env");

    const backend = before.get("memorySearch.backend");
    expect(backend?.value).toBe("mem0");
    expect(backend?.source).toBe("env");

    const facets = before.get("pipelines.ideas.smart.signalFacets");
    expect(facets?.value).toBe(true);
    expect(facets?.source).toBe("env");
  });
});

describe("seedOverridesFromEnv", () => {
  it("dry-run writes nothing but reports what it would write", async () => {
    const app = makeApp();
    const result = await seedOverridesFromEnv({ dryRun: true });
    expect(result.written.length).toBeGreaterThan(0);

    // Effective config still sources from env — no rows were persisted.
    const data = fieldsByPath(await getEffective(app));
    expect(data.get("web.host")?.source).toBe("env");
  });

  it("seeds env values and the effective config is byte-identical (source flips env→db)", async () => {
    const app = makeApp();
    const before = fieldsByPath(await getEffective(app));

    const result = await seedOverridesFromEnv();
    expect(result.written.length).toBeGreaterThan(0);

    const after = fieldsByPath(await getEffective(app));

    // Every env-sourced field keeps its value but now reads from the DB.
    for (const path of [
      "web.host",
      "web.port",
      "logLevel",
      "memorySearch.backend",
      "pipelines.ideas.smart.signalFacets",
      "pipelines.ideas.smart.signalImportanceFloor",
      "pipelines.ideas.smart.incumbentExclusion.topN",
      "pipelines.ideas.smart.diversityGuard.maxBucketShare",
      "embeddings.provider",
      "embeddings.dimensions",
    ]) {
      const b = before.get(path);
      const a = after.get(path);
      expect(a?.value).toEqual(b?.value);
      expect(b?.source).toBe("env");
      expect(a?.source).toBe("db");
    }
  });

  it("seeds config/smart.sigeAuto with enabled:false (SIGE manual-only)", async () => {
    const app = makeApp();
    const result = await seedOverridesFromEnv();

    const sigeAutoRow = result.written.find(
      (r) => r.namespace === "config" && r.key === "smart.sigeAuto",
    );
    expect(sigeAutoRow?.value).toEqual({ enabled: false });

    const after = fieldsByPath(await getEffective(app));
    const enabled = after.get("pipelines.ideas.smart.sigeAuto.enabled");
    expect(enabled?.value).toBe(false);
    expect(enabled?.source).toBe("db");
  });

  it("is idempotent — a second run skips the rows it already seeded", async () => {
    await seedOverridesFromEnv();
    const second = await seedOverridesFromEnv();

    expect(second.written.length).toBe(0);
    expect(second.skipped).toContain("config/smart.sigeAuto");
    expect(second.skipped).toContain("config/server");
  });

  it("never clobbers a pre-existing DB row", async () => {
    // Simulate a Settings form having already written a custom value.
    const { setOverride } = await import("../store/config-overrides");
    await setOverride("config", "server", { webHost: "99.99.99.99" });

    const app = makeApp();
    const result = await seedOverridesFromEnv();

    expect(result.skipped).toContain("config/server");
    const after = fieldsByPath(await getEffective(app));
    // The pre-existing custom value survives; the seeder did not overwrite it.
    expect(after.get("web.host")?.value).toBe("99.99.99.99");
    expect(after.get("web.host")?.source).toBe("db");
  });
});
