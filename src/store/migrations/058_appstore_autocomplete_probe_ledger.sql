-- Coverage wave (2026-07-26): make autocomplete ABSENCE readable.
--
-- THE PROBLEM. `appstore_autocomplete_hints` (migration 043) is the only
-- demand signal in the scanner that is independent of incumbents — the
-- `demand` metric is derived from incumbents' ratings-per-day, i.e. a proxy
-- for incumbent COMMERCIAL SCALE, which structurally punishes the
-- under-served niches the scanner exists to find. Apple orders autocomplete
-- suggestions by query frequency, so hint rank is giant-free evidence of real
-- search demand (measured 2026-07-25 median demand by best rank: 0-2 -> 0.936,
-- 3-5 -> 0.186, 6+ -> 0.128).
--
-- But the hints table records only what Apple RETURNED. It has no record of
-- what we ASKED. So the absence of a row for a keyword is ambiguous between
-- two completely different facts:
--   (a) Apple was asked for it and returned nothing — a real, usable zero;
--   (b) it was never asked — no data whatsoever.
-- Migration 052's `kept` column fixed a narrower version of this (a term
-- Apple returned but our junk filter dropped), and `getHintEvidence`'s
-- `covered` flag approximates (a) vs (b) by testing whether a plausible
-- PREFIX of the keyword appears in the `seed` column. That heuristic has two
-- holes this table closes:
--   1. A query that Apple answered with an EMPTY suggestion list produces NO
--      hint rows at all, so the `seed` column never records that it ran. The
--      single most informative negative observation available is the one
--      observation the schema could not represent.
--   2. Prefix-shaped inference is not the same claim as "we asked for this
--      exact phrase". A retirement rule needs the exact claim.
--
-- THE FIX. An explicit, per-(query, storefront) probe ledger: one row per
-- query string ever issued to Apple's MZSearchHints endpoint, recording when
-- it last ran, whether Apple returned anything, and where the query itself
-- landed in its own results. Combined with the hints table this yields the
-- tri-state `present(rank)` / `probed-absent` / `never-probed` — see
-- `hint-coverage.ts`'s `resolveHintCoverage`, the consumer-facing contract.
--
-- Shape notes:
--   - Keyed (query, storefront), matching `appstore_autocomplete_hints`'s
--     per-market `storefront` column (migration 049) and
--     `appstore_seed_expansion_state`'s composite PK (migration 051): Apple's
--     popularity ordering is inherently per-market, so "probed in GB" is not
--     "probed in US".
--   - `query` is the EXACT string sent to Apple, matching
--     `appstore_autocomplete_hints.seed`'s convention — a bare seed, a
--     `"<seed> <letter>"` prefix-fan-out query, or a direct corpus-keyword
--     probe (see `hint-probe-pass.ts`).
--   - UPSERT semantics are latest-wins for `returned_any` / `term_count` /
--     `self_rank` (the CURRENT state of the signal is what a consumer needs),
--     while `first_probed_at` is preserved and `probe_count` accumulates so
--     the observation history is not lost.
--   - A FAILED fetch (non-OK status, timeout, rate limit) must NOT write a
--     row: recording it would manufacture a fake "Apple returned nothing".
--     That invariant lives in `keyword-autocomplete.ts`'s fetch outcome type,
--     not in the schema, but it is the reason `returned_any` is NOT NULL —
--     there is no "unknown" state to represent.
--   - No retention prune. The ledger IS the memory of what has been asked;
--     deleting a row silently regresses a keyword from `probed-absent` back
--     to `never-probed`. It is also tiny (one row per distinct query, ~20k
--     scale) next to the hints log itself.
--
-- Additive + idempotent per repo convention.

CREATE TABLE IF NOT EXISTS appstore_autocomplete_probes (
  -- Exact query string sent to Apple — see the shape notes above.
  query           TEXT     NOT NULL,
  -- Lowercase iTunes storefront cc ('us', 'gb'), matching
  -- `appstore_autocomplete_hints.storefront` — NOT the raw
  -- `X-Apple-Store-Front` header value.
  storefront      TEXT     NOT NULL DEFAULT 'us',
  first_probed_at BIGINT   NOT NULL,
  last_probed_at  BIGINT   NOT NULL,
  probe_count     INTEGER  NOT NULL DEFAULT 1,
  -- Did Apple return AT LEAST ONE raw suggestion on the most recent probe?
  -- FALSE is the observation the pre-migration schema could not represent.
  returned_any    BOOLEAN  NOT NULL,
  -- How many raw (pre-junk-filter) terms the most recent probe returned.
  term_count      SMALLINT NOT NULL DEFAULT 0,
  -- 0-based position at which the probed query itself appeared in its own
  -- results, or NULL if Apple did not suggest the exact phrase back. For a
  -- direct corpus-keyword probe this is the keyword's own rank — the "best
  -- rank if it did" datum — and a NULL here with `returned_any = TRUE` is the
  -- cleanest possible negative: Apple answered, and the phrase wasn't in it.
  self_rank       SMALLINT NULL,
  PRIMARY KEY (query, storefront)
);

-- Backs the re-probe staleness scan (`hint-probe-store.ts`'s
-- `getDirectProbeCandidates` orders by `last_probed_at ASC` within a
-- storefront) and the lane's coverage-progress counters
-- (`countHintProbes`). The (query, storefront) PK already serves the
-- per-keyword lookups (`getHintProbeRecords`) and the LEFT JOIN from
-- `appstore_keywords`, which both lead with `query`.
CREATE INDEX IF NOT EXISTS idx_appstore_autocomplete_probes_staleness
  ON appstore_autocomplete_probes (storefront, last_probed_at ASC);
