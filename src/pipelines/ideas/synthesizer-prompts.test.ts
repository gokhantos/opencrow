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

  test("excludes the local / SMB service-business audience (trades + local services)", () => {
    // The fifth exclusion family: an AUDIENCE rule, independent of moat type.
    expect(NEVER_GENERATE_BLOCK).toContain("LOCAL / SMB SERVICE-BUSINESS AUDIENCE");
    // Representative skilled-trades / field-service examples.
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("electricians");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("plumbers");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("hvac");
    // Representative local-service-business examples.
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("salons");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("restaurants");
  });

  test("does NOT contradict the pro-vertical steer (larger non-local industries stay in scope)", () => {
    // The audience rule must carve out deep vertical / ops software for LARGER,
    // non-local industries so it doesn't fight SCHLEP_INSTRUCTION.
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("larger, non-local industries remains in scope");
  });

  test("excludes a region-locked core (single-nation rules / local payment rail / one locale)", () => {
    expect(NEVER_GENERATE_BLOCK).toContain("REGION-LOCKED CORE");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("region-locked");
    // A representative local payment rail and the single-language binding.
    expect(NEVER_GENERATE_BLOCK).toContain("UPI");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("single language");
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain("globally-applicable");
  });

  test("does NOT ban beachhead/wedge framing (global idea launching in one market first is FINE)", () => {
    // The region-lock rule must preserve the marketShape narrow-wedge → large-TAM
    // steer: a globally-applicable idea that beachheads in one market is allowed.
    expect(NEVER_GENERATE_BLOCK.toLowerCase()).toContain(
      "globally applicable but launches in one beachhead market first is fine",
    );
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
