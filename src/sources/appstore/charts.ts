// Pure chart URL-building + response parsing for the App Store scraper —
// extracted from scraper.ts (deep-scrape build Stage 3) so the 1,000+ line
// orchestrator doesn't grow further as review-harvest (Stage 4) and
// app-page (Stage 5) wiring land on top of it. No I/O here: every export is
// a pure function over already-fetched JSON or plain inputs, matching the
// house split of pure logic (`*-types.ts` / this file) from orchestration
// (`scraper.ts`, `charts-intl.ts`).
//
// Storefront support (build plan §0.1/§0.3, migration 046): `charts-intl.ts`
// reuses `buildCategoryRankingUrl` / `parseTopAppsItunes` / `ITUNES_CATEGORIES`
// with a non-"us" storefront rather than duplicating them — the ONLY changes
// from the pre-Stage-3 shape are the storefront parameter each now accepts
// (defaulting to "us", so every existing US call site is unaffected) and
// `dedupeRankingsByListKey`'s key now includes storefront so intl and US
// rows sharing the same (id, list_type) never collide.

import type { AppstoreSyncListType } from "../../config/schema";
import type { AppRankingRow } from "./store";

// NOTE: genre 6026 was previously mislabeled "Travel" in this list — verified
// live against the iTunes RSS feed, 6026 actually returns Developer Tools
// (e.g. TestFlight). Corrected below; the real Travel genre id is 6003
// (verified separately, added as a new entry).
//
// Every id below was verified live (curl against
// itunes.apple.com/us/rss/topfreeapplications/.../genre=<id>/json) to return
// non-empty, correctly-labeled entries before being trusted here.
//
// 6021 and 6027 (deep-scrape build Stage 3, "+2 US categories") verified live
// 2026-07-21 the same way: 6021 returns Apple's legacy "Magazines &
// Newspapers" (Newsstand) feed — individual entries carry their own modern
// category label (News/Books/etc, not "Magazines & Newspapers") since Apple
// never remapped the feed after retiring Newsstand as a top-level category,
// but the feed itself is live and non-empty. 6027 returns "Graphics &
// Design", a normal current category.
export const ITUNES_CATEGORIES: ReadonlyArray<{
  readonly id: number;
  readonly name: string;
}> = [
  { id: 6000, name: "Business" },
  { id: 6001, name: "Weather" },
  { id: 6002, name: "Utilities" },
  { id: 6003, name: "Travel" },
  { id: 6004, name: "Sports" },
  { id: 6005, name: "Social Networking" },
  { id: 6006, name: "Reference" },
  { id: 6007, name: "Productivity" },
  { id: 6008, name: "Photo & Video" },
  { id: 6009, name: "News" },
  { id: 6010, name: "Navigation" },
  { id: 6011, name: "Music" },
  { id: 6012, name: "Lifestyle" },
  { id: 6013, name: "Health & Fitness" },
  { id: 6014, name: "Games" },
  { id: 6015, name: "Finance" },
  { id: 6016, name: "Entertainment" },
  { id: 6017, name: "Education" },
  { id: 6018, name: "Book" },
  { id: 6020, name: "Medical" },
  { id: 6021, name: "Magazines & Newspapers" },
  { id: 6023, name: "Food & Drink" },
  { id: 6024, name: "Shopping" },
  { id: 6026, name: "Developer Tools" },
  { id: 6027, name: "Graphics & Design" },
];

// Maps a sync list type to its iTunes RSS URL segment. All three verified
// live to return distinct, non-empty per-genre rankings.
const ITUNES_LIST_TYPE_URL_SEGMENT: Record<AppstoreSyncListType, string> = {
  "top-free": "topfreeapplications",
  "top-paid": "toppaidapplications",
  "top-grossing": "topgrossingapplications",
};

/**
 * Pure URL builder for a per-category (genre) iTunes RSS chart request.
 * `storefront` (build plan §0.1, "charts-intl") is the lowercase iTunes
 * storefront country code — defaults to "us" so every pre-Stage-3 call site
 * is byte-identical.
 */
export function buildCategoryRankingUrl(
  genreId: number,
  listType: AppstoreSyncListType,
  limit: number,
  storefront: string = "us",
): string {
  const segment = ITUNES_LIST_TYPE_URL_SEGMENT[listType];
  return `https://itunes.apple.com/${storefront}/rss/${segment}/limit=${limit}/genre=${genreId}/json`;
}

/** The `list_type` tag stored/queried for a given genre + sync list type. */
export function categoryListTypeTag(genreId: number, listType: AppstoreSyncListType): string {
  return `${listType}-${genreId}`;
}

/**
 * Pure URL builder for the GLOBAL (cross-category) top-free/top-paid feed,
 * served by rss.applemarketingtools.com — a different API from the
 * per-category iTunes RSS above. That API hard-errors (HTTP 500) above
 * limit=100 (verified live); callers must clamp `limit` accordingly.
 */
export function buildGlobalTopAppsUrl(
  listType: "top-free" | "top-paid",
  limit: number,
): string {
  return `https://rss.applemarketingtools.com/api/v2/us/apps/${listType}/${limit}/apps.json`;
}

/**
 * Drops duplicate (app id, list_type, storefront) triples, keeping the first
 * occurrence. Cheap defensive dedup for a single scrape/sweep cycle's
 * accumulated rankings — an app can legitimately appear in many different
 * list_types (e.g. once per genre/list-type it charts in) AND, since
 * Stage 3, in the SAME list_type tag across different storefronts (the tag
 * itself doesn't encode storefront), but should only be upserted once per
 * distinct (list_type, storefront) pair per cycle. Missing `storefront`
 * (pre-Stage-3 callers / rows) is treated as "us", matching the DB column's
 * own default.
 */
export function dedupeRankingsByListKey(
  rows: readonly AppRankingRow[],
): readonly AppRankingRow[] {
  const seen = new Set<string>();
  const result: AppRankingRow[] = [];
  for (const row of rows) {
    if (!row.id) continue;
    const key = `${row.id}|${row.list_type}|${row.storefront ?? "us"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

interface RssAppEntry {
  readonly id?: {
    readonly label?: string;
    readonly attributes?: {
      readonly "im:id"?: string;
      readonly "im:bundleId"?: string;
    };
  };
  readonly "im:name"?: { readonly label?: string };
  readonly "im:artist"?: { readonly label?: string };
  readonly category?: {
    readonly attributes?: { readonly label?: string };
  };
  readonly "im:image"?: ReadonlyArray<{ readonly label?: string }>;
  readonly link?:
    | { readonly attributes?: { readonly href?: string } }
    | ReadonlyArray<{ readonly attributes?: { readonly href?: string } }>;
  readonly summary?: { readonly label?: string };
  readonly "im:price"?: {
    readonly attributes?: { readonly amount?: string };
  };
  readonly "im:releaseDate"?: {
    readonly attributes?: { readonly label?: string };
  };
}

interface RssV2App {
  readonly id?: string;
  readonly name?: string;
  readonly artistName?: string;
  readonly genres?: ReadonlyArray<{ readonly name?: string }>;
  readonly artworkUrl100?: string;
  readonly url?: string;
}

export function parseTopAppsV2(
  data: unknown,
  listType: string,
): readonly AppRankingRow[] {
  const feed = (data as Record<string, unknown>)?.feed as
    | Record<string, unknown>
    | undefined;
  const results = (feed?.results ?? []) as readonly RssV2App[];
  const now = Math.floor(Date.now() / 1000);

  return results.map((app, index) => ({
    id: app.id ?? "",
    name: app.name ?? "",
    artist: app.artistName ?? "",
    category:
      (app.genres as ReadonlyArray<{ name?: string }> | undefined)?.[0]
        ?.name ?? "",
    rank: index + 1,
    list_type: listType,
    icon_url: app.artworkUrl100 ?? "",
    store_url: app.url ?? "",
    description: "",
    price: "",
    bundle_id: "",
    release_date: "",
    updated_at: now,
    indexed_at: null,
  }));
}

function itunesLinkHref(
  link:
    | { readonly attributes?: { readonly href?: string } }
    | ReadonlyArray<{ readonly attributes?: { readonly href?: string } }>
    | undefined,
): string {
  if (!link) return "";
  if (Array.isArray(link)) {
    return (link as ReadonlyArray<{ attributes?: { href?: string } }>)[0]
      ?.attributes?.href ?? "";
  }
  return (link as { attributes?: { href?: string } }).attributes?.href ?? "";
}

/**
 * Parses a per-category iTunes RSS chart response. `storefront` (Stage 3)
 * tags every returned row explicitly — defaults to "us" so pre-Stage-3
 * callers behave identically (the value now matches the DB column's own
 * default rather than leaving it unset).
 */
export function parseTopAppsItunes(
  data: unknown,
  listType: string,
  storefront: string = "us",
): readonly AppRankingRow[] {
  const feed = (data as Record<string, unknown>)?.feed as
    | Record<string, unknown>
    | undefined;
  if (!feed) return [];

  const rawEntries = feed.entry;
  if (!rawEntries) return [];

  const entries = (
    Array.isArray(rawEntries) ? rawEntries : [rawEntries]
  ) as readonly RssAppEntry[];

  const now = Math.floor(Date.now() / 1000);

  return entries.map((entry, index) => {
    const appId = entry.id?.attributes?.["im:id"] ?? "";
    const rawPrice = entry["im:price"]?.attributes?.amount ?? "";
    const price =
      rawPrice === "0" || rawPrice === "0.00000" ? "Free" : rawPrice;
    const images = entry["im:image"] ?? [];
    const iconUrl = images[images.length - 1]?.label ?? "";

    return {
      id: appId,
      name: entry["im:name"]?.label ?? "",
      artist: entry["im:artist"]?.label ?? "",
      category: entry.category?.attributes?.label ?? "",
      rank: index + 1,
      list_type: listType,
      icon_url: iconUrl,
      store_url: itunesLinkHref(entry.link),
      description: entry.summary?.label ?? "",
      price,
      bundle_id: entry.id?.attributes?.["im:bundleId"] ?? "",
      release_date: entry["im:releaseDate"]?.attributes?.label ?? "",
      updated_at: now,
      indexed_at: null,
      storefront,
    };
  });
}
