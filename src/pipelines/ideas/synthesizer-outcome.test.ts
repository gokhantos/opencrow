/**
 * Unit tests for the outcomeMemorySection helper in synthesizer.ts.
 *
 * This guards the empty-in/empty-out contract that backs the
 * "byte-identical default" claim: when readAtSynthesis is OFF the pipeline
 * passes "" and no outcome memory is injected into any prompt. The helper
 * is the innermost seam — if it breaks, a stray block reaches the LLM even
 * when the feature is disabled.
 *
 * Lane: unit (*.test.ts) — pure function, no I/O, no DB.
 */

import { describe, test, expect } from "bun:test";
import { outcomeMemorySection } from "./synthesizer";

const SAMPLE_BLOCK =
  "=== OUTCOME MEMORY (learned from past idea verdicts — guidance, not data) ===\n" +
  "REINFORCE — patterns that PASSED validation (lean toward this rigor):\n" +
  "- <<UNTRUSTED_DATA source=outcome-memory>>\nGreat validated insight\n<<END_UNTRUSTED_DATA>>";

describe("outcomeMemorySection — readAtSynthesis-OFF gate (empty-in/empty-out contract)", () => {
  test('empty string in → empty string out (readAtSynthesis OFF path produces no prompt change)', () => {
    // When smart.outcomeMemory.readAtSynthesis is false, the pipeline passes ""
    // to outcomeMemorySection. The result must be exactly "" so the prompt
    // is byte-identical to a run without the feature enabled.
    expect(outcomeMemorySection("")).toBe("");
  });

  test('non-empty block in → block prefixed with a single newline', () => {
    // When readAtSynthesis is ON and a block was fetched, it must be injected
    // into the prompt with a leading newline separator (matching the other
    // section helpers: validatedExemplarSection, antiExemplarSection).
    const result = outcomeMemorySection(SAMPLE_BLOCK);
    expect(result).toBe(`\n${SAMPLE_BLOCK}`);
  });

  test('non-empty block in → starts with exactly one newline (no double-newline)', () => {
    // Defensive: the helper must add exactly one newline, not two — prompt
    // spacing is intentional and a double-newline would differ from the contract.
    const result = outcomeMemorySection(SAMPLE_BLOCK);
    expect(result.startsWith("\n\n")).toBe(false);
    expect(result.startsWith("\n")).toBe(true);
  });

  test('whitespace-only string is treated as non-empty (passes through unchanged)', () => {
    // A non-empty but whitespace-only string is truthy in JS — the helper
    // should not attempt to trim/validate the content, just wrap it. The
    // caller (pipeline) is responsible for not passing garbage.
    const ws = "   ";
    expect(outcomeMemorySection(ws)).toBe(`\n${ws}`);
  });
});
