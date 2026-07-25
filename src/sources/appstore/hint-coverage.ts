// hint-coverage.ts — the TRI-STATE over Apple's autocomplete signal, plus the
// pure selection logic for the direct corpus-probe pass.
//
// WHY THIS EXISTS (coverage wave, 2026-07-26)
// ------------------------------------------
// `appstore_autocomplete_hints` (migration 043) is the only demand signal in
// the scanner that is INDEPENDENT of incumbents: the `demand` metric is
// derived from incumbents' ratings-per-day, which makes it a proxy for
// incumbent COMMERCIAL SCALE, not search demand — it structurally punishes
// exactly the under-served niches we are hunting for. Apple's autocomplete
// ordering is different in kind: Apple orders suggestions by query frequency,
// so a low rank is real, giant-free evidence that people type the phrase.
// Measured 2026-07-25 (median demand by best hint rank): rank 0-2 -> 0.936,
// rank 3-5 -> 0.186, rank 6+ -> 0.128 — a 7.3x spread.
//
// The blocker was never the signal, it was ABSENCE SEMANTICS. Until this
// module, a keyword with no hint row was indistinguishable between:
//   (a) Apple was asked and returned nothing for it — a real, usable zero;
//   (b) we simply never asked — no data at all.
// Every consumer therefore had to treat absence as "unknown", which is why
// hint-absence could not be used as a signal at all, and why a hint-based
// retirement rule was impossible. `appstore_autocomplete_probes` (migration
// 057) closes that gap by recording every query actually issued, and
// `resolveHintCoverage` below turns the two tables into an explicit
// three-valued answer.
//
// Deliberately PURE (no imports, no I/O) so it can be unit-tested without a
// DB and consumed by the scoring core, which must never import the store —
// same split as `keyword-scoring.ts` vs `keyword-store.ts`.

/**
 * How strong the "we asked and it wasn't there" evidence is.
 *
 * - `direct` — the keyword ITSELF was issued as an autocomplete query and
 *   Apple's response did not contain it. The strongest possible negative:
 *   Apple does not consider the phrase a completion of itself. Only this
 *   level should ever drive a destructive decision (e.g. retiring a keyword).
 * - `prefix` — some plausible prefix query of the keyword ran (a bare seed or
 *   a `"<seed> <letter>"` fan-out query — see `keyword-autocomplete.ts`) and
 *   did not surface it. Real evidence, but circumstantial: the keyword may
 *   simply not be a completion of THAT prefix.
 */
export type HintProbeConfidence = "direct" | "prefix";

/**
 * The tri-state a consumer asks for: `present(rank)` / `probed-absent` /
 * `never-probed`. Modeled as a discriminated union rather than a
 * `rank: number | null` + `covered: boolean` pair so an exhaustive `switch`
 * on `state` cannot silently forget the `never-probed` case — that omission
 * IS the bug this module exists to prevent (reading "no data" as "no
 * demand").
 */
export type HintCoverage =
  | {
      readonly state: "present";
      /** Best (lowest = most popular) hint rank observed. 0 is the STRONGEST signal, never "missing". */
      readonly bestRank: number;
      /** When the keyword was last directly probed, if it ever was — informational; presence already proves coverage. */
      readonly probedAt: number | null;
    }
  | {
      readonly state: "probed-absent";
      /** Epoch seconds of the last DIRECT probe, or `null` when the evidence is `prefix`-only. */
      readonly probedAt: number | null;
      readonly confidence: HintProbeConfidence;
    }
  | { readonly state: "never-probed" };

export interface HintCoverageInput {
  /**
   * Best `kept` hint rank for the keyword in the evidence window, or `null`
   * if it was never observed as a hint — `keyword-store.ts`'s
   * `getHintEvidence().bestRank`.
   */
  readonly bestRank: number | null;
  /**
   * `last_probed_at` from `appstore_autocomplete_probes` for
   * (keyword, storefront), or `null` if the keyword was never issued as a
   * query itself. Note this is the ledger for the EXACT string — a prefix
   * query that merely contains the keyword does not create this row.
   */
  readonly probedAt: number | null;
  /**
   * The legacy prefix-shaped coverage heuristic (`getHintEvidence().covered`):
   * true iff some plausible query prefix of the keyword appears in the hint
   * log's `seed` column. Strictly weaker than `probedAt` — see
   * `HintProbeConfidence`.
   */
  readonly prefixCovered: boolean;
}

/**
 * Collapses hint presence + the probe ledger + the legacy prefix heuristic
 * into the tri-state. Precedence is deliberate:
 *
 *   1. Any observed rank wins — presence trivially implies we asked.
 *   2. Otherwise a DIRECT probe wins over prefix coverage, because it is
 *      strictly stronger evidence about this exact keyword.
 *   3. Otherwise prefix coverage yields a low-confidence `probed-absent`.
 *   4. Otherwise `never-probed` — which means NO DATA. Never read it as
 *      zero demand.
 */
export function resolveHintCoverage(input: HintCoverageInput): HintCoverage {
  // `!== null`, never a truthiness check: rank 0 is Apple's top suggestion.
  if (input.bestRank !== null && input.bestRank !== undefined) {
    return { state: "present", bestRank: input.bestRank, probedAt: input.probedAt };
  }
  if (input.probedAt !== null && input.probedAt !== undefined) {
    return { state: "probed-absent", probedAt: input.probedAt, confidence: "direct" };
  }
  if (input.prefixCovered) {
    return { state: "probed-absent", probedAt: null, confidence: "prefix" };
  }
  return { state: "never-probed" };
}

/**
 * True iff (keyword, storefront) is due for a (re-)probe: never probed at
 * all, or last probed at least `reprobeAfterSec` ago. A `lastProbedAt` in
 * the FUTURE (clock skew, a bad backfill) counts as fresh rather than
 * wrapping into "extremely stale" — a corrupt timestamp must not be able to
 * conscript the whole corpus into one pass.
 */
export function isProbeStale(
  lastProbedAt: number | null,
  reprobeAfterSec: number,
  nowSec: number,
): boolean {
  if (lastProbedAt === null) return true;
  return nowSec - lastProbedAt >= reprobeAfterSec;
}

/** One candidate for the direct corpus-probe pass — see `selectProbeTargets`. */
export interface ProbeCandidate {
  readonly keyword: string;
  /** Epoch seconds of the last direct probe in the target storefront, or `null` if never probed. */
  readonly lastProbedAt: number | null;
}

export interface SelectProbeTargetsOptions {
  /** Hard cap on queries this pass may issue. `<= 0` selects nothing. */
  readonly limit: number;
  /** How long a probe result stays fresh before the keyword is re-probed. */
  readonly reprobeAfterSec: number;
  readonly nowSec: number;
}

/**
 * Picks this pass's probe targets from `candidates`, NEVER-PROBED FIRST.
 *
 * The ordering is the whole point: the marginal value of a never-probed
 * keyword is a brand-new tri-state datum (a corpus keyword moves out of
 * "no data" for the first time), while the marginal value of a re-probe is
 * only refreshing one we already have. So the pass drains the never-probed
 * backlog before spending a single request on refresh — that is what turns
 * coverage from a trickle into a backfill with a finite completion date.
 * Within each group the caller's input order is preserved (the store hands
 * these over already ordered by decision-relevance), except that re-probes
 * are ordered stalest-first.
 *
 * Pure and total: blanks are skipped (an empty query is a wasted request
 * that would also poison the ledger with an empty `query` key), duplicates
 * are collapsed, fresh probes are dropped, and the input is never mutated.
 */
export function selectProbeTargets(
  candidates: readonly ProbeCandidate[],
  opts: SelectProbeTargetsOptions,
): readonly string[] {
  if (opts.limit <= 0) return [];

  const neverProbed: string[] = [];
  const stale: ProbeCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const keyword = candidate.keyword.trim();
    if (keyword.length === 0) continue;
    if (seen.has(keyword)) continue;
    if (!isProbeStale(candidate.lastProbedAt, opts.reprobeAfterSec, opts.nowSec)) continue;
    seen.add(keyword);
    if (candidate.lastProbedAt === null) neverProbed.push(keyword);
    else stale.push({ keyword, lastProbedAt: candidate.lastProbedAt });
  }

  // Copy before sorting — `stale` is local, but sorting `candidates` itself
  // would mutate the caller's array (house rule: never mutate inputs).
  const staleOrdered = [...stale]
    .sort((a, b) => (a.lastProbedAt ?? 0) - (b.lastProbedAt ?? 0))
    .map((c) => c.keyword);

  return [...neverProbed, ...staleOrdered].slice(0, opts.limit);
}

/** Bucket counts over a set of resolved coverages — for lane observability. */
export interface CoverageSummary {
  readonly present: number;
  readonly probedAbsentDirect: number;
  readonly probedAbsentPrefix: number;
  readonly neverProbed: number;
}

/**
 * Counts each tri-state bucket. Logged per pass so the coverage backfill's
 * progress is observable from the logs alone (`neverProbed` should trend
 * toward zero over the first days after deploy — that trend is the only
 * honest proof the lane is working).
 */
export function summarizeCoverage(coverages: readonly HintCoverage[]): CoverageSummary {
  let present = 0;
  let probedAbsentDirect = 0;
  let probedAbsentPrefix = 0;
  let neverProbed = 0;
  for (const coverage of coverages) {
    if (coverage.state === "present") present++;
    else if (coverage.state === "never-probed") neverProbed++;
    else if (coverage.confidence === "direct") probedAbsentDirect++;
    else probedAbsentPrefix++;
  }
  return { present, probedAbsentDirect, probedAbsentPrefix, neverProbed };
}
