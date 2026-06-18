/**
 * Standalone entry point for the SIGE continuous ingestion process.
 *
 * Runs on a 5-minute timer and incrementally ingests project data
 * (app reviews, Reddit posts, HN stories, PH products, news, apps)
 * into the Mem0 knowledge graph via the Mem0 REST API.
 *
 * Cursor positions are persisted in config_overrides so each run
 * picks up exactly where the previous one stopped.
 *
 * Usage:
 *   bun src/entries/sige-ingestion.ts
 */

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
const MIN_CONTENT_LENGTH = 20;
const CURSOR_NAMESPACE = "sige-ingestion";

// ─── Source Row Types ─────────────────────────────────────────────────────────

interface AppStoreReviewRow {
  readonly id: string;
  readonly app_name: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly rating: number;
}

interface PlayStoreReviewRow {
  readonly id: string;
  readonly app_name: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly rating: number;
  readonly thumbs_up: number | null;
}

interface RedditPostRow {
  readonly id: string;
  readonly subreddit: string;
  readonly title: string;
  readonly selftext: string | null;
  readonly score: number;
  readonly num_comments: number;
}

interface PhProductRow {
  readonly id: string;
  readonly name: string;
  readonly tagline: string | null;
  readonly description: string | null;
  readonly votes_count: number;
}

interface HnStoryRow {
  readonly id: string;
  readonly title: string;
  readonly points: number;
  readonly comment_count: number;
  readonly description: string | null;
}

interface NewsArticleRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly category: string | null;
  readonly source_name: string | null;
}

interface AppStoreAppRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
}

interface PlayStoreAppRow {
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
  readonly rating: number | null;
  readonly installs: string | null;
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

// ─── Source Definitions ───────────────────────────────────────────────────────

interface SourceDefinition<T extends { readonly id: string }> {
  readonly name: string;
  readonly priority: number;
  fetchBatch(cursorId: string, limit: number): Promise<readonly T[]>;
  toText(row: T): string;
  toMetadata(row: T): Record<string, unknown>;
  getContent(row: T): string;
}

function makeSource<T extends { readonly id: string }>(
  def: SourceDefinition<T>,
): SourceDefinition<T> {
  return def;
}

const SOURCES: ReadonlyArray<SourceDefinition<{ readonly id: string }>> = [
  makeSource<AppStoreReviewRow>({
    name: "appstore_reviews",
    priority: 1,
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, app_name, title, content, rating
        FROM appstore_reviews
        WHERE rating <= 2 AND id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as AppStoreReviewRow[];
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
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, app_name, title, content, rating, thumbs_up
        FROM playstore_reviews
        WHERE rating <= 2 AND id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as PlayStoreReviewRow[];
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
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, subreddit, title, selftext, score, num_comments
        FROM reddit_posts
        WHERE id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as RedditPostRow[];
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
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, name, tagline, description, votes_count
        FROM ph_products
        WHERE id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as PhProductRow[];
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
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, title, points, comment_count, description
        FROM hn_stories
        WHERE id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as HnStoryRow[];
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

  makeSource<NewsArticleRow>({
    name: "news_articles",
    priority: 3,
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, title, summary, category, source_name
        FROM news_articles
        WHERE id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as NewsArticleRow[];
    },
    toText(r) {
      const summary = (r.summary ?? "").slice(0, 400);
      return `[${r.category ?? "General"}] ${r.title} — ${summary}. Source: ${r.source_name ?? "unknown"}.`;
    },
    toMetadata(r) {
      return {
        source: "news",
        source_type: "news_article",
        category: r.category,
        credibility: computeCredibility({ source_type: "news_article" }),
        ingested_at: Math.floor(Date.now() / 1_000),
      };
    },
    getContent(r) {
      return `${r.title} ${r.summary ?? ""}`;
    },
  }),

  makeSource<AppStoreAppRow>({
    name: "appstore_apps",
    priority: 3,
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, name, category, description
        FROM appstore_apps
        WHERE id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as AppStoreAppRow[];
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
    async fetchBatch(cursorId, limit) {
      const db = getDb();
      return (await db`
        SELECT id, name, category, description, rating, installs
        FROM playstore_apps
        WHERE id > ${cursorId}
        ORDER BY id ASC
        LIMIT ${limit}
      `) as PlayStoreAppRow[];
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
] as ReadonlyArray<SourceDefinition<{ readonly id: string }>>;

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function cursorKey(sourceName: string): string {
  return `cursor:${sourceName}`;
}

async function readCursor(sourceName: string): Promise<string> {
  const stored = await getOverride(CURSOR_NAMESPACE, cursorKey(sourceName));
  if (typeof stored === "string") return stored;
  if (typeof stored === "number") return String(stored);
  return "";
}

async function writeCursor(sourceName: string, lastId: string): Promise<void> {
  await setOverride(CURSOR_NAMESPACE, cursorKey(sourceName), lastId);
}

// ─── Single-source ingestion ──────────────────────────────────────────────────

interface SourceRunResult {
  readonly sourceName: string;
  readonly ingested: number;
  readonly skipped: number;
  readonly caughtUp: boolean;
  /** Number of records where mem0.addMemory threw (content was valid but write failed). */
  readonly mem0Failures: number;
}

async function ingestSource(
  source: SourceDefinition<{ readonly id: string }>,
  mem0: Mem0Client,
  userId: string,
): Promise<SourceRunResult> {
  const cursorId = await readCursor(source.name);

  let rows: ReadonlyArray<{ readonly id: string }>;
  try {
    rows = await source.fetchBatch(cursorId, BATCH_SIZE);
  } catch (err) {
    log.warn("Failed to fetch batch — skipping source this cycle", {
      source: source.name,
      err,
    });
    return { sourceName: source.name, ingested: 0, skipped: 0, caughtUp: false, mem0Failures: 0 };
  }

  if (rows.length === 0) {
    return { sourceName: source.name, ingested: 0, skipped: 0, caughtUp: true, mem0Failures: 0 };
  }

  let ingested = 0;
  let skipped = 0;
  let mem0Failures = 0;
  let lastSuccessfulId = cursorId;

  for (const row of rows) {
    const content = source.getContent(row).trim();

    if (content.length < MIN_CONTENT_LENGTH) {
      skipped++;
      lastSuccessfulId = row.id;
      continue;
    }

    const text = source.toText(row);
    const metadata = source.toMetadata(row);

    try {
      await mem0.addMemory({ content: text, userId, metadata });
      ingested++;
      lastSuccessfulId = row.id;
    } catch (err) {
      mem0Failures++;
      log.warn("Failed to ingest record — skipping", {
        source: source.name,
        id: row.id,
        err,
      });
      // Advance cursor past this record so we do not retry it forever
      lastSuccessfulId = row.id;
    }
  }

  // Persist cursor even if some records failed — we advance past them
  if (lastSuccessfulId > cursorId) {
    try {
      await writeCursor(source.name, lastSuccessfulId);
    } catch (err) {
      log.error("Failed to persist cursor — next run will re-process this batch", {
        source: source.name,
        lastSuccessfulId,
        err,
      });
    }
  }

  const caughtUp = rows.length < BATCH_SIZE;

  return { sourceName: source.name, ingested, skipped, caughtUp, mem0Failures };
}

// ─── One ingestion cycle ──────────────────────────────────────────────────────

async function runIngestionCycle(mem0: Mem0Client, userId: string): Promise<void> {
  log.info("Ingestion cycle started");

  // Sort by priority ascending so highest-signal sources are processed first
  const sorted = [...SOURCES].sort((a, b) => a.priority - b.priority);

  const results: SourceRunResult[] = [];

  for (const source of sorted) {
    const result = await ingestSource(source, mem0, userId);
    results.push(result);
  }

  // Aggregate totals across all sources for quick at-a-glance observability
  const totalIngested = results.reduce((sum, r) => sum + r.ingested, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  const totalMem0Failures = results.reduce((sum, r) => sum + r.mem0Failures, 0);

  // Build per-source summary line
  const summary = results
    .map((r) => {
      if (r.caughtUp && r.ingested === 0) return `${r.sourceName}: all caught up`;
      const failSuffix = r.mem0Failures > 0 ? ` ${r.mem0Failures} write-err` : "";
      return `${r.sourceName}: +${r.ingested}${r.skipped > 0 ? ` (${r.skipped} skipped)` : ""}${failSuffix}`;
    })
    .join(", ");

  if (totalIngested === 0) {
    // Explicit "nothing happened" log so operators can tell idle from stuck
    log.info("Ingestion cycle complete — nothing new this cycle", {
      summary,
      totalIngested,
      totalSkipped,
      totalMem0Failures,
    });
  } else {
    log.info("Ingestion cycle complete", {
      summary,
      totalIngested,
      totalSkipped,
      totalMem0Failures,
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

  if (config.sige === undefined || !config.sige.enabled) {
    log.info("SIGE not configured or disabled — exiting");
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
  });

  // Run an immediate first cycle, then poll
  try {
    await runIngestionCycle(mem0, userId);
  } catch (err) {
    log.warn("First ingestion cycle failed — will retry next interval", { err });
  }

  setInterval(() => {
    runIngestionCycle(mem0, userId).catch((err) => {
      log.warn("Ingestion cycle failed — will retry next interval", { err });
    });
  }, POLL_INTERVAL_MS);
}

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
