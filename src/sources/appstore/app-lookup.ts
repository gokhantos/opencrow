// The ONE iTunes Lookup API client in the codebase (deep-scrape build Stage
// 2, §0.5 of the build plan) — batched id lookup (`fetchLookupBatch`) and
// developer-portfolio lookup (`fetchArtistPortfolio`), both against the same
// `https://itunes.apple.com/lookup` endpoint. Nothing else may redeclare
// `chunkIds`/`buildLookupUrl`/the lookup zod schema — `scraper.ts`'s
// `fetchRelatedApps` predates this module and has its own inline lookup
// calls; those are NOT migrated here (out of scope for Stage 2 — see the
// build plan's Stage 3 note about `scraper.ts` shrinking when `charts.ts` is
// extracted), but every NEW lookup call in the deep-scrape build goes through
// this module.

import { z } from "zod";
import { createLogger } from "../../logger";
import { ssrfSafeFetch } from "../shared/ssrf-safe-fetch";

const log = createLogger("appstore:app-lookup");

// Apple's documented ceiling on `id=` batch size for `/lookup` is ~200 —
// verified empirically (see the module context this build plan was written
// against: "lookup API supports batching up to ~200 ids per request").
export const MAX_LOOKUP_BATCH_SIZE = 200;

/**
 * Splits `ids` into batches of at most `size` (default `MAX_LOOKUP_BATCH_SIZE`),
 * preserving order. Pure — no I/O. Returns `[]` for an empty input; never
 * returns an empty batch.
 */
export function chunkIds(
  ids: readonly string[],
  size: number = MAX_LOOKUP_BATCH_SIZE,
): readonly (readonly string[])[] {
  if (ids.length === 0) return [];
  const clampedSize = Math.max(1, Math.floor(size));
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += clampedSize) {
    batches.push(ids.slice(i, i + clampedSize));
  }
  return batches;
}

/** Pure URL builder for a batched `/lookup?id=a,b,c` request. */
export function buildLookupUrl(ids: readonly string[]): string {
  return `https://itunes.apple.com/lookup?id=${ids.map(encodeURIComponent).join(",")}`;
}

/**
 * Pure URL builder for a developer-portfolio lookup: every software item by
 * `artistId`, up to `limit` (default `MAX_LOOKUP_BATCH_SIZE` — the same
 * ceiling applies to this endpoint). Mirrors the shape of `scraper.ts`'s
 * pre-existing (unmigrated) artist lookup in `fetchRelatedApps`, but as a
 * pure, independently testable builder.
 */
export function buildPortfolioUrl(artistId: string, limit: number = MAX_LOOKUP_BATCH_SIZE): string {
  const clampedLimit = Math.max(1, Math.floor(limit));
  return `https://itunes.apple.com/lookup?id=${encodeURIComponent(artistId)}&entity=software&limit=${clampedLimit}`;
}

// ---------------------------------------------------------------------------
// Response parsing — defensive, mirrors keyword-gaps.ts's
// ItunesSoftwareResultSchema: a single malformed row must not crash the
// batch, so every field falls back to a safe default rather than throwing.
// ---------------------------------------------------------------------------

const LookupSoftwareResultSchema = z
  .object({
    wrapperType: z.string().catch(""),
    trackId: z.coerce.number().catch(0),
    trackName: z.string().catch(""),
    userRatingCount: z.coerce.number().catch(0),
    averageUserRating: z.coerce.number().catch(0),
    releaseDate: z.string().catch(""),
    currentVersionReleaseDate: z.string().catch(""),
    version: z.string().catch(""),
    price: z.coerce.number().catch(0),
    formattedPrice: z.string().catch(""),
    primaryGenreId: z.coerce.string().catch(""),
    primaryGenreName: z.string().catch(""),
    artistId: z.coerce.string().catch(""),
    artistName: z.string().catch(""),
    bundleId: z.string().catch(""),
    trackViewUrl: z.string().catch(""),
    artworkUrl100: z.string().catch(""),
  })
  .catch({
    wrapperType: "",
    trackId: 0,
    trackName: "",
    userRatingCount: 0,
    averageUserRating: 0,
    releaseDate: "",
    currentVersionReleaseDate: "",
    version: "",
    price: 0,
    formattedPrice: "",
    primaryGenreId: "",
    primaryGenreName: "",
    artistId: "",
    artistName: "",
    bundleId: "",
    trackViewUrl: "",
    artworkUrl100: "",
  });

const LookupResponseSchema = z.object({
  results: z.array(LookupSoftwareResultSchema).catch([]),
});

export type LookupSoftwareResult = z.infer<typeof LookupSoftwareResultSchema>;

/** Clean, camelCase shape callers work with — mapped from the raw iTunes payload. */
export interface LookupApp {
  readonly id: string;
  readonly name: string;
  readonly reviews: number;
  readonly rating: number;
  readonly releaseDate: string;
  readonly currentVersionReleaseDate: string;
  readonly version: string;
  readonly price: number;
  readonly formattedPrice: string;
  readonly genreId: string;
  readonly genreName: string;
  readonly artistId: string;
  readonly artistName: string;
  readonly bundleId: string;
  readonly trackViewUrl: string;
  readonly artworkUrl: string;
}

function toLookupApp(raw: LookupSoftwareResult): LookupApp {
  return {
    id: String(raw.trackId),
    name: raw.trackName,
    reviews: raw.userRatingCount,
    rating: raw.averageUserRating,
    releaseDate: raw.releaseDate,
    currentVersionReleaseDate: raw.currentVersionReleaseDate,
    version: raw.version,
    price: raw.price,
    formattedPrice: raw.formattedPrice,
    genreId: raw.primaryGenreId,
    genreName: raw.primaryGenreName,
    artistId: raw.artistId,
    artistName: raw.artistName,
    bundleId: raw.bundleId,
    trackViewUrl: raw.trackViewUrl,
    artworkUrl: raw.artworkUrl100,
  };
}

async function fetchAndParse(
  url: string,
  logLabel: string,
  useProxy: boolean = false,
): Promise<readonly LookupApp[]> {
  // `treat403AsRateLimit: true` — this hits the SAME `itunes.apple.com`
  // per-IP burst ceiling as `keyword-gaps.ts`'s search endpoint, enforced
  // with a bare 403 (no `Retry-After`) rather than 429/503. See
  // `rate-limit-error.ts`'s `RateLimitStatusOptions.treat403AsRateLimit`.
  const res = await ssrfSafeFetch(url, { retryOnRateLimit: true, treat403AsRateLimit: true, useProxy });
  if (!res.ok) {
    throw new Error(`iTunes lookup failed (${logLabel}): HTTP ${res.status}`);
  }

  const json = await res.json();
  const parsed = LookupResponseSchema.safeParse(json);
  if (!parsed.success) {
    log.warn("iTunes lookup response failed schema validation — treating as empty result set", {
      logLabel,
    });
    return [];
  }

  // Only `wrapperType: "software"` entries are apps — a portfolio lookup by
  // artistId can, in principle, surface non-software wrapper types.
  return parsed.data.results
    .filter((r) => r.wrapperType === "software" && r.trackId > 0)
    .map(toLookupApp);
}

/**
 * Batched id lookup — `ids.length` MUST be <= `MAX_LOOKUP_BATCH_SIZE` (the
 * caller, `app-enrichment.ts`, is responsible for chunking via `chunkIds`).
 * An id with no corresponding result (delisted, or never existed) is simply
 * absent from the returned array — the caller diffs the input ids against
 * the returned ones to detect misses. Throws `RateLimitError` (via
 * `ssrfSafeFetch`'s `retryOnRateLimit`) on exhausted rate-limit retries, and
 * a plain `Error` on a non-ok, non-rate-limited HTTP response.
 */
export async function fetchLookupBatch(
  ids: readonly string[],
  useProxy: boolean = false,
): Promise<readonly LookupApp[]> {
  if (ids.length === 0) return [];
  return fetchAndParse(buildLookupUrl(ids), `batch of ${ids.length}`, useProxy);
}

/**
 * Every software app by `artistId`, up to `limit`. Empty array for an
 * artist with no software portfolio (or an invalid/unknown artistId — the
 * iTunes API returns an empty `results` array rather than an error for
 * those, which flows through unchanged).
 */
export async function fetchArtistPortfolio(
  artistId: string,
  limit: number = MAX_LOOKUP_BATCH_SIZE,
  useProxy: boolean = false,
): Promise<readonly LookupApp[]> {
  return fetchAndParse(buildPortfolioUrl(artistId, limit), `portfolio artistId=${artistId}`, useProxy);
}
