// hint-probe-store.ts — persistence for the autocomplete PROBE LEDGER
// (`appstore_autocomplete_probes`, migration 057): what we ASKED Apple, as
// opposed to `appstore_autocomplete_hints`, which records only what Apple
// ANSWERED.
//
// Deliberately its own module rather than more surface on `keyword-store.ts`
// (already ~2.5k lines): the ledger is a self-contained concern with one
// writer (`keyword-autocomplete.ts` / `hint-probe-pass.ts`) and one reader
// contract (`hint-coverage.ts`'s tri-state). Same house conventions as
// `keyword-store.ts` — `Bun.sql` tagged templates via `getDb()`, an explicit
// `XRow` -> `rowToX()` -> `readonly` domain split, and no mutation of inputs.

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import type { ProbeCandidate } from "./hint-coverage";

const logger = createLogger("appstore:hint-probe-store");

/**
 * `SMALLINT` ceiling for the two count-ish columns. Apple returns ~10
 * suggestions, so this is never reached in practice — it exists so a spoofed
 * or pathological upstream response can't overflow the column and fail the
 * INSERT (which would lose the probe record entirely, silently regressing the
 * keyword to `never-probed`).
 */
const SMALLINT_MAX = 32_767;

function clampSmallint(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.trunc(value), SMALLINT_MAX));
}

/** One probe observation to persist — see migration 057 for column semantics. */
export interface HintProbeWrite {
  /** The EXACT query string sent to Apple (bare seed, `"<seed> <letter>"` fan-out, or a direct corpus-keyword probe). */
  readonly query: string;
  /** Lowercase storefront cc — `"us"` / `"gb"`, matching `appstore_autocomplete_hints.storefront`. */
  readonly storefront: string;
  readonly probedAt: number;
  /** Did Apple return at least one RAW (pre-junk-filter) suggestion? */
  readonly returnedAny: boolean;
  /** How many raw suggestions came back. */
  readonly termCount: number;
  /** 0-based rank at which the query itself appeared in its own results, or `null`. */
  readonly selfRank: number | null;
}

/** A persisted probe record — the `probed-absent` leg of the tri-state. */
export interface HintProbeRecord {
  readonly query: string;
  readonly storefront: string;
  readonly firstProbedAt: number;
  readonly lastProbedAt: number;
  readonly probeCount: number;
  readonly returnedAny: boolean;
  readonly termCount: number;
  readonly selfRank: number | null;
}

interface HintProbeRow {
  readonly query: string;
  readonly storefront: string;
  readonly first_probed_at: number | string;
  readonly last_probed_at: number | string;
  readonly probe_count: number | string;
  readonly returned_any: boolean;
  readonly term_count: number | string;
  readonly self_rank: number | string | null;
}

function rowToHintProbeRecord(row: HintProbeRow): HintProbeRecord {
  return {
    query: row.query,
    storefront: row.storefront,
    firstProbedAt: Number(row.first_probed_at),
    lastProbedAt: Number(row.last_probed_at),
    probeCount: Number(row.probe_count),
    returnedAny: row.returned_any,
    termCount: Number(row.term_count),
    selfRank: row.self_rank === null ? null : Number(row.self_rank),
  };
}

/**
 * Upserts one row per probe observation.
 *
 * Latest-wins on `returned_any` / `term_count` / `self_rank` (a consumer
 * wants the CURRENT state of the signal), while `first_probed_at` is
 * preserved via `LEAST` and `probe_count` accumulates, so re-probing never
 * erases the fact that the query has a history. `LEAST` rather than "keep the
 * existing value" so an out-of-order write (a pass that started earlier but
 * committed later) can still correct `first_probed_at` downward.
 *
 * CALLERS MUST NOT record a FAILED fetch. A non-OK status, timeout or
 * rate-limit exhaustion means we learned nothing; writing a row for it would
 * manufacture a fake "Apple returned nothing" and poison every downstream
 * absence decision. See `keyword-autocomplete.ts`'s `HintFetchOutcome`, which
 * makes that distinction unrepresentable-by-accident at the type level.
 *
 * Blank queries are dropped rather than persisted under an empty key.
 */
export async function recordHintProbes(rows: readonly HintProbeWrite[]): Promise<void> {
  const writable = rows.filter((r) => r.query.trim().length > 0);
  if (writable.length === 0) return;
  const db = getDb();
  for (const row of writable) {
    await db`
      INSERT INTO appstore_autocomplete_probes (
        query, storefront, first_probed_at, last_probed_at, probe_count,
        returned_any, term_count, self_rank
      )
      VALUES (
        ${row.query}, ${row.storefront}, ${row.probedAt}, ${row.probedAt}, 1,
        ${row.returnedAny}, ${clampSmallint(row.termCount)},
        ${row.selfRank === null ? null : clampSmallint(row.selfRank)}
      )
      ON CONFLICT (query, storefront) DO UPDATE SET
        first_probed_at = LEAST(appstore_autocomplete_probes.first_probed_at, EXCLUDED.first_probed_at),
        last_probed_at = GREATEST(appstore_autocomplete_probes.last_probed_at, EXCLUDED.last_probed_at),
        probe_count = appstore_autocomplete_probes.probe_count + 1,
        returned_any = EXCLUDED.returned_any,
        term_count = EXCLUDED.term_count,
        self_rank = EXCLUDED.self_rank
    `;
  }
}

/**
 * Probe records for `queries` in one storefront, keyed by query string.
 * A missing key is precisely the `never-probed` leg of the tri-state — see
 * `hint-coverage.ts`'s `resolveHintCoverage`.
 */
export async function getHintProbeRecords(
  queries: readonly string[],
  storefront: string = "us",
): Promise<ReadonlyMap<string, HintProbeRecord>> {
  const deduped = [...new Set(queries.filter((q) => q.trim().length > 0))];
  if (deduped.length === 0) return new Map();
  const db = getDb();
  const rows = await db`
    SELECT query, storefront, first_probed_at, last_probed_at, probe_count,
           returned_any, term_count, self_rank
    FROM appstore_autocomplete_probes
    WHERE storefront = ${storefront}
      AND query = ANY(${db.array(deduped, "text")})
  `;
  return new Map(
    (rows as readonly HintProbeRow[]).map((row) => [row.query, rowToHintProbeRecord(row)]),
  );
}

/**
 * The most recent DIRECT probe of each keyword across ALL storefronts, keyed
 * by keyword — `MAX(last_probed_at)`.
 *
 * Storefront-agnostic on purpose: this backs `keyword-store.ts`'s
 * `getHintEvidence`, which itself aggregates hint presence across storefronts
 * (it reports `storefrontCount` as corroboration rather than scoping to one
 * market). "Has anyone asked Apple about this exact phrase anywhere" is the
 * matching question at that granularity. Callers that need per-market
 * semantics — the probe lane's own cadence decisions — use
 * `getHintProbeRecords` / `getDirectProbeCandidates` instead, which are
 * storefront-scoped.
 *
 * A missing key is the `never-probed` leg of the tri-state.
 */
export async function getLastProbedAt(
  queries: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const deduped = [...new Set(queries.filter((q) => q.trim().length > 0))];
  if (deduped.length === 0) return new Map();
  const db = getDb();
  const rows = await db`
    SELECT query, MAX(last_probed_at) AS last_probed_at
    FROM appstore_autocomplete_probes
    WHERE query = ANY(${db.array(deduped, "text")})
    GROUP BY query
  `;
  return new Map(
    (rows as ReadonlyArray<{ query: string; last_probed_at: number | string }>).map((row) => [
      row.query,
      Number(row.last_probed_at),
    ]),
  );
}

/**
 * Statement timeout for `getDirectProbeCandidates`. Mirrors
 * `keyword-store.ts`'s `HEAVY_QUERY_STATEMENT_TIMEOUT_MS` treatment of the
 * other corpus-wide selection queries: this one scans the non-mined corpus
 * plus a `DISTINCT keyword` slice of `appstore_keyword_scans`, and a lane that
 * cannot select work must degrade to "no work this pass", never wedge the
 * shared auxiliary-lanes tick.
 */
const CANDIDATE_QUERY_STATEMENT_TIMEOUT_MS = 30_000;

export interface DirectProbeCandidateOptions {
  /** Lowercase storefront cc whose probe ledger decides staleness. */
  readonly market: string;
  /** Row cap. Kept modest — this is the SQL-side bound; the pass applies its own request cap on top. */
  readonly limit: number;
  /** Keywords last probed before this epoch-second are eligible for a re-probe. */
  readonly reprobeBefore: number;
  /** Minimum `opportunity` a past scan must have reached for a `mined` keyword to be worth a probe. */
  readonly opportunityFloor: number;
  /** Only scans at or after this epoch-second count toward `opportunityFloor`. */
  readonly opportunitySince: number;
}

/**
 * Selects the corpus keywords most worth spending a direct autocomplete probe
 * on, never-probed and decision-relevant first.
 *
 * WHICH KEYWORDS. Probing all 95k active corpus keywords would be both
 * wasteful and pointless: measured 2026-07-26, 77,701 of them (81%) are
 * `source = 'mined'` — app-title n-gram fragments, most of which are not
 * phrases a human would ever type. So the eligible pool is:
 *   - every ACTIVE non-mined keyword (seed / manual / autocomplete / review —
 *     17,869 rows), i.e. the keywords the scanner actually reasons about; plus
 *   - every ACTIVE mined keyword that has EVER posted a scan at or above
 *     `opportunityFloor` in the lookback window. This clause is not a
 *     rounding error: of the 1,362 keywords that ever scored >= 0.35,
 *     1,030 are mined. The high scorers live in the mined pool, and they are
 *     exactly the keywords a decision gets made about.
 * That is ~19k keywords — a pool a modest per-pass cap can fully cover in
 * days and then keep fresh on a re-probe cadence.
 *
 * ORDERING. Decision-relevant (ever cleared the floor) first, then
 * never-probed before due-for-re-probe, then stalest, then oldest-discovered
 * as a deterministic tiebreak. The pure `selectProbeTargets`
 * (`hint-coverage.ts`) applies the final staleness filter and request cap on
 * top, so the cadence policy stays unit-testable without a DB.
 *
 * Degrades to `[]` (logged) on statement timeout rather than throwing — the
 * caller's pass must survive a slow DB.
 */
export async function getDirectProbeCandidates(
  opts: DirectProbeCandidateOptions,
): Promise<readonly ProbeCandidate[]> {
  if (opts.limit <= 0) return [];
  const db = getDb();
  let rows: unknown;
  try {
    rows = await db.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${CANDIDATE_QUERY_STATEMENT_TIMEOUT_MS}`);
      return await tx`
        WITH scored AS (
          SELECT DISTINCT keyword
          FROM appstore_keyword_scans
          WHERE store = 'app'
            AND opportunity >= ${opts.opportunityFloor}
            AND scanned_at >= ${opts.opportunitySince}
        )
        SELECT k.keyword, p.last_probed_at
        FROM appstore_keywords k
        LEFT JOIN scored s ON s.keyword = k.keyword
        LEFT JOIN appstore_autocomplete_probes p
          ON p.query = k.keyword AND p.storefront = ${opts.market}
        WHERE k.active = TRUE
          AND (k.source <> 'mined' OR s.keyword IS NOT NULL)
          AND (p.last_probed_at IS NULL OR p.last_probed_at < ${opts.reprobeBefore})
        ORDER BY
          (s.keyword IS NOT NULL) DESC,
          (p.last_probed_at IS NULL) DESC,
          p.last_probed_at ASC NULLS FIRST,
          k.created_at ASC
        LIMIT ${opts.limit}
      `;
    });
  } catch (err) {
    logger.warn("getDirectProbeCandidates failed, degrading to no probe targets", {
      timeoutMs: CANDIDATE_QUERY_STATEMENT_TIMEOUT_MS,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  return (
    rows as ReadonlyArray<{ keyword: string; last_probed_at: number | string | null }>
  ).map((row) => ({
    keyword: row.keyword,
    lastProbedAt: row.last_probed_at === null ? null : Number(row.last_probed_at),
  }));
}

/** Coverage counters for one storefront — see `countHintProbes`. */
export interface HintProbeCounts {
  readonly total: number;
  /** Probes whose most recent observation had Apple returning at least one suggestion. */
  readonly returnedAny: number;
  /** Probes where Apple suggested the exact probed phrase back (`self_rank IS NOT NULL`). */
  readonly selfSuggested: number;
}

/**
 * Ledger size for one storefront. Logged per pass so the backfill's progress
 * is visible from the logs alone — `total` climbing toward the eligible-pool
 * size is the only honest post-deploy proof that coverage is actually growing.
 */
export async function countHintProbes(storefront: string = "us"): Promise<HintProbeCounts> {
  const db = getDb();
  const rows = await db`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE returned_any) AS returned_any,
      COUNT(*) FILTER (WHERE self_rank IS NOT NULL) AS self_suggested
    FROM appstore_autocomplete_probes
    WHERE storefront = ${storefront}
  `;
  const row = (
    rows as ReadonlyArray<{
      total: number | string;
      returned_any: number | string;
      self_suggested: number | string;
    }>
  )[0];
  return {
    total: row === undefined ? 0 : Number(row.total),
    returnedAny: row === undefined ? 0 : Number(row.returned_any),
    selfSuggested: row === undefined ? 0 : Number(row.self_suggested),
  };
}
