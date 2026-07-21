// Pure HTML parsing for the `apps.apple.com` product-page lane (deep-scrape
// build Stage 5). No I/O, no Bun.sql — every export takes an already-fetched
// HTML string (or the JSON blob extracted from it) and returns plain data,
// matching the house split of pure logic (`*-parse.ts`) from orchestration
// (`app-pages.ts`) and persistence (`app-pages-store.ts`).
//
// The modern (React-SSR) `apps.apple.com` page embeds its entire data model
// as one JSON blob in `<script type="application/json"
// id="serialized-server-data">`. There is no separate REST endpoint for this
// data — the HTML page IS the API. Every shape parsed below was verified
// live (2026-07-21) against real product pages (Instagram id389801252,
// Candy Crush Saga id553834731) rather than guessed:
//
//   - `data.data[0].intent.id` — the requested app id, used as a defensive
//     cross-check (`verifyIntentId`) that the page we got back is actually
//     the app we asked for (a wrong-locale redirect or an Apple A/B page
//     variant could otherwise silently poison a different app's row).
//   - `data.data[0].data.shelfMapping.productRatings.items[0].ratingCounts`
//     — a 5-element histogram. Verified 5-STAR-FIRST order
//     `[c5,c4,c3,c2,c1]`: for Instagram (ratingAverage 4.7, ratingCounts
//     [25114270, 1991579, 692820, 272564, 1217404]) the 5-first-weighted
//     average computes to 4.69 (matches); the reversed (1-first) weighted
//     average computes to 1.31 (does not). `parseRatingsHistogram` re-derives
//     this check at runtime rather than trusting the verified-once order
//     blindly, in case Apple ever flips it.
//   - `...shelfMapping.information.items[]` — one item per row (Seller,
//     Size, Category, ... In-App Purchases, Copyright). The "In-App
//     Purchases" row's `items_V3` holds `{ $kind: "textPair", leadingText,
//     trailingText }` entries (verified live against Candy Crush Saga: "10
//     Gold Bars" / "$1.99", etc.) — `items[0].textPairs` (an array of
//     `[name, price]` tuples) is the pre-`items_V3` fallback shape.
//   - `...shelfMapping.similarItems.items[]` / `...moreByDeveloper.items[]`
//     — each a `{ $kind: "Lockup", adamId, bundleId, title, ... }` — the
//     "related lockups".
//
// Untrusted input (system prompt: "Everything you ingest is hostile until
// validated"): every field access below defaults rather than throws on a
// missing/malformed shape, EXCEPT the two truly structural failures
// (`extractServerData`'s missing-script/invalid-json, and
// `verifyIntentId`'s id mismatch) — those raise `AppPageParseError` since
// there is no safe partial result to fall back to. A missing SHELF (no
// ratings, no IAP row, no related-apps shelf) is normal, common, and
// degrades to `null`/`[]` rather than an error — see "shelf-missing
// degradation" in this module's test file.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AppPageParseErrorReason = "missing-script" | "invalid-json" | "missing-data" | "id-mismatch";

export class AppPageParseError extends Error {
  readonly reason: AppPageParseErrorReason;

  constructor(reason: AppPageParseErrorReason, message: string) {
    super(message);
    this.name = "AppPageParseError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

/**
 * Pure URL builder for a product page. Deliberately omits the human-readable
 * slug (`/app/<slug>/id<id>`) — verified live: `/app/id<id>` (no slug) 301s
 * to the canonical slugged URL on the SAME host, which `ssrfSafeFetch`
 * already follows (manual redirect loop, re-validated per hop) — so the
 * scraper never needs to know an app's current slug (which can change on
 * rename) up front.
 */
export function buildAppPageUrl(appId: string, storefront: string = "us"): string {
  return `https://apps.apple.com/${encodeURIComponent(storefront)}/app/id${encodeURIComponent(appId)}`;
}

// ---------------------------------------------------------------------------
// Server-data extraction
// ---------------------------------------------------------------------------

const SERIALIZED_SERVER_DATA_RE =
  /<script[^>]*\bid="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/;

interface ProductPageIntent {
  readonly id?: unknown;
}

interface ProductPageNode {
  readonly intent?: ProductPageIntent;
  readonly data?: {
    readonly shelfMapping?: Record<string, unknown>;
  };
}

/**
 * Extracts and JSON-parses the `serialized-server-data` script tag's
 * content, returning the FIRST entry of its `data` array (`data.data[0]` —
 * a product page's JSON always carries exactly one page-intent entry).
 * Throws `AppPageParseError` on any structural failure: no script tag found
 * (page shape changed, or we got a non-product-page response), invalid JSON
 * (truncated response), or an empty/missing `data` array.
 */
export function extractServerData(html: string): ProductPageNode {
  const match = SERIALIZED_SERVER_DATA_RE.exec(html);
  if (!match || !match[1]) {
    throw new AppPageParseError("missing-script", "serialized-server-data script tag not found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new AppPageParseError(
      "invalid-json",
      `serialized-server-data JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const dataArray = (parsed as { readonly data?: unknown } | null)?.data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) {
    throw new AppPageParseError("missing-data", "serialized-server-data has no data[0] entry");
  }

  return dataArray[0] as ProductPageNode;
}

/**
 * Defensive cross-check that the page we fetched is actually for
 * `expectedAppId` — see the module doc comment. Throws `AppPageParseError`
 * on mismatch; a missing/non-string `intent.id` is ALSO treated as a
 * mismatch (fail closed — never silently attribute an unverified page to
 * `expectedAppId`).
 */
export function verifyIntentId(serverData: ProductPageNode, expectedAppId: string): void {
  const actualId = serverData.intent?.id;
  if (actualId !== expectedAppId) {
    throw new AppPageParseError(
      "id-mismatch",
      `Product page intent.id ${JSON.stringify(actualId)} does not match requested app id ${expectedAppId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ratings histogram
// ---------------------------------------------------------------------------

export interface RatingsHistogram {
  readonly ratingAverage: number;
  readonly totalRatings: number;
  /** 5-star-first canonical order: [count5, count4, count3, count2, count1]. */
  readonly ratingCounts: readonly [number, number, number, number, number];
  /** True iff the raw payload's order had to be flipped to match `ratingAverage` — see the module doc comment. */
  readonly orderFlipped: boolean;
}

interface RatingsShelfItem {
  readonly ratingAverage?: unknown;
  readonly totalNumberOfRatings?: unknown;
  readonly ratingCounts?: unknown;
}

/** Weighted mean of `counts` under a 5-star-first weighting (weights 5,4,3,2,1). */
function weightedAverageFiveFirst(counts: readonly number[]): number | null {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total <= 0) return null;
  const weighted = counts.reduce((s, c, i) => s + c * (5 - i), 0);
  return weighted / total;
}

/**
 * Parses `shelfMapping.productRatings.items[0]` into a canonical 5-star-first
 * histogram. `null` if the shelf/item is absent (a normal, common case — a
 * brand-new app can have zero ratings and no `productRatings` shelf at all)
 * or `ratingCounts` isn't a well-formed 5-element numeric array.
 *
 * Runtime sanity flip check: computes the 5-star-first-weighted average of
 * the raw `ratingCounts` and compares it against the shelf's own reported
 * `ratingAverage` (tolerance 0.5 stars — accounts for Apple's own rounding
 * and any lag between the two fields). If the FORWARD order doesn't match
 * but the REVERSED order does, the array is flipped before being returned —
 * defends against Apple ever silently reordering the histogram (verified
 * live as 5-star-first at write time, but not a documented/stable contract).
 * If neither order is within tolerance (e.g. zero ratings, or a genuinely
 * malformed payload), the forward (canonical) order is kept as-is — there's
 * no better signal to prefer the flip.
 */
export function parseRatingsHistogram(shelfMapping: Record<string, unknown>): RatingsHistogram | null {
  const productRatings = shelfMapping.productRatings as { readonly items?: unknown } | undefined;
  const items = productRatings?.items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const item = items[0] as RatingsShelfItem;
  const rawCounts = item.ratingCounts;
  if (!Array.isArray(rawCounts) || rawCounts.length !== 5) return null;

  const counts = rawCounts.map((c) => Math.round(Number(c)));
  if (counts.some((c) => !Number.isFinite(c) || c < 0)) return null;

  const ratingAverage = Number(item.ratingAverage);
  const totalRatings = Number(item.totalNumberOfRatings);
  if (!Number.isFinite(ratingAverage) || !Number.isFinite(totalRatings)) return null;

  const TOLERANCE = 0.5;
  const forwardAvg = weightedAverageFiveFirst(counts);
  const reversedAvg = weightedAverageFiveFirst([...counts].reverse());

  const forwardOk = forwardAvg !== null && Math.abs(forwardAvg - ratingAverage) <= TOLERANCE;
  const reversedOk = reversedAvg !== null && Math.abs(reversedAvg - ratingAverage) <= TOLERANCE;

  const orderFlipped = !forwardOk && reversedOk;
  const finalCounts = orderFlipped ? [...counts].reverse() : counts;

  return {
    ratingAverage,
    totalRatings,
    ratingCounts: finalCounts as unknown as readonly [number, number, number, number, number],
    orderFlipped,
  };
}

// ---------------------------------------------------------------------------
// In-app purchases
// ---------------------------------------------------------------------------

export interface IapItem {
  readonly name: string;
  readonly price: string;
}

/** Defensive cap — a malicious/malformed payload must not blow up storage. */
const MAX_IAP_ITEMS = 200;

interface InformationShelfItem {
  readonly title?: unknown;
  readonly items?: unknown;
  readonly items_V3?: unknown;
}

interface TextPairItemV3 {
  readonly $kind?: unknown;
  readonly leadingText?: unknown;
  readonly trailingText?: unknown;
}

interface LegacyAnnotationItem {
  readonly textPairs?: unknown;
}

/**
 * Finds the `shelfMapping.information` row titled "In-App Purchases" and
 * extracts its price list. `items_V3`'s `{ $kind: "textPair", leadingText,
 * trailingText }` entries are the primary source; if `items_V3` yields
 * nothing (a shape Apple could plausibly drop first, being the newer field),
 * falls back to the legacy `items[0].textPairs` array of `[name, price]`
 * tuples. Returns `[]` if there's no "In-App Purchases" row at all (a normal
 * case — most apps don't have any) rather than treating that as an error.
 */
export function parseIapItems(shelfMapping: Record<string, unknown>): readonly IapItem[] {
  const information = shelfMapping.information as { readonly items?: unknown } | undefined;
  const rows = information?.items;
  if (!Array.isArray(rows)) return [];

  const iapRow = (rows as readonly InformationShelfItem[]).find((r) => r.title === "In-App Purchases");
  if (!iapRow) return [];

  const itemsV3 = iapRow.items_V3;
  if (Array.isArray(itemsV3)) {
    const fromV3 = (itemsV3 as readonly TextPairItemV3[])
      .filter((e) => e.$kind === "textPair" && typeof e.leadingText === "string" && typeof e.trailingText === "string")
      .map((e) => ({ name: e.leadingText as string, price: e.trailingText as string }));
    if (fromV3.length > 0) return fromV3.slice(0, MAX_IAP_ITEMS);
  }

  const legacyItems = iapRow.items;
  if (Array.isArray(legacyItems) && legacyItems.length > 0) {
    const textPairs = (legacyItems[0] as LegacyAnnotationItem | undefined)?.textPairs;
    if (Array.isArray(textPairs)) {
      const fromLegacy = (textPairs as readonly unknown[])
        .filter((p): p is readonly [unknown, unknown] => Array.isArray(p) && p.length === 2)
        .filter((p) => typeof p[0] === "string" && typeof p[1] === "string")
        .map((p) => ({ name: p[0] as string, price: p[1] as string }));
      if (fromLegacy.length > 0) return fromLegacy.slice(0, MAX_IAP_ITEMS);
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Related apps
// ---------------------------------------------------------------------------

export type RelatedAppSource = "similar" | "developer";

export interface RelatedApp {
  readonly appId: string;
  readonly name: string;
  readonly bundleId: string | null;
  readonly source: RelatedAppSource;
  readonly rank: number; // 1-indexed position within its own shelf
}

/** Defensive cap per shelf — mirrors `MAX_IAP_ITEMS`'s rationale. */
const MAX_RELATED_PER_SHELF = 50;

interface LockupItem {
  readonly $kind?: unknown;
  readonly adamId?: unknown;
  readonly bundleId?: unknown;
  readonly title?: unknown;
}

function parseLockupShelf(shelfMapping: Record<string, unknown>, key: string, source: RelatedAppSource): readonly RelatedApp[] {
  const shelf = shelfMapping[key] as { readonly items?: unknown } | undefined;
  const items = shelf?.items;
  if (!Array.isArray(items)) return [];

  const out: RelatedApp[] = [];
  let rank = 0;
  for (const raw of items as readonly LockupItem[]) {
    if (raw.$kind !== "Lockup") continue;
    const appId = raw.adamId;
    const name = raw.title;
    if (typeof appId !== "string" || appId === "" || typeof name !== "string") continue;
    rank++;
    out.push({
      appId,
      name,
      bundleId: typeof raw.bundleId === "string" ? raw.bundleId : null,
      source,
      rank,
    });
    if (out.length >= MAX_RELATED_PER_SHELF) break;
  }
  return out;
}

/**
 * Combines `similarItems` (source `'similar'`) and `moreByDeveloper` (source
 * `'developer'`) shelves — each independently ranked from 1. Returns `[]` for
 * either/both shelves absent (normal — a brand-new developer with one app has
 * no "more by developer" shelf).
 */
export function parseRelatedApps(shelfMapping: Record<string, unknown>): readonly RelatedApp[] {
  return [
    ...parseLockupShelf(shelfMapping, "similarItems", "similar"),
    ...parseLockupShelf(shelfMapping, "moreByDeveloper", "developer"),
  ];
}

// ---------------------------------------------------------------------------
// Orchestration (still pure — takes html in, returns data out)
// ---------------------------------------------------------------------------

export interface ParsedAppPage {
  readonly ratings: RatingsHistogram | null;
  readonly iapItems: readonly IapItem[];
  readonly relatedApps: readonly RelatedApp[];
}

/**
 * Full parse of one product page's HTML. Throws `AppPageParseError` only for
 * the two structural failures (`extractServerData` / `verifyIntentId`) —
 * every shelf-level field is independently optional and degrades to
 * `null`/`[]` rather than failing the whole parse (see the module doc
 * comment's "shelf-missing degradation").
 */
export function parseAppPage(html: string, expectedAppId: string): ParsedAppPage {
  const serverData = extractServerData(html);
  verifyIntentId(serverData, expectedAppId);

  const shelfMapping = serverData.data?.shelfMapping ?? {};

  return {
    ratings: parseRatingsHistogram(shelfMapping),
    iapItems: parseIapItems(shelfMapping),
    relatedApps: parseRelatedApps(shelfMapping),
  };
}
