/**
 * Persistence for keyword-level VERDICTS (migration 054) — Batch F, F5 legs
 * 1-3: durable, cross-device replacement for the localStorage-only watchlist
 * (`OpportunitiesTab.tsx`), and a real exclude/downweight signal for the
 * idea-synthesis pipeline's `collectKeywordGaps` (which previously had no way
 * to learn "stop reseeding this keyword").
 *
 * Composite PK (keyword, source) — see migration 054's doc comment: a human
 * verdict (dashboard star / kill) and a pipeline verdict (screener soft-
 * downweight dismissal) can coexist independently for the SAME keyword. The
 * collector treats them differently:
 *   - `source: "human"`, verdict `"dismissed"`/`"killed"` -> HARD exclude.
 *   - `source: "pipeline"`, verdict `"dismissed"` -> SOFT downweight (still
 *     eligible, ranked lower) — see `keyword-deactivation.ts`'s doc comment
 *     on why a screener dismissal ("this velocity alert is noise") must never
 *     auto-map to "stop scanning/seeding this keyword".
 *
 * Follows the house `XRow` (snake_case) <-> domain (camelCase, readonly)
 * split used throughout `keyword-store.ts` / `signature-hits-store.ts`.
 */

import { getDb } from "../../store/db";

export type KeywordVerdict = "starred" | "dismissed" | "validated" | "killed";
export const KEYWORD_VERDICTS: readonly KeywordVerdict[] = Object.freeze([
  "starred",
  "dismissed",
  "validated",
  "killed",
]);

export type KeywordVerdictSource = "human" | "pipeline";
export const KEYWORD_VERDICT_SOURCES: readonly KeywordVerdictSource[] = Object.freeze([
  "human",
  "pipeline",
]);

export interface KeywordVerdictRecord {
  readonly keyword: string;
  readonly verdict: KeywordVerdict;
  readonly source: KeywordVerdictSource;
  readonly note: string | null;
  readonly decidedAt: number;
  readonly updatedAt: number;
}

/** Raw column shape returned by `SELECT * FROM appstore_keyword_verdicts`. */
interface KeywordVerdictDbRow {
  readonly keyword: string;
  readonly verdict: string;
  readonly source: string;
  readonly note: string | null;
  readonly decided_at: number | string;
  readonly updated_at: number | string;
}

function rowToVerdict(row: KeywordVerdictDbRow): KeywordVerdictRecord {
  return {
    keyword: row.keyword,
    verdict: row.verdict as KeywordVerdict,
    source: row.source as KeywordVerdictSource,
    note: row.note,
    decidedAt: Number(row.decided_at),
    updatedAt: Number(row.updated_at),
  };
}

export interface UpsertKeywordVerdictInput {
  readonly keyword: string;
  readonly verdict: KeywordVerdict;
  readonly source: KeywordVerdictSource;
  readonly note?: string | null;
}

/**
 * Record (or replace) a keyword's verdict from a given `source`. Upserts on
 * the `(keyword, source)` composite key — a human and a pipeline verdict for
 * the same keyword are independent rows, but a SECOND human verdict for the
 * same keyword overwrites the first (the latest human call wins).
 */
export async function upsertKeywordVerdict(
  input: UpsertKeywordVerdictInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<KeywordVerdictRecord> {
  const db = getDb();
  const rows = await db`
    INSERT INTO appstore_keyword_verdicts (keyword, verdict, source, note, decided_at, updated_at)
    VALUES (${input.keyword}, ${input.verdict}, ${input.source}, ${input.note ?? null}, ${now}, ${now})
    ON CONFLICT (keyword, source) DO UPDATE SET
      verdict = EXCLUDED.verdict,
      note = EXCLUDED.note,
      decided_at = EXCLUDED.decided_at,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;
  const row = (rows as KeywordVerdictDbRow[])[0];
  if (!row) throw new Error(`Failed to save keyword verdict: ${input.keyword}`);
  return rowToVerdict(row);
}

/**
 * Remove a keyword's verdict for one `source` (e.g. un-starring — the
 * dashboard's `DELETE /appstore/watchlist/:keyword`). Returns whether a row
 * was actually deleted.
 */
export async function deleteKeywordVerdict(
  keyword: string,
  source: KeywordVerdictSource,
): Promise<boolean> {
  const db = getDb();
  const rows = await db`
    DELETE FROM appstore_keyword_verdicts
    WHERE keyword = ${keyword} AND source = ${source}
    RETURNING keyword
  `;
  return (rows as ReadonlyArray<{ keyword: string }>).length > 0;
}

/**
 * Server-side watchlist — every `source: "human"` `"starred"` keyword,
 * newest-decided-first. Backs `GET /appstore/watchlist` and
 * `collectKeywordGaps`'s automatic starred-priority pull (Batch F, F5 leg 3).
 */
export async function getStarredKeywords(limit: number): Promise<readonly string[]> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keyword_verdicts
    WHERE verdict = 'starred' AND source = 'human'
    ORDER BY decided_at DESC
    LIMIT ${limit}
  `;
  return (rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword);
}

/**
 * HARD-exclude set for `collectKeywordGaps`: keywords a HUMAN explicitly
 * dismissed or killed. Never includes `source: "pipeline"` rows — those are
 * a softer signal (see `getDownweightedKeywords`).
 */
export async function getExcludedKeywords(): Promise<ReadonlySet<string>> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keyword_verdicts
    WHERE source = 'human' AND verdict IN ('dismissed', 'killed')
  `;
  return new Set((rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword));
}

/**
 * SOFT-downweight set for `collectKeywordGaps`: keywords a PIPELINE source
 * (the screener's "velocity alert is noise" dismissal — see
 * `appstore-signature-hits.ts`) flagged `dismissed`. These stay ELIGIBLE as
 * seeds — only ranked lower — deliberately distinct from a human dismissal's
 * hard exclude (see this module's doc comment).
 */
export async function getDownweightedKeywords(): Promise<ReadonlySet<string>> {
  const db = getDb();
  const rows = await db`
    SELECT keyword FROM appstore_keyword_verdicts
    WHERE source = 'pipeline' AND verdict = 'dismissed'
  `;
  return new Set((rows as ReadonlyArray<{ keyword: string }>).map((r) => r.keyword));
}

/**
 * All verdict rows for a batch of keywords — backs UI verdict badges (one
 * keyword may carry both a human AND a pipeline verdict). Returns a map from
 * keyword to its verdict rows (0, 1, or 2 entries per keyword).
 */
export async function getKeywordVerdicts(
  keywords: readonly string[],
): Promise<ReadonlyMap<string, readonly KeywordVerdictRecord[]>> {
  if (keywords.length === 0) return new Map();
  const db = getDb();
  const rows = await db`
    SELECT * FROM appstore_keyword_verdicts WHERE keyword IN ${db(keywords)}
  `;
  const byKeyword = new Map<string, KeywordVerdictRecord[]>();
  for (const row of rows as KeywordVerdictDbRow[]) {
    const verdict = rowToVerdict(row);
    const existing = byKeyword.get(verdict.keyword) ?? [];
    existing.push(verdict);
    byKeyword.set(verdict.keyword, existing);
  }
  return byKeyword;
}
