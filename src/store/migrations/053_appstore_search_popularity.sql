-- Manual-import surface for Apple's ASA "searchPopularity" metric (1..5) and,
-- later, hint-sighting-derived volume proxies. This table is fed by TWO
-- writers with very different trust levels:
--
--   'asa'  — ground-truth Apple Search Ads popularity scores. There is NO
--            programmatic sweep for this: the ASA Campaign Management API v5
--            has no popularity endpoint, and the custom-reports probe
--            (`apple-ads/probe.ts`, "PENDING LIVE VALIDATION") is
--            impression-gated and returns empty for arbitrary keywords. The
--            2026-07-20 28-term US sweep that surfaced this gap was driven by
--            Playwright against the ASA web UI — free/manual, not a declined
--            paid provider. So `POST /appstore/search-popularity`
--            (`popularity-store.ts`'s `upsertPopularity`) is the primary
--            writer, with the probe route allowed to opportunistically upsert
--            on a rare success, per its own doc comment — never the sole
--            'asa' source.
--   'hint' — reserved for batch D's `getHintEvidence` (hint-sighting volume
--            proxy). NOT populated by this migration/module; the source
--            column exists so hint rows compose into the same table without
--            a second migration once that lane lands.
--
-- Deliberately NOT a scoring multiplier (coverage is a handful of manually
-- probed keywords against a 100k+ corpus) — consumed only as a veto/
-- annotation: `keyword-store.ts`'s `getTopOpportunities` LEFT JOINs the
-- latest 'asa' row per keyword for display, and
-- `collector-keyword-gaps.ts`'s `excludeKnownZeroVolume` knob drops
-- known-dead (`value <= 1`) keywords from seed selection, gated on
-- `checked_at` freshness so a stale sweep can't permanently blacklist a term.
--
-- `storefront` is a 2-letter ISO country code (e.g. "US"), matching the ASA
-- `countryOrRegion` convention used by `apple-ads/probe.ts` — NOT the 3-value
-- `appstore_keyword_scans.store` ("app"/"play"/"DE") lane tag.
CREATE TABLE IF NOT EXISTS appstore_search_popularity (
  keyword     TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('asa', 'hint')),
  value       SMALLINT NOT NULL CHECK (value >= 0 AND value <= 5),
  storefront  TEXT NOT NULL,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, source, storefront)
);

-- Backs both `getLatestPopularity` (single-keyword lookup, `analyze_keyword_gap`
-- tool) and the freshness-gated `getTopOpportunities` LEFT JOIN LATERAL
-- (latest row per keyword regardless of storefront).
CREATE INDEX IF NOT EXISTS idx_appstore_search_popularity_keyword_checked
  ON appstore_search_popularity (keyword, checked_at DESC);
