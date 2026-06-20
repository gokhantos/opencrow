/**
 * Standalone entry point for the SIGE continuous ingestion process.
 *
 * Runs on a 5-minute timer and incrementally ingests project data
 * (app reviews, Reddit posts, HN stories, PH products, apps)
 * into the Mem0 knowledge graph via the Mem0 REST API.
 *
 * Cursor positions are persisted in config_overrides so each run
 * picks up exactly where the previous one stopped.
 *
 * Quality / cost controls (configured via constants + runtime overrides):
 *  - MIN_CONTENT_LENGTH: minimum chars after trim (default 40)
 *  - CREDIBILITY_FLOOR: minimum credibility score (default 0.25)
 *  - ALPHA_RATIO_MIN: minimum alphabetic-char ratio in non-space chars (default 0.45)
 *  - Review-sentiment filter: drops short pure-positive reviews with no negative signal
 *  - Exact-dup dedup backed by sige_ingest_dedup table (SHA-256 of normalised text)
 *  - Daily budget cap: maxRecordsPerDay (default 3000, tunable via config_overrides)
 *
 * Cursor design (Bug 2 fix):
 *  Cursors are composite: { ts: number, id: string } where `ts` is indexed_at
 *  (Unix epoch seconds) and `id` is the source-table primary key. Rows are
 *  fetched with a tie-safe predicate:
 *    WHERE (indexed_at > ts) OR (indexed_at = ts AND id > lastId)
 *  ordered by indexed_at DESC, id DESC (freshest-first — Bug 3 fix).
 *  On first run or when the stored cursor is in the old string format, the
 *  high-water mark is initialised to MAX(indexed_at) for that source (skip
 *  pre-existing backlog) and the fact is logged.
 *
 * Re-entrancy (Bug 1 fix):
 *  A single boolean guard prevents overlapping cycles. The timer uses
 *  run-then-reschedule (setTimeout after resolution) so the gap between
 *  cycles is POLL_INTERVAL_MS regardless of cycle duration.
 *
 * Usage:
 *   bun src/entries/sige-ingestion.ts
 */

import { createHash } from "node:crypto";

import { loadConfig, loadConfigWithOverrides } from "../config/loader";
import { bootstrap } from "../process/bootstrap";
import { Mem0Client } from "../sige/knowledge/mem0-client";
import { getOverride, setOverride } from "../store/config-overrides";
import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("sige-ingestion");

// ─── Constants ────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const BATCH_SIZE = 20;
const CURSOR_NAMESPACE = "sige-ingestion";

/** Minimum trimmed content length to pass the quality gate. */
export const MIN_CONTENT_LENGTH = 40;

/**
 * Minimum credibility score.  Reviews are always ≥0.5 so they are unaffected;
 * this only drops low-engagement Reddit / HN / PH rows.
 */
export const CREDIBILITY_FLOOR = 0.25;

/**
 * Minimum fraction of characters (out of non-space chars) that must be
 * alphabetic.  Catches emoji-/punctuation-only strings like "🥰🥰🥰".
 */
export const ALPHA_RATIO_MIN = 0.45;

/** Default daily budget — how many records may be ingested per calendar day. */
const DEFAULT_MAX_RECORDS_PER_DAY = 3_000;

/** config_overrides key for the tunable daily cap. */
const DAILY_CAP_OVERRIDE_KEY = "maxRecordsPerDay";

// ─── Source Row Types ─────────────────────────────────────────────────────────

interface AppStoreReviewRow {
  readonly id: string;
  readonly app_name: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly rating: number;
  readonly indexed_at: number | null;
}

interface PlayStoreReviewRow {
  readonly id: string;
  readonly app_name: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly rating: number;
  readonly thumbs_up: number | null;
  readonly indexed_at: number | null;
}

interface RedditPostRow {
  readonly id: string;
  readonly subreddit: string;
  readonly title: string;
  readonly selftext: string | null;
  readonly score: number;
  readonly num_comments: number;
  readonly indexed_at: number | null;
}

interface PhProductRow {
  readonly id: string;
  readonly name: string;
  readonly tagline: string | null;
  readonly description: string | null;
  readonly votes_count: number;
  readonly indexed_at: number | null;
}

interface HnStoryRow {
  readonly id: string;
  readonly title: string;
  readonly points: number;
  readonly comment_count: number;
  readonly description: string | null;
  readonly indexed_at: number | null;
}

interface AppStoreAppRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
  readonly indexed_at: number | null;
}

interface PlayStoreAppRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
  readonly rating: number | null;
  readonly installs: string | null;
  readonly indexed_at: number | null;
}

// ─── Credibility Heuristics ───────────────────────────────────────────────────

/**
 * Per-source credibility signals passed to computeCredibility.
 *
 * Only include the fields that are meaningful for a given source; all are
 * optional so callers can pass a minimal object and the heuristic degrades
 * gracefully to a source-type floor.
 */
export interface CredibilityInputs {
  /** Source type string — used to select the right heuristic. */
  readonly source_type: string;
  /**
   * App-store/Play-store star rating (1–5).
   * Extreme ratings (1★ or 5★) carry higher signal than mid-range.
   */
  readonly rating?: number;
  /**
   * Play Store "thumbs-up" count on a review.
   * More upvotes → higher credibility, soft-capped at 100.
   */
  readonly thumbs_up?: number;
  /**
   * Reddit score (upvotes − downvotes). High positive scores indicate
   * community-validated content; capped at 500 for normalisation.
   */
  readonly score?: number;
  /**
   * Comment count (Reddit / HN). Engagement signals relevance.
   * Soft-capped at 200.
   */
  readonly num_comments?: number;
  /**
   * Product Hunt / HN points. Soft-capped at 500.
   */
  readonly points?: number;
  /**
   * Play Store install count string (e.g. "1,000,000+").
   * Higher installs → app is well-established → metadata is trustworthy.
   */
  readonly installs?: string | null;
  /**
   * App / Play Store numeric rating (1–5) for app-listing rows.
   * We reuse the `rating` field; documented here for clarity.
   */
}

/**
 * Parse a Play Store installs string ("1,000,000+", "500K+", etc.) into a
 * raw number. Returns 0 on parse failure so the heuristic degrades safely.
 */
function parseInstalls(installs: string | null | undefined): number {
  if (!installs) return 0;
  // Remove commas, "+" suffix, and normalise K/M shorthand
  const clean = installs.replace(/,/g, "").replace(/\+$/, "").trim().toUpperCase();
  if (clean.endsWith("M")) return Number.parseFloat(clean) * 1_000_000;
  if (clean.endsWith("K")) return Number.parseFloat(clean) * 1_000;
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Clamp a value to [0, 1].
 */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute a credibility score in [0, 1] for a piece of ingested content.
 *
 * The goal is to give the graph agent a cheap, deterministic signal about how
 * much to weight a memory relative to others from the same project. It is NOT
 * meant to be a full quality classifier — just a sensible ordering proxy.
 *
 * Heuristics (all clamped to [0, 1]):
 *
 * - appstore_review / playstore_review
 *     Floor 0.5 (it is a verified purchase, not anonymous noise).
 *     Extreme ratings (1★, 2★ or 5★) are higher signal than mid-range
 *     because the ingestion gate already filters to ≤2★, so we amplify by
 *     proximity to 1★.  A 1★ review ⇒ 1.0, a 2★ ⇒ 0.75.
 *     For Play Store: thumbs_up count adds up to +0.2 (capped at 100 upvotes).
 *
 * - reddit_post
 *     Score and engagement both contribute.  Score/500 (soft cap) contributes
 *     up to 0.6; num_comments/200 contributes up to 0.4.  Floor 0.15.
 *
 * - producthunt
 *     votes_count/500 (soft cap) contributes up to 0.8.  Floor 0.2.
 *
 * - hackernews
 *     points/500 (soft cap) contributes up to 0.7; num_comments/200 up to
 *     0.3.  Floor 0.2.
 *
 * - news_article
 *     Fixed 0.6 — editorial content is generally credible but varies by
 *     source; we do not have a source-rank list, so a mid-high floor is
 *     appropriate.
 *
 * - appstore_app / playstore_app
 *     App listings are factual (name, category, description).
 *     For Play Store apps: installs parsed to a count drives up to 0.8 (soft
 *     cap 10M+); app rating drives up to 0.2 (5★ max).  Floor 0.3.
 *     For App Store apps: fixed 0.5 (no install count available).
 */
export function computeCredibility(inputs: CredibilityInputs): number {
  const { source_type } = inputs;

  switch (source_type) {
    case "appstore_review": {
      // 1★ → 1.0, 2★ → 0.75, 3★ → 0.5, higher → 0.5 floor
      const rating = inputs.rating ?? 3;
      const ratingScore = rating <= 1 ? 1.0 : rating <= 2 ? 0.75 : 0.5;
      return clamp01(ratingScore);
    }

    case "playstore_review": {
      // Same star heuristic as App Store, plus thumbs_up bonus.
      const rating = inputs.rating ?? 3;
      const ratingScore = rating <= 1 ? 1.0 : rating <= 2 ? 0.75 : 0.5;
      const thumbsBonus = Math.min((inputs.thumbs_up ?? 0) / 100, 1) * 0.2;
      return clamp01(ratingScore + thumbsBonus);
    }

    case "reddit_post": {
      const scoreComponent = Math.min(Math.max(inputs.score ?? 0, 0) / 500, 1) * 0.6;
      const engagementComponent = Math.min((inputs.num_comments ?? 0) / 200, 1) * 0.4;
      return clamp01(Math.max(0.15, scoreComponent + engagementComponent));
    }

    case "producthunt": {
      const pts = inputs.points ?? 0;
      // 0 → 0.2 floor; 500 → 0.8 (soft cap); 1000 → 1.0 (hard cap).
      const base = Math.min(pts / 500, 1) * 0.8;
      const bonus = pts > 500 ? Math.min((pts - 500) / 500, 1) * 0.2 : 0;
      return clamp01(Math.max(0.2, base + bonus));
    }

    case "hackernews": {
      const pointsComponent = Math.min(Math.max(inputs.points ?? 0, 0) / 500, 1) * 0.7;
      const engagementComponent = Math.min((inputs.num_comments ?? 0) / 200, 1) * 0.3;
      return clamp01(Math.max(0.2, pointsComponent + engagementComponent));
    }

    case "news_article": {
      // Editorial content — mid-high fixed floor; no per-row signal available.
      return 0.6;
    }

    case "appstore_app": {
      // Factual listing with no install/rating signal; conservative mid-point.
      return 0.5;
    }

    case "playstore_app": {
      // Installs are the strongest signal; app rating contributes a small bonus.
      const installCount = parseInstalls(inputs.installs);
      const installsComponent = Math.min(installCount / 10_000_000, 1) * 0.8;
      const ratingComponent = Math.min((inputs.rating ?? 0) / 5, 1) * 0.2;
      return clamp01(Math.max(0.3, installsComponent + ratingComponent));
    }

    default: {
      // Unknown source type — conservative default.
      return 0.4;
    }
  }
}

// ─── Quality Gate ─────────────────────────────────────────────────────────────

/**
 * Positive-sentiment lexicon for the review sentiment filter.
 * Matches whole words (or common emoji) case-insensitively.
 */
const POSITIVE_REVIEW_PATTERN =
  /great|love|excellent|perfect|awesome|amazing|best|wonderful|👍|🥰|❤|😍|good/i;

/**
 * Negative-token guard: presence of ANY of these overrides the positive
 * match and lets the review through (real complaint, keep it).
 *
 * Uses a word-start boundary (\b prefix) but no word-end boundary so that
 * inflected forms are caught ("crashing" → "crash", "failing" → "fail", etc.).
 */
const NEGATIVE_REVIEW_PATTERN =
  /\b(?:not|no|never|bad|crash|broken|worst|terrible|hate|bug|error|doesn't|won't|can't|fail|slow|annoying|scam|useless)/i;

/**
 * Maximum length (chars) at which the short-positive-review filter applies.
 * Longer positive reviews are let through — they likely contain context.
 */
const REVIEW_SENTIMENT_MAX_LEN = 60;

export interface QualityGateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Pure quality gate — no side effects, no DB.
 *
 * Returns `{ ok: false, reason }` when the content should be dropped;
 * `{ ok: true }` when it should proceed to dedup + mem0.
 *
 * Rejection criteria (in order):
 * 1. Content too short (< MIN_CONTENT_LENGTH).
 * 2. Alpha-ratio too low (emoji/punctuation spam).
 * 3. Credibility below floor (zero-engagement community content).
 * 4. Short positive-only review (sourceType is appstore_review / playstore_review,
 *    content ≤ REVIEW_SENTIMENT_MAX_LEN, matches positive lexicon, no negative tokens).
 */
export function passesQualityGate(
  content: string,
  sourceType: string,
  credibility: number,
): QualityGateResult {
  const trimmed = content.trim();

  // 1. Length check
  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return { ok: false, reason: "content_too_short" };
  }

  // 2. Alphabetic-ratio check
  const nonSpace = trimmed.replace(/\s+/g, "");
  if (nonSpace.length > 0) {
    const alphaCount = (nonSpace.match(/[a-zA-Z]/g) ?? []).length;
    const ratio = alphaCount / nonSpace.length;
    if (ratio < ALPHA_RATIO_MIN) {
      return { ok: false, reason: "alpha_ratio_too_low" };
    }
  }

  // 3. Credibility floor
  if (credibility < CREDIBILITY_FLOOR) {
    return { ok: false, reason: "credibility_below_floor" };
  }

  // 4. Short positive-only review sentiment filter (review sources only)
  if (sourceType === "appstore_review" || sourceType === "playstore_review") {
    if (
      trimmed.length <= REVIEW_SENTIMENT_MAX_LEN &&
      POSITIVE_REVIEW_PATTERN.test(trimmed) &&
      !NEGATIVE_REVIEW_PATTERN.test(trimmed)
    ) {
      return { ok: false, reason: "short_positive_review_no_complaint" };
    }
  }

  return { ok: true };
}

// ─── Dedup ────────────────────────────────────────────────────────────────────

/**
 * Normalise content for dedup hashing:
 * lowercase → collapse non-alphanumeric runs → trim.
 * This makes minor whitespace and punctuation variants collide to the same hash.
 */
export function normaliseForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Compute a stable SHA-256 hex hash of normalised content.
 */
export function contentHash(text: string): string {
  return createHash("sha256").update(normaliseForHash(text)).digest("hex");
}

/**
 * Check whether a content hash already exists in sige_ingest_dedup.
 * Returns true if this is a duplicate (should be dropped).
 */
async function isDuplicate(hash: string): Promise<boolean> {
  const db = getDb();
  const rows = await db`
    SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${hash} LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Record a content hash in sige_ingest_dedup.
 * ON CONFLICT DO NOTHING — safe to call even if somehow inserted twice.
 */
async function recordHash(hash: string, source: string): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO sige_ingest_dedup (content_hash, source)
    VALUES (${hash}, ${source})
    ON CONFLICT (content_hash) DO NOTHING
  `;
}

// ─── Daily Budget Cap ─────────────────────────────────────────────────────────

/**
 * Return today's UTC date as "YYYY-MM-DD".
 */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * config_overrides key for today's ingested count.
 */
export function dailyCountKey(date: string): string {
  return `ingested:${date}`;
}

/**
 * Read the tunable daily cap from config_overrides, falling back to DEFAULT.
 */
async function readDailyCap(): Promise<number> {
  const override = await getOverride(CURSOR_NAMESPACE, DAILY_CAP_OVERRIDE_KEY);
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_MAX_RECORDS_PER_DAY;
}

/**
 * Read today's ingested count from config_overrides.
 */
async function readDailyCount(date: string): Promise<number> {
  const stored = await getOverride(CURSOR_NAMESPACE, dailyCountKey(date));
  if (typeof stored === "number" && Number.isFinite(stored)) return Math.floor(stored);
  return 0;
}

/**
 * Persist today's running ingested count.
 */
async function writeDailyCount(date: string, count: number): Promise<void> {
  await setOverride(CURSOR_NAMESPACE, dailyCountKey(date), count);
}

// ─── Composite Cursor ─────────────────────────────────────────────────────────

/**
 * High-water mark cursor: tracks the newest indexed_at + id processed.
 *
 * `ts`  — Unix epoch seconds (indexed_at of the last row processed in
 *          descending order, i.e. the HIGHEST ts seen so far).
 * `id`  — primary key of the last row processed within that ts bucket.
 *
 * Query predicate (freshest-first, tie-safe):
 *   WHERE (indexed_at > ts) OR (indexed_at = ts AND id > lastId)
 *   ORDER BY indexed_at DESC, id DESC
 *
 * "Advance" means updating the cursor to the NEWEST row from the current
 * batch (first row returned, since rows are DESC). After the first batch the
 * high-water mark equals the batch's highest indexed_at/id, and subsequent
 * fetches pick up rows NEWER than that — so the cursor strictly advances.
 */
export interface CompositeCursor {
  readonly ts: number;
  readonly id: string;
}

/**
 * Serialise a composite cursor to a JSON string for storage in config_overrides.
 */
export function serializeCursor(cursor: CompositeCursor): string {
  return JSON.stringify({ ts: cursor.ts, id: cursor.id });
}

/**
 * Parse a stored cursor value.
 *
 * Returns the parsed composite cursor on success, or null when the stored
 * value is absent, in the legacy string format, or otherwise malformed.
 * The caller must treat null as "no cursor yet" and initialise from MAX(indexed_at).
 */
export function parseCursor(stored: unknown): CompositeCursor | null {
  if (stored === null || stored === undefined) return null;

  // Stored as a raw string (config_overrides returns the parsed JSON value)
  if (typeof stored === "string") {
    // Might be a legacy bare id string — treat as legacy
    try {
      const parsed: unknown = JSON.parse(stored);
      return validateCursorShape(parsed);
    } catch {
      // Not JSON — legacy format
      return null;
    }
  }

  // config_overrides JSON.parse already unwrapped the value for us
  if (typeof stored === "object") {
    return validateCursorShape(stored);
  }

  return null;
}

function validateCursorShape(value: unknown): CompositeCursor | null {
  if (
    value !== null &&
    typeof value === "object" &&
    "ts" in value &&
    "id" in value &&
    typeof (value as Record<string, unknown>)["ts"] === "number" &&
    typeof (value as Record<string, unknown>)["id"] === "string"
  ) {
    return {
      ts: (value as Record<string, unknown>)["ts"] as number,
      id: (value as Record<string, unknown>)["id"] as string,
    };
  }
  return null;
}

// ─── Source Definitions ───────────────────────────────────────────────────────

interface SourceDefinition<T extends { readonly id: string; readonly indexed_at: number | null }> {
  readonly name: string;
  readonly priority: number;
  /**
   * Fetch the next batch of rows NEWER than the composite cursor, ordered
   * freshest-first (indexed_at DESC, id DESC).
   * Rows with NULL indexed_at are excluded — they have no placement in the
   * time-ordered cursor.
   */
  fetchBatch(cursor: CompositeCursor, limit: number): Promise<readonly T[]>;
  /**
   * Return the maximum indexed_at for this source (used on first-run
   * high-water initialisation to skip pre-existing backlog).
   * Returns null if the table is empty or all rows have NULL indexed_at.
   */
  maxIndexedAt(): Promise<number | null>;
  toText(row: T): string;
  toMetadata(row: T): Record<string, unknown>;
  getContent(row: T): string;
}

function makeSource<T extends { readonly id: string; readonly indexed_at: number | null }>(
  def: SourceDefinition<T>,
): SourceDefinition<T> {
  return def;
}

const SOURCES: ReadonlyArray<
  SourceDefinition<{ readonly id: string; readonly indexed_at: number | null }>
> = [
  makeSource<AppStoreReviewRow>({
    name: "appstore_reviews",
    priority: 1,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, app_name, title, content, rating, indexed_at
        FROM appstore_reviews
        WHERE rating <= 2
          AND indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as AppStoreReviewRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM appstore_reviews WHERE rating <= 2
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      return `App Store complaint about "${r.app_name}": "${r.title ?? ""}" — ${r.content ?? ""}. Rating: ${r.rating}/5.`;
    },
    toMetadata(r) {
      return {
        source: "appstore_review",
        source_type: "appstore_review",
        app: r.app_name,
        rating: r.rating,
        credibility: computeCredibility({ source_type: "appstore_review", rating: r.rating }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.title ?? ""} ${r.content ?? ""}`;
    },
  }),

  makeSource<PlayStoreReviewRow>({
    name: "playstore_reviews",
    priority: 1,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, app_name, title, content, rating, thumbs_up, indexed_at
        FROM playstore_reviews
        WHERE rating <= 2
          AND indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as PlayStoreReviewRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM playstore_reviews WHERE rating <= 2
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      return `Play Store complaint about "${r.app_name}" (${r.thumbs_up ?? 0} upvotes): "${r.title ?? ""}" — ${r.content ?? ""}. Rating: ${r.rating}/5.`;
    },
    toMetadata(r) {
      return {
        source: "playstore_review",
        source_type: "playstore_review",
        app: r.app_name,
        rating: r.rating,
        credibility: computeCredibility({
          source_type: "playstore_review",
          rating: r.rating,
          thumbs_up: r.thumbs_up ?? 0,
        }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.title ?? ""} ${r.content ?? ""}`;
    },
  }),

  makeSource<RedditPostRow>({
    name: "reddit_posts",
    priority: 2,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, subreddit, title, selftext, score, num_comments, indexed_at
        FROM reddit_posts
        WHERE indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as RedditPostRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM reddit_posts
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      const body = (r.selftext ?? "").slice(0, 500);
      return `Reddit r/${r.subreddit} discussion (${r.score} upvotes, ${r.num_comments} comments): "${r.title}". ${body}`;
    },
    toMetadata(r) {
      return {
        source: "reddit",
        source_type: "reddit_post",
        subreddit: r.subreddit,
        score: r.score,
        credibility: computeCredibility({
          source_type: "reddit_post",
          score: r.score,
          num_comments: r.num_comments,
        }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.title} ${r.selftext ?? ""}`;
    },
  }),

  makeSource<PhProductRow>({
    name: "ph_products",
    priority: 2,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, name, tagline, description, votes_count, indexed_at
        FROM ph_products
        WHERE indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as PhProductRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM ph_products
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      const desc = (r.description ?? "").slice(0, 300);
      return `Product Hunt launch: "${r.name}" — ${r.tagline ?? ""}. ${r.votes_count} votes. ${desc}`;
    },
    toMetadata(r) {
      return {
        source: "producthunt",
        source_type: "producthunt",
        votes: r.votes_count,
        credibility: computeCredibility({ source_type: "producthunt", points: r.votes_count }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.name} ${r.tagline ?? ""} ${r.description ?? ""}`;
    },
  }),

  makeSource<HnStoryRow>({
    name: "hn_stories",
    priority: 2,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, title, points, comment_count, description, indexed_at
        FROM hn_stories
        WHERE indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as HnStoryRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM hn_stories
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      const desc = (r.description ?? "").slice(0, 300);
      return `Hacker News (${r.points} pts, ${r.comment_count} comments): "${r.title}". ${desc}`;
    },
    toMetadata(r) {
      return {
        source: "hackernews",
        source_type: "hackernews",
        points: r.points,
        credibility: computeCredibility({
          source_type: "hackernews",
          points: r.points,
          num_comments: r.comment_count,
        }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.title} ${r.description ?? ""}`;
    },
  }),

  makeSource<AppStoreAppRow>({
    name: "appstore_apps",
    priority: 3,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, name, category, description, indexed_at
        FROM appstore_apps
        WHERE indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as AppStoreAppRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM appstore_apps
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      const desc = (r.description ?? "").slice(0, 400);
      return `App Store app: "${r.name}" in ${r.category ?? "unknown category"}. ${desc}`;
    },
    toMetadata(r) {
      return {
        source: "appstore_app",
        source_type: "appstore_app",
        category: r.category,
        credibility: computeCredibility({ source_type: "appstore_app" }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.name} ${r.description ?? ""}`;
    },
  }),

  makeSource<PlayStoreAppRow>({
    name: "playstore_apps",
    priority: 3,
    async fetchBatch(cursor, limit) {
      const db = getDb();
      return (await db`
        SELECT id, name, category, description, rating, installs, indexed_at
        FROM playstore_apps
        WHERE indexed_at IS NOT NULL
          AND (indexed_at > ${cursor.ts} OR (indexed_at = ${cursor.ts} AND id > ${cursor.id}))
        ORDER BY indexed_at DESC, id DESC
        LIMIT ${limit}
      `) as PlayStoreAppRow[];
    },
    async maxIndexedAt() {
      const db = getDb();
      const rows = await db`
        SELECT MAX(indexed_at)::integer AS max_ts FROM playstore_apps
      `;
      const row = rows[0] as { max_ts: number | null } | undefined;
      return row?.max_ts ?? null;
    },
    toText(r) {
      const desc = (r.description ?? "").slice(0, 400);
      return `Play Store app: "${r.name}" in ${r.category ?? "unknown"}. Rating: ${r.rating ?? "N/A"}★, ${r.installs ?? "N/A"} installs. ${desc}`;
    },
    toMetadata(r) {
      return {
        source: "playstore_app",
        source_type: "playstore_app",
        category: r.category,
        rating: r.rating,
        credibility: computeCredibility({
          source_type: "playstore_app",
          installs: r.installs,
          rating: r.rating ?? undefined,
        }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.name} ${r.description ?? ""}`;
    },
  }),
] as ReadonlyArray<
  SourceDefinition<{ readonly id: string; readonly indexed_at: number | null }>
>;

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function cursorKey(sourceName: string): string {
  return `cursor:${sourceName}`;
}

/**
 * Read the composite cursor for a source.
 *
 * Returns the parsed cursor or null when:
 *  - No cursor stored yet (first run).
 *  - Stored value is in the legacy bare-string format.
 *  - Stored value is malformed JSON.
 *
 * The caller is responsible for initialising the cursor from MAX(indexed_at)
 * when null is returned.
 */
export async function readCursor(sourceName: string): Promise<CompositeCursor | null> {
  const stored = await getOverride(CURSOR_NAMESPACE, cursorKey(sourceName));
  return parseCursor(stored);
}

/**
 * Persist the composite cursor for a source.
 */
export async function writeCursor(sourceName: string, cursor: CompositeCursor): Promise<void> {
  await setOverride(CURSOR_NAMESPACE, cursorKey(sourceName), { ts: cursor.ts, id: cursor.id });
}

/**
 * Resolve the effective cursor for a source.
 *
 * When no valid cursor exists (first run or legacy format), initialises the
 * high-water mark to MAX(indexed_at) for that source so the backlog is
 * skipped and only new inflow is processed. Logs the initialisation clearly.
 *
 * Returns the resolved cursor. Also returns a flag indicating whether the
 * cursor was freshly initialised (used for per-source backlog-skip logging).
 */
async function resolveOrInitCursor(
  source: SourceDefinition<{ readonly id: string; readonly indexed_at: number | null }>,
): Promise<{ cursor: CompositeCursor; wasInitialised: boolean }> {
  const existing = await readCursor(source.name);
  if (existing !== null) {
    return { cursor: existing, wasInitialised: false };
  }

  // No valid cursor — initialise high-water from MAX(indexed_at).
  const maxTs = await source.maxIndexedAt();
  const initTs = maxTs ?? 0;

  // Count rows that will be skipped (pre-existing backlog).
  const db = getDb();
  const countRows = await db`
    SELECT COUNT(*)::integer AS n
    FROM ${db.unsafe(source.name)}
    WHERE indexed_at IS NOT NULL AND indexed_at <= ${initTs}
  `;
  const countRow = countRows[0] as { n: number } | undefined;
  const backlogCount = countRow?.n ?? 0;

  const initCursor: CompositeCursor = { ts: initTs, id: "" };

  log.info("Initialising high-water cursor — pre-existing backlog will be skipped", {
    source: source.name,
    high_water_ts: initTs,
    skipped_backlog_rows: backlogCount,
    reason: maxTs === null ? "table_empty_or_all_null_indexed_at" : "first_run_skip_backlog",
  });

  try {
    await writeCursor(source.name, initCursor);
  } catch (err) {
    log.warn("Failed to persist initial cursor — will re-initialise next cycle", {
      source: source.name,
      err,
    });
  }

  return { cursor: initCursor, wasInitialised: true };
}

// ─── Single-source ingestion ──────────────────────────────────────────────────

interface SourceRunResult {
  readonly sourceName: string;
  readonly fetched: number;
  readonly ingested: number;
  readonly droppedQuality: number;
  readonly droppedDup: number;
  readonly cappedRemaining: number;
  readonly caughtUp: boolean;
  /** Number of records where mem0.addMemory threw (content was valid but write failed). */
  readonly mem0Failures: number;
  /** True when the cursor was freshly initialised from MAX(indexed_at) this cycle. */
  readonly cursorInitialised: boolean;
}

interface DailyBudget {
  readonly date: string;
  readonly cap: number;
  /** Mutable running count — incremented in-place within the cycle. */
  count: number;
}

async function ingestSource(
  source: SourceDefinition<{ readonly id: string; readonly indexed_at: number | null }>,
  mem0: Mem0Client,
  userId: string,
  budget: DailyBudget,
): Promise<SourceRunResult> {
  const { cursor, wasInitialised } = await resolveOrInitCursor(source);

  let rows: ReadonlyArray<{ readonly id: string; readonly indexed_at: number | null }>;
  try {
    rows = await source.fetchBatch(cursor, BATCH_SIZE);
  } catch (err) {
    log.warn("Failed to fetch batch — skipping source this cycle", {
      source: source.name,
      err,
    });
    return {
      sourceName: source.name,
      fetched: 0,
      ingested: 0,
      droppedQuality: 0,
      droppedDup: 0,
      cappedRemaining: 0,
      caughtUp: false,
      mem0Failures: 0,
      cursorInitialised: wasInitialised,
    };
  }

  if (rows.length === 0) {
    return {
      sourceName: source.name,
      fetched: 0,
      ingested: 0,
      droppedQuality: 0,
      droppedDup: 0,
      cappedRemaining: 0,
      caughtUp: true,
      mem0Failures: 0,
      cursorInitialised: wasInitialised,
    };
  }

  let ingested = 0;
  let droppedQuality = 0;
  let droppedDup = 0;
  let cappedRemaining = 0;
  let mem0Failures = 0;

  // The newest high-water we've consumed this batch. We start from the existing
  // cursor and advance as we process rows. Since rows are ordered DESC, the
  // FIRST successfully processed row carries the highest indexed_at/id.
  // We track the cursor after each consumed row so we can persist the progress
  // even if capping kicks in mid-batch.
  let latestConsumedCursor: CompositeCursor = cursor;
  let cappedAt: string | null = null;

  for (const row of rows) {
    const rawContent = source.getContent(row).trim();
    const metadata = source.toMetadata(row);
    const sourceType = (metadata["source_type"] as string | undefined) ?? source.name;
    const credibility = (metadata["credibility"] as number | undefined) ?? 0;
    const rowTs = row.indexed_at ?? cursor.ts;

    // ── Quality gate ──────────────────────────────────────────────────────────
    const gate = passesQualityGate(rawContent, sourceType, credibility);
    if (!gate.ok) {
      droppedQuality++;
      // Advance high-water — this row is consumed, never re-evaluated.
      latestConsumedCursor = { ts: rowTs, id: row.id };
      continue;
    }

    // ── Exact-dup dedup ───────────────────────────────────────────────────────
    const hash = contentHash(rawContent);
    let dup = false;
    try {
      dup = await isDuplicate(hash);
    } catch (err) {
      // Dedup DB error is non-fatal — let the row through (safe side is to ingest).
      log.warn("Dedup check failed — treating row as non-duplicate", {
        source: source.name,
        id: row.id,
        err,
      });
    }

    if (dup) {
      droppedDup++;
      latestConsumedCursor = { ts: rowTs, id: row.id };
      continue;
    }

    // ── Daily budget cap ──────────────────────────────────────────────────────
    if (budget.count >= budget.cap || cappedAt !== null) {
      // Cap reached — stop consuming rows from this source. Cursor is NOT
      // advanced past this row; it will resume next cycle / next day.
      cappedRemaining++;
      if (cappedAt === null) cappedAt = row.id;
      continue;
    }

    // ── Ingest ────────────────────────────────────────────────────────────────
    const text = source.toText(row);
    try {
      await mem0.addMemory({ content: text, userId, metadata });
      // Record hash so future cycles skip this content.
      await recordHash(hash, source.name);
      ingested++;
      budget.count++;
      latestConsumedCursor = { ts: rowTs, id: row.id };
    } catch (err) {
      mem0Failures++;
      log.warn("Failed to ingest record — skipping", {
        source: source.name,
        id: row.id,
        err,
      });
      // Advance cursor past this row — do not retry forever.
      latestConsumedCursor = { ts: rowTs, id: row.id };
    }
  }

  // Persist cursor to the latest consumed position. Capped rows do NOT advance
  // latestConsumedCursor so they stay in the backlog and resume once the budget resets.
  // We only persist if we actually made progress.
  const movedForward =
    latestConsumedCursor.ts > cursor.ts ||
    (latestConsumedCursor.ts === cursor.ts && latestConsumedCursor.id > cursor.id);

  if (movedForward) {
    try {
      await writeCursor(source.name, latestConsumedCursor);
    } catch (err) {
      log.error("Failed to persist cursor — next run will re-process this batch", {
        source: source.name,
        latestConsumedCursor,
        err,
      });
    }
  }

  if (cappedAt !== null) {
    log.info("Daily cap reached — remaining rows held in backlog", {
      source: source.name,
      cappedRemaining,
      budgetUsed: budget.count,
      budgetCap: budget.cap,
    });
  }

  const caughtUp = cappedRemaining === 0 && rows.length < BATCH_SIZE;

  log.info("Source cycle progress", {
    source: source.name,
    high_water_ts: latestConsumedCursor.ts,
    high_water_id: latestConsumedCursor.id,
    fetched: rows.length,
    ingested,
    droppedQuality,
    droppedDup,
    cappedRemaining,
  });

  return {
    sourceName: source.name,
    fetched: rows.length,
    ingested,
    droppedQuality,
    droppedDup,
    cappedRemaining,
    caughtUp,
    mem0Failures,
    cursorInitialised: wasInitialised,
  };
}

// ─── One ingestion cycle ──────────────────────────────────────────────────────

async function runIngestionCycle(mem0: Mem0Client, userId: string): Promise<void> {
  log.info("Ingestion cycle started");

  // Read the daily cap and today's running count ONCE per cycle (not per row).
  const today = todayUtc();
  const [cap, countAtStart] = await Promise.all([readDailyCap(), readDailyCount(today)]);
  const budget: DailyBudget = { date: today, cap, count: countAtStart };

  // Sort by priority ascending so highest-signal sources are processed first
  const sorted = [...SOURCES].sort((a, b) => a.priority - b.priority);

  const results: SourceRunResult[] = [];

  for (const source of sorted) {
    // Short-circuit: if the budget is already exhausted, skip all remaining sources.
    if (budget.count >= budget.cap) {
      log.info("Daily cap exhausted — skipping remaining sources this cycle", {
        source: source.name,
        budgetUsed: budget.count,
        budgetCap: budget.cap,
      });
      break;
    }
    const result = await ingestSource(source, mem0, userId, budget);
    results.push(result);
  }

  // Persist the updated daily count once at the end of the cycle.
  if (budget.count !== countAtStart) {
    try {
      await writeDailyCount(today, budget.count);
    } catch (err) {
      log.warn("Failed to persist daily count — next cycle may re-count", { err });
    }
  }

  // Aggregate totals across all sources for quick at-a-glance observability
  const totalFetched = results.reduce((sum, r) => sum + r.fetched, 0);
  const totalIngested = results.reduce((sum, r) => sum + r.ingested, 0);
  const totalDroppedQuality = results.reduce((sum, r) => sum + r.droppedQuality, 0);
  const totalDroppedDup = results.reduce((sum, r) => sum + r.droppedDup, 0);
  const totalCappedRemaining = results.reduce((sum, r) => sum + r.cappedRemaining, 0);
  const totalMem0Failures = results.reduce((sum, r) => sum + r.mem0Failures, 0);

  // Per-source structured log — operators can grep by source name.
  for (const r of results) {
    log.info("Source cycle result", {
      source: r.sourceName,
      fetched: r.fetched,
      droppedQuality: r.droppedQuality,
      droppedDup: r.droppedDup,
      ingested: r.ingested,
      cappedRemaining: r.cappedRemaining,
      caughtUp: r.caughtUp,
      mem0Failures: r.mem0Failures,
      cursorInitialised: r.cursorInitialised,
    });
  }

  if (totalIngested === 0) {
    log.info("Ingestion cycle complete — nothing new this cycle", {
      totalFetched,
      totalIngested,
      totalDroppedQuality,
      totalDroppedDup,
      totalCappedRemaining,
      totalMem0Failures,
      dailyCount: budget.count,
      dailyCap: budget.cap,
    });
  } else {
    log.info("Ingestion cycle complete", {
      totalFetched,
      totalIngested,
      totalDroppedQuality,
      totalDroppedDup,
      totalCappedRemaining,
      totalMem0Failures,
      dailyCount: budget.count,
      dailyCap: budget.cap,
    });
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseConfig = loadConfig();
  await bootstrap({
    config: baseConfig,
    processName: "sige-ingestion",
    skipMemory: true,
    skipObservations: true,
    dbPoolSize: 3,
  });

  const config = await loadConfigWithOverrides();

  // Ingestion is INDEPENDENT of the SIGE idea engine (config.sige.enabled). It
  // only needs the sige.mem0 connection, so it runs to keep the corpus fresh
  // whether or not the (manual-only) idea engine is enabled. Exit only when there
  // is no sige section at all (no mem0 creds) or ingestion is explicitly disabled.
  if (config.sige === undefined || config.sige.ingestion?.enabled === false) {
    log.info("SIGE ingestion disabled or unconfigured — exiting");
    process.exit(0);
  }

  const sigeConfig = config.sige;
  const mem0 = new Mem0Client({
    baseUrl: sigeConfig.mem0.baseUrl,
    apiToken: sigeConfig.mem0.apiToken,
  });
  const userId = sigeConfig.mem0.userId;

  log.info("SIGE ingestion process started", {
    mem0BaseUrl: sigeConfig.mem0.baseUrl,
    userId,
    batchSize: BATCH_SIZE,
    intervalMs: POLL_INTERVAL_MS,
    minContentLength: MIN_CONTENT_LENGTH,
    credibilityFloor: CREDIBILITY_FLOOR,
    alphaRatioMin: ALPHA_RATIO_MIN,
    defaultMaxRecordsPerDay: DEFAULT_MAX_RECORDS_PER_DAY,
  });

  // Bug 1 fix: run-then-reschedule with a single in-flight guard.
  // The gap between cycles is POLL_INTERVAL_MS regardless of cycle duration.
  // try/finally ensures a crashed cycle still reschedules.
  let running = false;

  async function scheduleNext(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    void tick();
  }

  async function tick(): Promise<void> {
    if (running) {
      log.warn("Ingestion cycle still in progress — skipping overlapping tick");
      void scheduleNext();
      return;
    }
    running = true;
    try {
      await runIngestionCycle(mem0, userId);
    } catch (err) {
      log.warn("Ingestion cycle failed — will retry next interval", { err });
    } finally {
      running = false;
      void scheduleNext();
    }
  }

  // Run an immediate first cycle, then schedule subsequent cycles.
  try {
    await runIngestionCycle(mem0, userId);
  } catch (err) {
    log.warn("First ingestion cycle failed — will retry next interval", { err });
  }
  void scheduleNext();
}

// Import-safe: only register process-level handlers and start the process when
// this file is executed directly (`bun run src/entries/sige-ingestion.ts`), NOT
// when imported (e.g. by sige-ingestion.test.ts for the pure computeCredibility
// helper). Without this guard, importing the module ran main() → DB connect →
// process.exit(1) in the no-DB unit lane (CI exit 123).
if (import.meta.main) {
  process.on("unhandledRejection", (reason: unknown) => {
    log.error("Unhandled promise rejection (non-fatal)", { error: reason });
  });

  process.on("uncaughtException", (error: Error) => {
    log.error("Uncaught exception — exiting", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });

  main().catch((err) => {
    log.error("SIGE ingestion process failed to start", { error: err });
    process.exit(1);
  });
}
