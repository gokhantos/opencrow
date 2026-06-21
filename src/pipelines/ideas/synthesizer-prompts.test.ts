import { test, expect, describe } from "bun:test";
import {
  SCHLEP_INSTRUCTION,
  NEVER_GENERATE_BLOCK,
  CATEGORY_CONTEXT,
} from "./synthesizer-prompts";

// Regression guard for the "uncompetable for a solo builder" generation-time
// exclusion: the NEVER-GENERATE block must be present, and the OLD pro-regulated /
// pro-compliance moat steering must be gone, so generation stops proposing the
// exact ideas the runtime gate hard-vetoes.

describe("NEVER_GENERATE_BLOCK", () => {
  test("names all four uncompetable moat families", () => {
    expect(NEVER_GENERATE_BLOCK).toContain("REGULATED");
    expect(NEVER_GENERATE_BLOCK).toContain("HIGH CAPITAL");
    expect(NEVER_GENERATE_BLOCK).toContain("PHYSICAL LOGISTICS");
    expect(NEVER_GENERATE_BLOCK).toContain("NETWORK-EFFECT");
  });

  test("carries the explicit DISCARD instruction for solo builders", () => {
    expect(NEVER_GENERATE_BLOCK).toContain("DISCARD it");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("solo builder cannot win it in v1");
  });

  test("gives concrete examples of each excluded family", () => {
    // A representative example from each family.
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("neobank");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("hardware");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("last-mile");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("two-sided marketplace");
  });
});

describe("SCHLEP_INSTRUCTION no longer rewards regulated/compliance/capital moats", () => {
  test("does not steer toward regulated workflows as the moat", () => {
    expect(SCHLEP_INSTRUCTION).not.toContain("regulated workflows");
    expect(SCHLEP_INSTRUCTION.toLowerCase()).not.toContain("trust/compliance");
  });

  test("still rewards a SOFTWARE/DATA/INTEGRATION/WORKFLOW moat", () => {
    expect(SCHLEP_INSTRUCTION).toContain("SOFTWARE");
    expect(SCHLEP_INSTRUCTION.toLowerCase()).toContain("workflow");
    // The schlep spirit is preserved.
    expect(SCHLEP_INSTRUCTION).toContain("The hard part IS the moat");
  });
});

describe("CATEGORY_CONTEXT no longer claims a regulated workflow is the moat", () => {
  test("mobile_app reframes the moat away from regulated workflows", () => {
    expect(CATEGORY_CONTEXT.mobile_app).not.toContain("regulated workflow");
    // Still encourages B2B/vertical/devtools with a defensible wedge.
    expect(CATEGORY_CONTEXT.mobile_app).toContain("defensible wedge");
  });
});
