import { describe, expect, it } from "bun:test";
import { extractJson } from "./taste-filter";

describe("extractJson", () => {
  it("parses a clean JSON object", () => {
    const r = extractJson('{"verdicts":[{"id":"a","specificity":0.8,"pass":true}]}');
    expect(Array.isArray(r.verdicts)).toBe(true);
    expect((r.verdicts as unknown[]).length).toBe(1);
  });

  it("parses a fenced ```json block", () => {
    const r = extractJson('```json\n{"verdicts":[{"id":"a","pass":true}]}\n```');
    expect((r.verdicts as unknown[]).length).toBe(1);
  });

  it("salvages complete verdicts from a TRUNCATED response (real failure mode)", () => {
    // Response cut off mid-stream: the 3rd verdict has no closing brace and the
    // array/object are never closed — exactly what killed session 6d39a69f.
    const truncated = [
      "```json",
      "{",
      '  "verdicts": [',
      '    { "id": "a", "specificity": 0.8, "signal_grounding": 0.9, "pass": true, "reason": "good", "failed_criteria": [] },',
      '    { "id": "b", "specificity": 0.7, "signal_grounding": 0.6, "pass": true, "reason": "ok", "failed_criteria": [] },',
      '    { "id": "c", "specificity": 0.5, "signal_grounding": 0.4, "pass": false, "reason": "Cryptographic timestamping ',
    ].join("\n");

    const r = extractJson(truncated);
    const verdicts = r.verdicts as Array<{ id: string }>;
    // The two COMPLETE verdicts are salvaged; the truncated third is dropped.
    expect(verdicts.length).toBe(2);
    expect(verdicts.map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("throws only when nothing at all is salvageable", () => {
    expect(() => extractJson("totally not json, no objects here")).toThrow(
      /Unable to extract JSON/,
    );
  });
});
