/**
 * Unit tests for the PURE competability decision row builder.
 *
 * No DB, no clock, no rng — `decidedAt` is caller-supplied, so every assertion is
 * exact. Covers: the effective/raw overall mapping, the JSONB object shape (a REAL
 * object, never a JSON string — the double-encode bug guard), title truncation,
 * and the gated/enforced/source flags.
 */
import { describe, expect, it } from "bun:test";
import type { CompetabilityPersisted } from "../../pipelines/ideas/competability";
import {
  buildCompetabilityDecisionRow,
  type CompetabilityDecisionInput,
  MAX_DECISION_TITLE_LENGTH,
} from "./competability-decisions-store";

const PERSISTED: CompetabilityPersisted = {
  dimensions: { capital: 5, networkEffect: 4, logistics: 3, regulated: 2 },
  overall: 1.5,
  reason: "uncompetable for a solo builder",
  gated: true,
  raw: {
    dimensions: { capital: 5, networkEffect: 5, logistics: 4, regulated: 3 },
    overall: 1.0,
  },
  matchedExpertiseDomain: "devtools",
};

function input(partial: Partial<CompetabilityDecisionInput> = {}): CompetabilityDecisionInput {
  return {
    source: "pipeline",
    pipelineRunId: "run-123",
    ideaTitle: "A sharp niche SQL linter",
    persisted: PERSISTED,
    gated: true,
    enforced: true,
    decidedAt: 1_700_000_000,
    ...partial,
  };
}

describe("buildCompetabilityDecisionRow (pure)", () => {
  it("maps effective + raw overall, flags, ids and the JSONB object", () => {
    const row = buildCompetabilityDecisionRow(input());

    expect(row.source).toBe("pipeline");
    expect(row.pipeline_run_id).toBe("run-123");
    expect(row.session_id).toBeNull();
    expect(row.idea_title).toBe("A sharp niche SQL linter");
    // EFFECTIVE overall from persisted.overall; RAW from persisted.raw.overall.
    expect(row.competability_overall).toBe(1.5);
    expect(row.competability_raw_overall).toBe(1.0);
    expect(row.gated).toBe(true);
    expect(row.enforced).toBe(true);
    expect(row.decided_at).toBe(1_700_000_000);

    // The JSONB column MUST be a real object (Bun.sql serializes it to JSONB);
    // a pre-stringified value would double-encode. Assert the structural shape.
    expect(typeof row.competability_json).toBe("object");
    expect(row.competability_json.gated).toBe(true);
    expect(row.competability_json.dimensions.capital).toBe(5);
    expect(row.competability_json.overall).toBe(1.5);
    expect(row.competability_json.raw?.overall).toBe(1.0);
    expect(row.competability_json.matchedExpertiseDomain).toBe("devtools");
  });

  it("carries null raw overall when the persisted scorecard has no raw slice", () => {
    const noRaw: CompetabilityPersisted = {
      dimensions: { capital: 1, networkEffect: 1, logistics: 0, regulated: 0 },
      overall: 4.5,
      reason: "wide open",
      gated: false,
    };
    const row = buildCompetabilityDecisionRow(input({ persisted: noRaw, gated: false }));
    expect(row.competability_raw_overall).toBeNull();
    expect(row.gated).toBe(false);
  });

  it("maps the SIGE source with a session id and a null run id", () => {
    const row = buildCompetabilityDecisionRow(
      input({ source: "sige", pipelineRunId: null, sessionId: "sess-9" }),
    );
    expect(row.source).toBe("sige");
    expect(row.session_id).toBe("sess-9");
    expect(row.pipeline_run_id).toBeNull();
  });

  it("truncates an over-long title to the audit cap", () => {
    const longTitle = "x".repeat(MAX_DECISION_TITLE_LENGTH + 50);
    const row = buildCompetabilityDecisionRow(input({ ideaTitle: longTitle }));
    expect(row.idea_title.length).toBe(MAX_DECISION_TITLE_LENGTH);
  });

  it("leaves a short title unchanged", () => {
    const row = buildCompetabilityDecisionRow(input({ ideaTitle: "short" }));
    expect(row.idea_title).toBe("short");
  });

  it("carries the supplied ideaId on the row", () => {
    const row = buildCompetabilityDecisionRow(input({ ideaId: "idea-abc-123" }));
    expect(row.idea_id).toBe("idea-abc-123");
  });

  it("defaults idea_id to null when ideaId is omitted", () => {
    const row = buildCompetabilityDecisionRow(input());
    expect(row.idea_id).toBeNull();
  });

  it("defaults idea_id to null when ideaId is explicitly null (pipeline path)", () => {
    const row = buildCompetabilityDecisionRow(input({ ideaId: null }));
    expect(row.idea_id).toBeNull();
  });
});
