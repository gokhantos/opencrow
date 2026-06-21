/**
 * REGRESSION (module-init order) — semantic-demand-probe must load in isolation.
 *
 * `semantic-demand-probe.ts` and `demand-probes.ts` used to form an import cycle:
 * the helper functions (asText/buildKeywordFilter/queryKeywords/quoteAround/
 * resolveOpts/toCount) lived in `demand-probes.ts`, which ALSO referenced
 * `semanticDemandProbe` at module top-level inside the `DEFAULT_DEMAND_PROBES`
 * array. Whichever module evaluated first, `demand-probes`'s top-level array
 * touched `semanticDemandProbe` before `semantic-demand-probe` finished
 * initialising → `ReferenceError: Cannot access 'semanticDemandProbe' before
 * initialization` (a TDZ crash). It only avoided firing in the app/test lanes by
 * a favourable load order — latent fragility.
 *
 * The fix moved the shared helpers into the LEAF module `demand-probe-helpers.ts`
 * so `semantic-demand-probe` no longer imports from `demand-probes`, breaking the
 * cycle. This test pins that: it imports `semantic-demand-probe` FIRST (the load
 * order that crashed) and asserts the probe constructs into a well-formed object.
 *
 * IMPORTANT: the import of `../semantic-demand-probe` MUST stay the FIRST module
 * import in this file — that ordering is the actual regression surface. On the
 * pre-fix code this file throws at import time (before any test body runs).
 *
 * Lane: *.test.ts → `bun run test:unit` (no DB, no network — pure construction).
 */

import {
  createSemanticDemandProbe,
  SEMANTIC_PROBE_NAME,
  semanticDemandProbe,
} from "./semantic-demand-probe";
import { describe, expect, test } from "bun:test";

describe("semantic-demand-probe isolated module load (TDZ regression)", () => {
  test("the module loads in isolation without a TDZ ReferenceError", () => {
    // Reaching this line at all means the top-level imports above evaluated
    // without throwing — i.e. the demand-probes ↔ semantic-demand-probe cycle is
    // gone. (Pre-fix, this file threw at import time.)
    expect(typeof createSemanticDemandProbe).toBe("function");
    expect(SEMANTIC_PROBE_NAME).toBe("semanticCorpus");
  });

  test("createSemanticDemandProbe() returns a well-formed DemandProbe", () => {
    const probe = createSemanticDemandProbe();
    expect(probe.name).toBe(SEMANTIC_PROBE_NAME);
    expect(typeof probe.probe).toBe("function");
  });

  test("the default-deps singleton is well-formed", () => {
    expect(semanticDemandProbe).toBeDefined();
    expect(semanticDemandProbe.name).toBe(SEMANTIC_PROBE_NAME);
    expect(typeof semanticDemandProbe.probe).toBe("function");
  });
});
