-- Batch F (App Store keyword pipeline consumption & actionability), F5 leg 1-3:
-- durable keyword-level VERDICTS, replacing the localStorage-only watchlist
-- (OpportunitiesTab.tsx) as the source of truth for cross-device starring,
-- and giving the idea-synthesis pipeline (`collectKeywordGaps`) a real
-- exclude/downweight signal instead of re-seeding dismissed/killed keywords
-- forever.
--
-- Composite PK (keyword, source) — DELIBERATE, not just (keyword): a human
-- verdict (e.g. a dashboard "star") and a pipeline verdict (e.g. a screener
-- soft-downweight "dismissed" — see `appstore-signature-hits.ts`) can coexist
-- independently for the SAME keyword without clobbering each other. This is
-- what lets a screener "velocity alert is noise" dismissal stay a SOFT
-- downweight signal (source='pipeline') distinct from a human "this whole
-- keyword is dead" call (source='human') — the collector treats the two
-- differently (hard-exclude human dismissed/killed; soft-downweight pipeline
-- dismissed — see `collector-keyword-gaps.ts`).
--
-- Idempotent (IF NOT EXISTS everywhere) and additive — safe to re-run.

CREATE TABLE IF NOT EXISTS appstore_keyword_verdicts (
  keyword TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('starred', 'dismissed', 'validated', 'killed')),
  source TEXT NOT NULL CHECK (source IN ('human', 'pipeline')),
  note TEXT,
  decided_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (keyword, source)
);

-- Backs `getStarredKeywords` (the server-side watchlist a starred dashboard
-- row / F3's priority seed pull reads) and `getExcludedKeywords` /
-- `getDownweightedKeywords` (the collector's exclude/downweight sets) — all
-- filter on `verdict` (+ `source`), never scan the whole table.
CREATE INDEX IF NOT EXISTS idx_appstore_keyword_verdicts_verdict
  ON appstore_keyword_verdicts (verdict, source);
