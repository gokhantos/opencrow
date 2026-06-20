/**
 * Unit tests for `rowToSessionSummary` — the light-weight list projection
 * mapper added to src/sige/store.ts.
 *
 * These tests verify the field-level contracts without needing Postgres.
 * Heavy artifact columns (game_formulation_json, expert_result_json,
 * social_result_json, fused_scores_json, report) must be absent from the result.
 *
 * Lane: unit (*.test.ts) — no DB, fast.
 */
import { describe, test, expect } from "bun:test";
import { DEFAULT_SIGE_SESSION_CONFIG } from "./config";
import { rowToSession, rowToSessionSummary } from "./store";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const CONFIG_JSON = JSON.stringify({
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
});

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-abc-123",
    origin: "human",
    status: "pending",
    seed_input: "AI in healthcare",
    config_json: CONFIG_JSON,
    created_at: 1700000000,
    finished_at: null,
    last_activity_at: null,
    error: null,
    ...overrides,
  };
}

// ─── Basic shape ──────────────────────────────────────────────────────────────

describe("rowToSessionSummary — basic shape", () => {
  test("maps all light fields to correct camelCase names", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);

    expect(summary.id).toBe("sess-abc-123");
    expect(summary.origin).toBe("human");
    expect(summary.status).toBe("pending");
    expect(summary.seedInput).toBe("AI in healthcare");
    expect(summary.config).toBeDefined();
    expect(summary.createdAt).toBeInstanceOf(Date);
  });

  test("createdAt converts epoch seconds to Date correctly", () => {
    const row = makeRow({ created_at: 1700000000 });
    const summary = rowToSessionSummary(row as never);
    expect(summary.createdAt.getTime()).toBe(1700000000 * 1000);
  });

  test("finishedAt is undefined when finished_at is null", () => {
    const row = makeRow({ finished_at: null });
    const summary = rowToSessionSummary(row as never);
    expect(summary.finishedAt).toBeUndefined();
  });

  test("finishedAt converts epoch seconds to Date when present", () => {
    const row = makeRow({ finished_at: 1700001000 });
    const summary = rowToSessionSummary(row as never);
    expect(summary.finishedAt).toBeInstanceOf(Date);
    expect(summary.finishedAt!.getTime()).toBe(1700001000 * 1000);
  });

  test("config is parsed from config_json", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    expect(summary.config.expertRounds).toBe(4);
    expect(summary.config.provider).toBe("anthropic");
  });
});

// ─── Nullable / optional field handling ───────────────────────────────────────

describe("rowToSessionSummary — nullable fields", () => {
  test("seedInput is undefined when seed_input is null", () => {
    const row = makeRow({ seed_input: null });
    const summary = rowToSessionSummary(row as never);
    expect(summary.seedInput).toBeUndefined();
  });

  test("origin defaults to 'human' when origin column is null (pre-migration row)", () => {
    const row = makeRow({ origin: null });
    const summary = rowToSessionSummary(row as never);
    expect(summary.origin).toBe("human");
  });

  test("lastActivityAt is undefined when last_activity_at is null", () => {
    const row = makeRow({ last_activity_at: null });
    const summary = rowToSessionSummary(row as never);
    expect(summary.lastActivityAt).toBeUndefined();
  });

  test("lastActivityAt converts BIGINT string to number", () => {
    const row = makeRow({ last_activity_at: "1700000500" });
    const summary = rowToSessionSummary(row as never);
    expect(typeof summary.lastActivityAt).toBe("number");
    expect(summary.lastActivityAt).toBe(1700000500);
  });

  test("error is undefined when error column is null", () => {
    const row = makeRow({ error: null });
    const summary = rowToSessionSummary(row as never);
    expect(summary.error).toBeUndefined();
  });

  test("error is populated when error column has a string value", () => {
    const row = makeRow({ error: "pipeline failed at expert_game" });
    const summary = rowToSessionSummary(row as never);
    expect(summary.error).toBe("pipeline failed at expert_game");
  });
});

// ─── Heavy artifact columns are absent ───────────────────────────────────────

describe("rowToSessionSummary — heavy fields are absent", () => {
  test("gameFormulation is not present on the summary type", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    // TypeScript would catch this at compile time; at runtime we verify via cast
    expect((summary as unknown as Record<string, unknown>)["gameFormulation"]).toBeUndefined();
  });

  test("expertResult is not present on the summary type", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    expect((summary as unknown as Record<string, unknown>)["expertResult"]).toBeUndefined();
  });

  test("socialResult is not present on the summary type", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    expect((summary as unknown as Record<string, unknown>)["socialResult"]).toBeUndefined();
  });

  test("fusedScores is not present on the summary type", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    expect((summary as unknown as Record<string, unknown>)["fusedScores"]).toBeUndefined();
  });

  test("report is not present on the summary type", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    expect((summary as unknown as Record<string, unknown>)["report"]).toBeUndefined();
  });
});

// ─── Immutability — returned object is a new value, not the input ─────────────

describe("rowToSessionSummary — immutability", () => {
  test("returns a new object, not the input row", () => {
    const row = makeRow();
    const summary = rowToSessionSummary(row as never);
    expect(summary).not.toBe(row);
  });

  test("modifying the input row after mapping does not affect the summary", () => {
    const row = makeRow({ status: "pending" });
    const summary = rowToSessionSummary(row as never);
    // mutate the source row
    (row as Record<string, unknown>)["status"] = "completed";
    // summary must be unaffected (primitive — copied by value)
    expect(summary.status).toBe("pending");
  });
});

// ─── rowToSession — config hydration (defense-at-source) ──────────────────────
//
// Regression guard for the SIGE crash where a session persisted by an older
// `buildFastProfile` (before it spread DEFAULT_SIGE_SESSION_CONFIG) stored a
// `config_json` missing `model`. The hydrated `config.model` was `undefined`
// and threaded into the Anthropic provider (`undefined.toLowerCase()`).

describe("rowToSession — config hydration", () => {
  test("fills `model` and other missing fields from defaults when config_json omits them", () => {
    // Stale row: only a couple of fields persisted, no model/agentModel/provider.
    const stale = JSON.stringify({ expertRounds: 2, socialAgentCount: 5 });
    const session = rowToSession(makeRow({ config_json: stale }));

    expect(session.config.model).toBe(DEFAULT_SIGE_SESSION_CONFIG.model);
    expect(session.config.model).not.toBeUndefined();
    expect(session.config.agentModel).toBe(DEFAULT_SIGE_SESSION_CONFIG.agentModel);
    expect(session.config.provider).toBe(DEFAULT_SIGE_SESSION_CONFIG.provider);
    // Persisted overrides are preserved.
    expect(session.config.expertRounds).toBe(2);
    expect(session.config.socialAgentCount).toBe(5);
    // Untouched fields fall back to defaults.
    expect(session.config.socialRounds).toBe(DEFAULT_SIGE_SESSION_CONFIG.socialRounds);
  });

  test("deep-merges incentiveWeights so a partial weight override keeps other defaults", () => {
    const partial = JSON.stringify({ incentiveWeights: { diversity: 0.9 } });
    const session = rowToSession(makeRow({ config_json: partial }));

    expect(session.config.incentiveWeights.diversity).toBe(0.9);
    expect(session.config.incentiveWeights.building).toBe(
      DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.building,
    );
    expect(session.config.incentiveWeights.socialViability).toBe(
      DEFAULT_SIGE_SESSION_CONFIG.incentiveWeights.socialViability,
    );
  });

  test("falls back to defaults (without throwing) on malformed config_json", () => {
    const session = rowToSession(makeRow({ config_json: "{ not valid json" }));
    expect(session.config).toEqual(DEFAULT_SIGE_SESSION_CONFIG);
    expect(session.config.model).toBe(DEFAULT_SIGE_SESSION_CONFIG.model);
  });

  test("falls back to defaults on empty config_json", () => {
    const session = rowToSession(makeRow({ config_json: "" }));
    expect(session.config).toEqual(DEFAULT_SIGE_SESSION_CONFIG);
  });

  test("falls back to defaults when config_json is missing/non-string", () => {
    const session = rowToSession(makeRow({ config_json: undefined }));
    expect(session.config).toEqual(DEFAULT_SIGE_SESSION_CONFIG);
  });

  test("falls back to defaults when config_json parses to a non-object (JSON null)", () => {
    const session = rowToSession(makeRow({ config_json: "null" }));
    expect(session.config).toEqual(DEFAULT_SIGE_SESSION_CONFIG);
  });

  test("preserves a fully-specified config_json unchanged", () => {
    const session = rowToSession(makeRow());
    expect(session.config).toEqual(DEFAULT_SIGE_SESSION_CONFIG);
  });
});
