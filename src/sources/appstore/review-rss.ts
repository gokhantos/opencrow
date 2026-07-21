// The ONE review-feed parser in the codebase (deep-scrape build Stage 4,
// build plan §0.5): URL builder + pure parser for the iTunes customer-
// reviews RSS-as-JSON feed
// (`https://itunes.apple.com/<cc>/rss/customerreviews/page=<n>/id=<id>/sortby=mostrecent/json`,
// verified live: pages 1-10, 50 entries/page, HTTP 400 past page 10).
// `scraper.ts`'s legacy hourly page-1-only review path is re-based onto this
// module (build plan §0.4 hourly hook 2 — same behavior, rows just gain
// `review_date`/vote columns), and `review-harvester.ts` (Stage 4's deep
// multi-page harvester) is the other consumer — nothing else may re-implement
// this parsing.
//
// Manual/defensive object parsing, NOT zod — mirrors `charts.ts`'s
// `parseTopAppsItunes` (the closest analogous code: same iTunes
// RSS-as-JSON endpoint family) rather than `app-lookup.ts`'s zod schema
// (that endpoint's entries are homogeneous array elements; this one has the
// classic RSS-as-JSON "a single entry is a bare object, not a 1-element
// array" quirk, which a rigid zod object schema fights rather than
// tolerates).

import type { AppReviewRow } from "./store";
import { isoToEpochSeconds } from "./app-meta-types";

/** Entries per feed page — verified live against the iTunes endpoint. */
export const REVIEW_PAGE_SIZE = 50;

/** Highest page the feed serves — page 11+ is a verified-live HTTP 400. */
export const MAX_REVIEW_PAGES = 10;

/**
 * Pure URL builder for one page of an app's review feed. `storefront` is a
 * lowercase cc (build plan §0.5 convention), default `"us"`. `page` is
 * clamped to >= 1 only — callers (the harvester's page loop, gated by
 * `MAX_REVIEW_PAGES`) are responsible for never requesting past page 10.
 */
export function buildReviewFeedUrl(appId: string, page: number, storefront: string = "us"): string {
  const clampedPage = Math.max(1, Math.floor(page));
  return `https://itunes.apple.com/${encodeURIComponent(storefront)}/rss/customerreviews/page=${clampedPage}/id=${encodeURIComponent(appId)}/sortby=mostrecent/json`;
}

interface RssLabel {
  readonly label?: string;
}

interface RssReviewEntry {
  readonly id?: RssLabel;
  readonly author?: { readonly name?: RssLabel };
  readonly updated?: RssLabel;
  readonly "im:rating"?: RssLabel;
  readonly "im:version"?: RssLabel;
  readonly title?: RssLabel;
  readonly content?: RssLabel;
  readonly "im:voteSum"?: RssLabel;
  readonly "im:voteCount"?: RssLabel;
}

/** One parsed review-feed entry — pre-row; the caller (`toAppReviewRow`) stamps app/storefront/timestamps. */
export interface ParsedReview {
  readonly id: string;
  readonly author: string;
  readonly rating: number;
  readonly version: string;
  readonly title: string;
  readonly content: string;
  /** Epoch seconds, parsed from the feed entry's own `updated` field; `null` if unparseable. */
  readonly reviewDate: number | null;
  readonly voteSum: number;
  readonly voteCount: number;
}

/**
 * Parses one page of the review-feed response. Tolerates the iTunes
 * RSS-as-JSON "bare object instead of 1-element array" `entry` quirk (same
 * as `charts.ts`'s `parseTopAppsItunes`) and an entirely absent `entry` key
 * — verified live: an app with zero reviews (or a page past its last
 * available page, while still within the 1-10 range) returns a `feed` with
 * no `entry` key at all, not an empty array. A malformed entry (missing
 * `id.label` — the review's own id, NOT the app id) is dropped rather than
 * crashing the page.
 */
export function parseReviewFeedPage(data: unknown): readonly ParsedReview[] {
  const feed = (data as Record<string, unknown>)?.feed as Record<string, unknown> | undefined;
  if (!feed) return [];

  const rawEntries = feed.entry;
  if (!rawEntries) return [];

  const entries = (Array.isArray(rawEntries) ? rawEntries : [rawEntries]) as readonly RssReviewEntry[];

  return entries
    .filter((e) => e.id?.label)
    .map((entry) => ({
      id: entry.id?.label ?? "",
      author: entry.author?.name?.label ?? "",
      rating: parseInt(entry["im:rating"]?.label ?? "0", 10) || 0,
      version: entry["im:version"]?.label ?? "",
      title: entry.title?.label ?? "",
      content: entry.content?.label ?? "",
      reviewDate: isoToEpochSeconds(entry.updated?.label ?? ""),
      voteSum: parseInt(entry["im:voteSum"]?.label ?? "0", 10) || 0,
      voteCount: parseInt(entry["im:voteCount"]?.label ?? "0", 10) || 0,
    }));
}

/**
 * Maps a `ParsedReview` to the persisted row shape — the ONE mapping used by
 * both the legacy hourly path (`scraper.ts`) and the deep harvester
 * (`review-harvester.ts`). `now` stamps `first_seen_at` (when OpenCrow first
 * saw this review, distinct from `reviewDate`/`review_date` — when the
 * reviewer actually posted it).
 */
export function toAppReviewRow(
  parsed: ParsedReview,
  appId: string,
  appName: string,
  storefront: string,
  now: number,
): AppReviewRow {
  return {
    id: parsed.id,
    app_id: appId,
    app_name: appName,
    author: parsed.author,
    rating: parsed.rating,
    title: parsed.title,
    content: parsed.content,
    version: parsed.version,
    first_seen_at: now,
    indexed_at: null,
    review_date: parsed.reviewDate,
    storefront,
    vote_count: parsed.voteCount,
    vote_sum: parsed.voteSum,
  };
}
