// hint-probe-pass.ts — DIRECT autocomplete probing of corpus keywords.
//
// WHY A SECOND LANE EXISTS
// ------------------------
// `keyword-autocomplete.ts`'s `expandCorpus` is a DISCOVERY lane: it picks a
// few dozen seeds, fans out over prefixes, and harvests whatever Apple
// suggests. Hint coverage of the corpus is a SIDE EFFECT of that — a keyword
// only gets a rank if it happens to fall out of somebody else's query. That is
// why coverage was 18,455 of 145,351 corpus keywords (12.7%, measured
// 2026-07-26) after five days of running, and why it was missing at exactly
// the keywords decisions get made about: `peptide tracker`, `card grading`,
// `block shorts` and `screen time` had no hint at all.
//
// This lane inverts the direction: it starts from the keywords we care about
// and asks Apple about each one BY NAME. One request yields a definitive
// tri-state datum for that keyword (`present(rank)` / `probed-absent`) instead
// of a lottery ticket, and it is the only way a keyword can ever leave
// `never-probed` on purpose rather than by luck.
//
// SCOPE DISCIPLINE — this lane is READ-ONLY with respect to the corpus.
// It writes `appstore_autocomplete_hints` (the signal) and
// `appstore_autocomplete_probes` (the coverage ledger), and it never calls
// `upsertKeywords`. Growing coverage must not become a second, unfiltered
// corpus-growth path: `expandCorpus` remains the only autocomplete writer into
// `appstore_keywords`, so its brand-navigational and junk admission filters
// (`keyword-brand.ts`, `keyword-junk.ts`) remain the sole gate and are
// untouched by this change. Terms Apple returns here are still junk-classified
// for the hint log (`kept`), they are simply never admitted as new keywords.

import { getErrorMessage } from "../../lib/error-serialization";
import { createLogger } from "../../logger";
import { isPassOverBudget } from "../shared/pass-deadline";
import { selectProbeTargets } from "./hint-coverage";
import { countHintProbes, getDirectProbeCandidates, recordHintProbes } from "./hint-probe-store";
import type { HintProbeWrite } from "./hint-probe-store";
import { buildProbeWrite, classifyHintTerms, fetchHintTerms } from "./keyword-autocomplete";
import { insertAutocompleteHints } from "./keyword-store";
import type { AutocompleteHintRow } from "./keyword-store";

const log = createLogger("appstore:hint-probe-pass");

/**
 * Wall-clock budget for one pass (`pass-deadline.ts`). Same 8-minute figure as
 * `keyword-autocomplete.ts`'s expansion pass and `keyword-gaps.ts`'s scan
 * batch, and for the same reason: this lane shares `scraper.ts`'s
 * single-flight `auxiliaryLanesTick` with ~12 others, so a slow-but-successful
 * upstream must not be able to wedge all of them.
 */
const MAX_PASS_DURATION_MS = 8 * 60_000;

/**
 * How many candidate rows to ask the DB for relative to the request cap. A
 * small oversample absorbs the rows `selectProbeTargets` drops (blank or
 * duplicate keywords) so a pass doesn't come up short of its budget, while
 * staying far away from "select the whole corpus".
 */
const CANDIDATE_OVERSAMPLE = 2;

export interface ProbeCorpusOptions {
  /** Raw `X-Apple-Store-Front` header value — MANDATORY, see keyword-autocomplete.ts's module doc. */
  readonly storefront: string;
  /** Lowercase storefront cc that tags hint + probe rows (`"us"` / `"gb"`). */
  readonly market: string;
  /** Hard cap on requests this pass may issue. */
  readonly limit: number;
  /** Cap on GOOD (junk-filtered) terms marked `kept` per response — mirrors `expandCorpus`'s `perSeed`. */
  readonly perSeed: number;
  /** Delay between requests within the pass. */
  readonly delayMs: number;
  /** Route this lane's fetches through the Webshare proxy. */
  readonly useProxy: boolean;
  /** How long a probe result stays fresh before the keyword is re-probed. */
  readonly reprobeAfterSec: number;
  /** A `mined` keyword must have scored at least this once to be worth a probe. */
  readonly opportunityFloor: number;
  /** How far back a qualifying `opportunityFloor` scan may be. */
  readonly opportunityLookbackSec: number;
}

export interface ProbeCorpusResult {
  /** Candidate keywords the selector handed this pass (before the request cap bit). */
  readonly targeted: number;
  /** Requests actually issued. */
  readonly attempted: number;
  /** Requests Apple ANSWERED — i.e. probe-ledger rows written. */
  readonly probesRecorded: number;
  /** Of those, how many came back with an empty suggestion list (a real, usable zero). */
  readonly emptyResponses: number;
  /** Of those, how many had Apple suggest the probed phrase back (`self_rank IS NOT NULL`). */
  readonly selfSuggested: number;
  /** Requests that hit an exhausted rate-limit retry — fed into the caller's throttle accounting. */
  readonly rateLimitErrors: number;
  /**
   * Total RAW terms returned across the pass, pre-junk-filter. Same
   * flatline-detector contract as `ExpandCorpusResult.rawTermCount`:
   * `attempted > 0 && rawTermCount === 0` is the shape of an endpoint/header
   * break, NOT of a corpus with no demand.
   */
  readonly rawTermCount: number;
  /** Hint-log rows written (every parsed term, kept or not — gapless ranks). */
  readonly hintRowsWritten: number;
  /** Ledger size for this storefront after the pass — the coverage-progress counter. */
  readonly ledgerTotal: number;
  /** True if the wall-clock budget cut the pass short. */
  readonly bailedOnBudget: boolean;
}

const EMPTY_RESULT: ProbeCorpusResult = {
  targeted: 0,
  attempted: 0,
  probesRecorded: 0,
  emptyResponses: 0,
  selfSuggested: 0,
  rateLimitErrors: 0,
  rawTermCount: 0,
  hintRowsWritten: 0,
  ledgerTotal: 0,
  bailedOnBudget: false,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probes up to `limit` corpus keywords directly against Apple's
 * search-suggest endpoint, persisting every answer to the hint log and every
 * ANSWERED query to the probe ledger.
 *
 * NEVER THROWS. Fetches can't throw (`fetchHintTerms` returns an outcome),
 * candidate selection degrades to `[]` on DB trouble, and the persistence step
 * is guarded — the caller's tick must survive this lane unconditionally.
 * Rate-limit-exhausted failures are counted in `rateLimitErrors` for the
 * caller's throttle accounting, exactly as `expandCorpus` does, and a failed
 * request NEVER writes a probe row (that would fabricate a confirmed zero —
 * see `HintFetchOutcome`).
 */
export async function probeCorpusKeywords(
  opts: ProbeCorpusOptions,
): Promise<ProbeCorpusResult> {
  if (opts.limit <= 0) return EMPTY_RESULT;

  const passStartedAtMs = Date.now();
  const nowSeconds = Math.floor(passStartedAtMs / 1000);

  const candidates = await getDirectProbeCandidates({
    market: opts.market,
    limit: opts.limit * CANDIDATE_OVERSAMPLE,
    reprobeBefore: nowSeconds - opts.reprobeAfterSec,
    opportunityFloor: opts.opportunityFloor,
    opportunitySince: nowSeconds - opts.opportunityLookbackSec,
  });

  const targets = selectProbeTargets(candidates, {
    limit: opts.limit,
    reprobeAfterSec: opts.reprobeAfterSec,
    nowSec: nowSeconds,
  });
  if (targets.length === 0) return EMPTY_RESULT;

  const hintRows: AutocompleteHintRow[] = [];
  const probeWrites: HintProbeWrite[] = [];
  let attempted = 0;
  let rateLimitErrors = 0;
  let rawTermCount = 0;
  let emptyResponses = 0;
  let selfSuggested = 0;
  let bailedOnBudget = false;

  for (const keyword of targets) {
    if (isPassOverBudget(passStartedAtMs, MAX_PASS_DURATION_MS)) {
      bailedOnBudget = true;
      break;
    }
    attempted++;
    const outcome = await fetchHintTerms(keyword, opts.storefront, opts.useProxy);
    if (!outcome.ok) {
      if (outcome.rateLimited) rateLimitErrors++;
      // Deliberately no ledger row and no `last_probed_at` bump: the keyword
      // stays at the front of the selection order and gets retried next pass,
      // rather than being recorded as a confirmed absence.
      if (opts.delayMs > 0) await delay(opts.delayMs);
      continue;
    }

    const terms = outcome.terms;
    rawTermCount += terms.length;
    if (terms.length === 0) emptyResponses++;

    const probe = buildProbeWrite({
      query: keyword,
      storefront: opts.market,
      probedAt: nowSeconds,
      terms,
    });
    if (probe.selfRank !== null) selfSuggested++;
    probeWrites.push(probe);

    // Same hint-log contract as `expandCorpus`: log EVERY parsed term with its
    // raw rank and a `kept` verdict, so ranks stay gapless and absence within
    // a response is sound. `seed` is the probed keyword itself, which is what
    // makes these rows also satisfy `getHintEvidence`'s prefix-shaped coverage
    // check for that exact keyword.
    for (const entry of classifyHintTerms(terms, opts.perSeed)) {
      hintRows.push({
        seed: keyword,
        term: entry.term,
        rank: entry.rank,
        seenAt: nowSeconds,
        storefront: opts.market,
        kept: entry.kept,
      });
    }

    if (opts.delayMs > 0) await delay(opts.delayMs);
  }

  let ledgerTotal = 0;
  try {
    if (hintRows.length > 0) await insertAutocompleteHints(hintRows);
    if (probeWrites.length > 0) await recordHintProbes(probeWrites);
    ledgerTotal = (await countHintProbes(opts.market)).total;
  } catch (err) {
    // Losing a pass's writes costs one cycle of coverage; throwing here would
    // cost the whole auxiliary tick.
    log.warn("Direct hint-probe persistence failed — pass results dropped", {
      market: opts.market,
      hintRows: hintRows.length,
      probeWrites: probeWrites.length,
      error: getErrorMessage(err),
    });
  }

  const result: ProbeCorpusResult = {
    targeted: targets.length,
    attempted,
    probesRecorded: probeWrites.length,
    emptyResponses,
    selfSuggested,
    rateLimitErrors,
    rawTermCount,
    hintRowsWritten: hintRows.length,
    ledgerTotal,
    bailedOnBudget,
  };

  if (bailedOnBudget) {
    log.warn("Direct hint-probe pass bailing early — exceeded wall-clock budget", {
      market: opts.market,
      maxDurationMs: MAX_PASS_DURATION_MS,
      elapsedMs: Date.now() - passStartedAtMs,
      attempted,
      targeted: targets.length,
    });
  }

  log.info("Direct hint probe", result);
  return result;
}
