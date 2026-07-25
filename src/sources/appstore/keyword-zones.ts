// HONEST genre zones for the App Store keyword corpus — the pure derivation
// layer (2026-07-25 corpus-hygiene pass). Companion to migration 057's
// `genre_zone_derived` / `genre_zone_confidence` / `genre_zone_derived_at`
// columns; applied by `keyword-store.ts`'s `setDerivedKeywordZone` /
// `deriveZonesFromStoredScans` and by `scripts/backfill-keyword-zones.ts`.
//
// ─── The problem ───────────────────────────────────────────────────────────
// `appstore_keywords.genre_zone` is `NOT NULL`, and every discovery path that
// had no real category to work from filled it with `keyword-miner.ts`'s
// `DEFAULT_ZONE` ('lifestyle'): the n-gram miner's app-name-only extraction
// path has no category at all, and autocomplete candidates inherit whatever
// their SEED happened to carry, hop after hop. Live measurement (2026-07-25):
// 73,028 of 95,570 active keywords (76%) carry `genre_zone = 'lifestyle'`,
// while only 2,537 keywords actually DERIVE lifestyle from their SERP
// incumbents' real categories. ~97% of that label is fiction, so every
// consumer that samples or segments by zone — `getDiverseZoneSample`'s
// round-robin, the dashboard's zone filter, the screener's slices — has been
// operating on one giant fake bucket.
//
// ─── The fix: derive, and be willing to say "I don't know" ──────────────────
// The real signal is already stored: the SERP incumbents recorded with every
// scan carry their own iTunes category (`TopApp.genre`, and
// `appstore_app_meta.genre_name` for ids that have been through Lookup
// enrichment). `deriveGenreZone` takes those raw category labels and returns
// the MODE zone plus a CONFIDENCE (the share of resolvable incumbents that
// agree) — or `null`.
//
// `null` is the whole point. It is returned when there are too few incumbents
// with a resolvable category, when the mode's share is below
// `ZONE_MIN_CONFIDENCE`, or when no category maps to a known zone. Consumers
// MUST treat `null` as "unclassified" and exclude it from zone buckets —
// NEVER `COALESCE` it to a default. Coalescing is precisely the bug this
// module exists to end.
//
// Projected effect on the live corpus (read-only measurement, 2026-07-25):
// of 95,012 active keywords with a usable latest US scan, 40,485 have at
// least one incumbent whose category maps to a real zone; 33,623 clear
// `ZONE_MIN_CONFIDENCE`, of which 20,037 DISAGREE with the stored
// `genre_zone` and 15,790 are rescued from the fake lifestyle default. The
// other ~61,000 stay `null` — honestly unclassified rather than
// confidently wrong.
//
// ─── Why this module owns its own category table ───────────────────────────
// It needs a STRICT mapper: `keyword-miner.ts`'s `mapCategoryToZone` falls
// back to `DEFAULT_ZONE` for anything unrecognized, which is the leak itself —
// an unmapped "Weather" must come back as `null`, not as lifestyle. Importing
// `keyword-miner.ts` to get at its table is not an option: that module imports
// `./keyword-store`, and any module that transitively pulls those exports in
// breaks the `mock.module` setups of unrelated `*.isolated.test.ts` files with
// a hard ESM "export not found" error (the exact hazard documented at the top
// of `brand-title-split.ts`, which is standalone for the same reason). So this
// module is standalone too, and `keyword-zones.test.ts` carries a drift guard
// asserting `STRICT_CATEGORY_TO_ZONE` agrees with `mapCategoryToZone` on every
// key it knows.

/**
 * App Store category label (lowercased) -> `keyword-corpus.ts` `GENRE_ZONES`
 * entry. A COPY of the mappings in `keyword-miner.ts`'s `CATEGORY_TO_ZONE`,
 * kept in lockstep by `keyword-zones.test.ts`'s drift guard — see the module
 * doc comment for why it cannot simply be imported. The crucial difference is
 * behavioral, not tabular: anything absent from this table resolves to `null`
 * here, where `mapCategoryToZone` resolves it to `DEFAULT_ZONE`.
 */
export const STRICT_CATEGORY_TO_ZONE: Readonly<Record<string, string>> = Object.freeze({
  business: "business",
  utilities: "utilities",
  "social networking": "social",
  productivity: "productivity",
  lifestyle: "lifestyle",
  "health & fitness": "health",
  games: "entertainment",
  finance: "finance",
  entertainment: "entertainment",
  education: "education",
  book: "reference",
  books: "reference",
  medical: "health",
  "food & drink": "food",
  shopping: "lifestyle",
  travel: "travel",
  photo: "photo",
  "photo & video": "photo",
  sports: "sports",
  reference: "reference",
});

/**
 * A raw App Store category label mapped to a `GENRE_ZONES` entry, or `null`
 * when the label is empty or has no explicit mapping. Case- and
 * whitespace-insensitive. Pure.
 */
export function mapCategoryToZoneStrict(category: string): string | null {
  const key = category.trim().toLowerCase();
  if (key.length === 0) return null;
  return STRICT_CATEGORY_TO_ZONE[key] ?? null;
}

/**
 * Minimum number of incumbents with a RESOLVABLE category before a zone may be
 * derived at all. Two agreeing apps out of a 20-app SERP is not a
 * classification, it is a coincidence — and the live corpus has plenty of
 * scans where only one or two incumbents have been genre-resolved so far
 * (Lookup enrichment has reached only ~0.5% of the app registry, so most
 * genre coverage still comes from the newer `TopApp.genre` field). Below this,
 * the honest answer is `null`.
 */
export const ZONE_MIN_INCUMBENTS = 3;

/**
 * Minimum share of resolvable incumbents that must agree on the mode zone. A
 * bare majority (0.5) is deliberately the bar rather than something stricter:
 * real SERPs legitimately straddle two adjacent zones (a "meal planner" field
 * splits Food & Drink / Health & Fitness), and demanding e.g. 0.8 would push
 * most of the corpus into `null` for no gain in honesty. The confidence is
 * STORED alongside the zone, so a consumer that wants a stricter bar can
 * filter on it rather than needing this constant raised.
 */
export const ZONE_MIN_CONFIDENCE = 0.5;

export interface DerivedZone {
  /** A `keyword-corpus.ts` `GENRE_ZONES` entry — never a default/placeholder. */
  readonly zone: string;
  /** Share of resolvable incumbents agreeing with `zone`, 0..1. */
  readonly confidence: number;
  /** How many incumbents had a resolvable category (the confidence denominator). */
  readonly incumbentCount: number;
}

/**
 * The zone a keyword's SERP incumbents actually imply: the mode of their
 * mapped zones, with `confidence` = the mode's share of the resolvable
 * incumbents. Returns `null` — meaning "unclassified", which callers must
 * persist AS NULL and never substitute a default for — when:
 *
 *   - fewer than `ZONE_MIN_INCUMBENTS` of the supplied incumbents carry a
 *     category that maps to a known zone (including the "no incumbents at
 *     all" and "no genres recorded yet" cases), or
 *   - the mode's share is below `ZONE_MIN_CONFIDENCE`.
 *
 * Incumbents with a missing, blank or unmappable category are EXCLUDED from
 * both the tally and the denominator — they are not evidence for any zone, and
 * counting them against the mode would make coverage gaps look like
 * disagreement.
 *
 * Ties are broken by zone name ascending, so the result depends only on the
 * multiset of categories and not on incumbent order (a scan re-read in a
 * different order can never flip the stored zone). Pure — no I/O, no `Date`,
 * and `genres` is never mutated.
 */
export function deriveGenreZone(genres: readonly (string | null | undefined)[]): DerivedZone | null {
  const counts = new Map<string, number>();
  let resolvable = 0;

  for (const genre of genres) {
    if (genre === null || genre === undefined) continue;
    const zone = mapCategoryToZoneStrict(genre);
    if (zone === null) continue;
    resolvable++;
    counts.set(zone, (counts.get(zone) ?? 0) + 1);
  }

  if (resolvable < ZONE_MIN_INCUMBENTS) return null;

  let bestZone: string | null = null;
  let bestCount = 0;
  for (const [zone, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > bestCount) {
      bestZone = zone;
      bestCount = count;
    }
  }
  if (bestZone === null) return null;

  const confidence = bestCount / resolvable;
  if (confidence < ZONE_MIN_CONFIDENCE) return null;

  return { zone: bestZone, confidence, incumbentCount: resolvable };
}
