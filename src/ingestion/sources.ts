/**
 * Per-source ingestion definitions: how to fetch the next batch, compute the
 * source's high-water mark, and render rows to mem0 text + metadata.
 *
 * Each source reads scraped Postgres rows freshest-first (indexed_at DESC, id
 * DESC) using a tie-safe composite-cursor predicate.
 */

import type { CompositeCursor } from "./cursor";
import { computeCredibility } from "./credibility";
import { getDb } from "../store/db";

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

// ─── Source Definitions ───────────────────────────────────────────────────────

export interface SourceDefinition<
  T extends { readonly id: string; readonly indexed_at: number | null },
> {
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

export type AnySourceDefinition = SourceDefinition<{
  readonly id: string;
  readonly indexed_at: number | null;
}>;

export const SOURCES: ReadonlyArray<AnySourceDefinition> = [
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
] as ReadonlyArray<AnySourceDefinition>;
