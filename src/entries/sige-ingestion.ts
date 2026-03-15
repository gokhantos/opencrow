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
  readonly id: number;
  readonly app_name: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly rating: number;
}

interface PlayStoreReviewRow {
  readonly id: number;
  readonly app_name: string;
  readonly title: string | null;
  readonly content: string | null;
  readonly rating: number;
  readonly thumbs_up: number | null;
}

interface RedditPostRow {
  readonly id: number;
  readonly subreddit: string;
  readonly title: string;
  readonly selftext: string | null;
  readonly score: number;
  readonly num_comments: number;
}

interface PhProductRow {
  readonly id: number;
  readonly name: string;
  readonly tagline: string | null;
  readonly description: string | null;
  readonly votes_count: number;
}

interface HnStoryRow {
  readonly id: number;
  readonly title: string;
  readonly points: number;
  readonly comment_count: number;
  readonly description: string | null;
}

interface NewsArticleRow {
  readonly id: number;
  readonly title: string;
  readonly summary: string | null;
  readonly category: string | null;
  readonly source_name: string | null;
}

interface AppStoreAppRow {
  readonly id: number;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
}

interface PlayStoreAppRow {
  readonly id: number;
  readonly name: string;
  readonly category: string | null;
  readonly description: string | null;
  readonly rating: number | null;
  readonly installs: string | null;
}

// ─── Source Definitions ───────────────────────────────────────────────────────

interface SourceDefinition<T extends { readonly id: number }> {
  readonly name: string;
  readonly priority: number;
  fetchBatch(cursorId: number, limit: number): Promise<readonly T[]>;
  toText(row: T): string;
  toMetadata(row: T): Record<string, unknown>;
  getContent(row: T): string;
}

function makeSource<T extends { readonly id: number }>(
  def: SourceDefinition<T>,
): SourceDefinition<T> {
  return def;
}

const SOURCES: ReadonlyArray<SourceDefinition<{ readonly id: number }>> = [
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
      return { source: "appstore_review", app: r.app_name, rating: r.rating };
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
      return { source: "playstore_review", app: r.app_name, rating: r.rating };
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
      return { source: "reddit", subreddit: r.subreddit, score: r.score };
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
      return { source: "producthunt", votes: r.votes_count };
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
      return { source: "hackernews", points: r.points };
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
      return { source: "news", category: r.category };
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
      return { source: "appstore_app", category: r.category };
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
      return { source: "playstore_app", category: r.category, rating: r.rating };
    },
    getContent(r) {
      return `${r.name} ${r.description ?? ""}`;
    },
  }),
] as ReadonlyArray<SourceDefinition<{ readonly id: number }>>;

// ─── Cursor helpers ───────────────────────────────────────────────────────────

function cursorKey(sourceName: string): string {
  return `cursor:${sourceName}`;
}

async function readCursor(sourceName: string): Promise<number> {
  const stored = await getOverride(CURSOR_NAMESPACE, cursorKey(sourceName));
  if (typeof stored === "number") return stored;
  if (typeof stored === "string") return parseInt(stored, 10) || 0;
  return 0;
}

async function writeCursor(sourceName: string, lastId: number): Promise<void> {
  await setOverride(CURSOR_NAMESPACE, cursorKey(sourceName), lastId);
}

// ─── Single-source ingestion ──────────────────────────────────────────────────

interface SourceRunResult {
  readonly sourceName: string;
  readonly ingested: number;
  readonly skipped: number;
  readonly caughtUp: boolean;
}

async function ingestSource(
  source: SourceDefinition<{ readonly id: number }>,
  mem0: Mem0Client,
  userId: string,
): Promise<SourceRunResult> {
  const cursorId = await readCursor(source.name);

  let rows: ReadonlyArray<{ readonly id: number }>;
  try {
    rows = await source.fetchBatch(cursorId, BATCH_SIZE);
  } catch (err) {
    log.warn("Failed to fetch batch — skipping source this cycle", {
      source: source.name,
      err,
    });
    return { sourceName: source.name, ingested: 0, skipped: 0, caughtUp: false };
  }

  if (rows.length === 0) {
    return { sourceName: source.name, ingested: 0, skipped: 0, caughtUp: true };
  }

  let ingested = 0;
  let skipped = 0;
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

  return { sourceName: source.name, ingested, skipped, caughtUp };
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

  // Build summary log line
  const summary = results
    .map((r) => {
      if (r.caughtUp && r.ingested === 0) return `${r.sourceName}: all caught up`;
      return `${r.sourceName}: +${r.ingested}${r.skipped > 0 ? ` (${r.skipped} skipped)` : ""}`;
    })
    .join(", ");

  const totalIngested = results.reduce((sum, r) => sum + r.ingested, 0);

  log.info("Ingestion cycle complete", { summary, totalIngested });
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
  const mem0 = new Mem0Client({ baseUrl: sigeConfig.mem0.baseUrl });
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
