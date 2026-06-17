import { describe, expect, it } from "bun:test";
import {
  FEEDBACK_KINDS,
  isFeedbackKind,
  stageToFeedbackKind,
} from "./feedback";

describe("stageToFeedbackKind", () => {
  it("maps validated stage to validated kind", () => {
    expect(stageToFeedbackKind("validated")).toBe("validated");
  });

  it("maps archived stage to archived kind", () => {
    expect(stageToFeedbackKind("archived")).toBe("archived");
  });

  it("maps idea stage to restored kind (restore signal)", () => {
    expect(stageToFeedbackKind("idea")).toBe("restored");
  });

  it("returns null for unknown stages", () => {
    expect(stageToFeedbackKind("frobnicate")).toBeNull();
    expect(stageToFeedbackKind("")).toBeNull();
  });

  it("only ever returns a valid feedback kind or null", () => {
    for (const stage of ["validated", "archived", "idea", "nope", "x"]) {
      const kind = stageToFeedbackKind(stage);
      if (kind !== null) {
        expect(FEEDBACK_KINDS).toContain(kind);
      }
    }
  });
});

describe("isFeedbackKind", () => {
  it("accepts every declared kind", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(isFeedbackKind(kind)).toBe(true);
    }
  });

  it("rejects non-kinds", () => {
    expect(isFeedbackKind("idea")).toBe(false);
    expect(isFeedbackKind("frobnicate")).toBe(false);
    expect(isFeedbackKind("")).toBe(false);
  });
});
