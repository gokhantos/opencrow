-- 2026-07-25 "corpus hygiene": (1) PERMANENT keyword retirement and (2) HONEST
-- derived genre zones for the App Store keyword corpus. Additive + idempotent
-- + guarded — no column is dropped, no existing value is rewritten, and every
-- statement is safe to re-run.
--
-- ─── (1) Retirement ────────────────────────────────────────────────────────
-- `appstore_keywords.active` was the only lever, and it is a REVERSIBLE,
-- reason-free boolean that any future re-admission path can silently flip
-- back. Live measurement (2026-07-25): of 16,195 active `autocomplete`
-- keywords only 179 have EVER been deactivated, despite ~90% of that pool
-- being brand-navigational — `keyword-deactivation.ts`'s general
-- `shouldDeactivateKeyword` needs BOTH `demand < 1` AND `topAppReviews <
-- 1000`, an AND-gate over two orthogonal signals that a brand SERP (one real,
-- if small, incumbent) fails on the reviews half.
--
--   `retired_at`            epoch seconds; NULL = not retired. Flag AND
--                           timestamp in one nullable BIGINT — same convention
--                           as `last_de_scanned_at` (migration 050) and
--                           `appstore_app_meta.delisted_at` (045). A separate
--                           boolean would be a second source of truth that can
--                           disagree with the timestamp.
--   `retired_reason`        WHY, from a closed vocabulary (CHECK below). A
--                           retirement with no auditable reason is not
--                           reviewable, and this corpus has already been
--                           pruned once by rules that later proved wrong.
--   `retirement_checked_at` epoch seconds of the last time the retirement
--                           sweep EVALUATED this keyword (fired or not). This
--                           is the sweep's resume cursor — ordering by it
--                           `ASC NULLS FIRST` makes the sweep bounded,
--                           resumable and idempotent without persisting any
--                           separate offset state (same trick as
--                           `getTier1ProtectedKeywords`'s
--                           `last_de_scanned_at` ordering).
--
-- Retirement is STRICTLY STRONGER than deactivation, never a replacement:
-- `keyword-store.ts`'s `retireKeywords` sets `active = FALSE` in the SAME
-- statement, so every pre-existing `active = TRUE` filter in every selection
-- path already excludes a retired keyword even before the explicit
-- `retired_at IS NULL` predicates this change adds alongside them (belt +
-- suspenders, matching `deactivateJunkKeywords`'s own redundant
-- `source NOT IN ('manual','seed')` check).
--
-- Reversible by design: this only ever ADDS a timestamp + reason. Un-retiring
-- is `UPDATE appstore_keywords SET retired_at = NULL, retired_reason = NULL,
-- active = TRUE WHERE keyword = ...` — a single statement, no data lost.
--
-- ─── (2) Honest derived genre zones ────────────────────────────────────────
-- `genre_zone` is NOT NULL and has been filled with `keyword-miner.ts`'s
-- `DEFAULT_ZONE` ('lifestyle') by every discovery path that had no real
-- category to work from. Live measurement (2026-07-25): 73,028 of 95,570
-- active keywords (76%) sit in that one label, while only 2,537 keywords
-- actually derive `lifestyle` from their SERP incumbents' real categories —
-- i.e. ~97% of the label is fiction, and any consumer segmenting by
-- `genre_zone` is segmenting on a default.
--
-- The honest value goes in NEW, NULLABLE columns rather than by rewriting
-- `genre_zone` in place, for three reasons: (a) "unclassified" MUST be
-- representable, and `genre_zone` is `NOT NULL` — relaxing that would push a
-- `string | null` through ~15 consumers (dashboard, web routes, tools,
-- pipelines) in the same change that introduces the derivation; (b) the 704
-- hand-seeded rows' real, human-assigned zones must survive untouched, which
-- they trivially do if nothing writes `genre_zone`; (c) it makes the cutover
-- a separate, reviewable diff per consumer instead of one big-bang rewrite.
--
--   `genre_zone_derived`      the mode zone of the keyword's SERP incumbents'
--                             REAL categories, or NULL. NULL is the honest
--                             answer whenever there are too few incumbents
--                             with a resolvable category, the mode's share is
--                             below `ZONE_MIN_CONFIDENCE`, or no category maps
--                             to a known zone. Consumers MUST treat NULL as
--                             "unclassified" — NEVER as a category, and never
--                             `COALESCE` it to a default (that is the exact
--                             bug this column exists to end).
--   `genre_zone_confidence`   share of resolvable incumbents agreeing with the
--                             mode, 0..1. NULL iff `genre_zone_derived` is NULL.
--   `genre_zone_derived_at`   epoch seconds of the derivation; also the
--                             backfill/refresh cursor (`ASC NULLS FIRST`).
--                             Set even when the derivation yields NULL, so a
--                             keyword that cannot be classified is not
--                             re-evaluated on every pass.
--
-- Projected effect of the backfill (read-only measurement, 2026-07-25 — see
-- `scripts/backfill-keyword-zones.ts`): 95,012 active keywords have a usable
-- latest US scan; 40,485 have >=1 incumbent whose category maps to a real
-- zone; at `ZONE_MIN_CONFIDENCE = 0.5` 33,623 get a zone, of which 20,037
-- DISAGREE with the currently stored `genre_zone` and 15,790 are rescued from
-- the fake `lifestyle` default. The remaining ~61,000 stay NULL — that is the
-- honest state, not a regression.

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS retired_at BIGINT;

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS retired_reason TEXT;

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS retirement_checked_at BIGINT;

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS genre_zone_derived TEXT;

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS genre_zone_confidence REAL;

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS genre_zone_derived_at BIGINT;

-- Closed reason vocabulary, mirroring `keyword-retirement.ts`'s
-- `RetirementReason` union (a typo'd reason must fail loudly at write time,
-- not silently become an un-queryable audit hole). `retired_reason` is only
-- meaningful together with `retired_at`; both-NULL and both-set are the only
-- valid states. `IF NOT EXISTS` has no ADD CONSTRAINT equivalent, so this uses
-- the same drop-then-add idempotency pattern as migration 051's primary key:
-- each run drops whatever version of this named constraint is present (if any)
-- and re-adds exactly this one. Safe on a populated table — every existing row
-- has both columns NULL, which satisfies the first branch.
ALTER TABLE appstore_keywords
  DROP CONSTRAINT IF EXISTS appstore_keywords_retired_reason_check;

ALTER TABLE appstore_keywords
  ADD CONSTRAINT appstore_keywords_retired_reason_check CHECK (
    (retired_at IS NULL AND retired_reason IS NULL)
    OR (
      retired_at IS NOT NULL
      AND retired_reason IN (
        'structural-junk',
        'brand-lexical',
        'brand-serp-shape',
        'autocomplete-probed-absent',
        'score-based',
        'manual'
      )
    )
  );

-- The retirement sweep's resume cursor: never-checked keywords first, then
-- longest-ago-checked. Partial so the index stays proportional to the pool the
-- sweep can actually act on (active, not-yet-retired, non-protected sources)
-- rather than the whole 145k-row table. `source NOT IN (...)` is IMMUTABLE, so
-- it is a legal partial-index predicate.
CREATE INDEX IF NOT EXISTS idx_appstore_keywords_retirement_cursor
  ON appstore_keywords (retirement_checked_at ASC NULLS FIRST)
  WHERE active = TRUE AND retired_at IS NULL AND source NOT IN ('manual', 'seed');

-- Retired-keyword lookups (audit reporting, the family-root fetch in
-- `getRetiredFamilyRoots`, and un-retire operations). Partial: the retired set
-- is the minority and only ever grows slowly.
CREATE INDEX IF NOT EXISTS idx_appstore_keywords_retired
  ON appstore_keywords (retired_reason, retired_at DESC)
  WHERE retired_at IS NOT NULL;

-- Zone-derivation backfill/refresh cursor — never-derived first. Partial on
-- `active` since the derivation only runs for the live corpus.
CREATE INDEX IF NOT EXISTS idx_appstore_keywords_zone_derivation_cursor
  ON appstore_keywords (genre_zone_derived_at ASC NULLS FIRST)
  WHERE active = TRUE;

-- Segmenting/sampling by the HONEST zone (the read path that replaces
-- `genre_zone` filters as consumers migrate). Partial on NOT NULL: an
-- unclassified keyword is never a member of any zone bucket, so it has no
-- business occupying index space.
CREATE INDEX IF NOT EXISTS idx_appstore_keywords_zone_derived
  ON appstore_keywords (genre_zone_derived, genre_zone_confidence DESC)
  WHERE genre_zone_derived IS NOT NULL;
