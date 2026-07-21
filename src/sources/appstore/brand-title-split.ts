// Pure "Brand Name<sep>Description" App Store title splitting — no I/O, no
// dependency on any store/DB module. Deliberately standalone (NOT folded
// into `keyword-miner.ts`, which owns it conceptually) so `keyword-brand.ts`
// (Batch A budget rescue, 2026-07-22) can reuse it WITHOUT transitively
// pulling in `keyword-miner.ts`'s own `./keyword-store` imports
// (`getScannedAppNames`/`keywordsExist`/`upsertKeywords`) — a real problem in
// practice: `keyword-gaps.ts` and `keyword-autocomplete.ts` both import
// `keyword-brand.ts`, and their own `*.isolated.test.ts` files mock
// `./keyword-store` with only the exports THEY need; a transitive pull-in of
// `keyword-miner.ts`'s unrelated store exports would make those mocks
// silently incomplete (a hard ESM "export not found" SyntaxError) for a
// reason with no connection to what the test is actually exercising.
// `keyword-miner.ts` re-exports `stripBrandPrefix` from here so its own
// behavior is unchanged.

/** Separators that typically split "Brand Name" from a descriptive suffix in App Store titles. */
const BRAND_SEPARATORS: readonly RegExp[] = [/:/, / - /, / – /, / \| /];

interface BrandSplit {
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * Finds the EARLIEST occurrence of any `BRAND_SEPARATORS` in `name` and
 * splits on it — colon, " - ", " – ", " | ", all common "brand: description"
 * App Store title conventions. Returns `null` when no separator is found.
 * Shared core for `stripBrandPrefix` (keeps the suffix) and `extractBrandPrefix`
 * (keeps the prefix) so the two never drift out of sync on what counts as a
 * separator.
 */
function splitAtEarliestBrandSeparator(name: string): BrandSplit | null {
  let earliestIndex = -1;
  let matchedLength = 0;

  for (const sep of BRAND_SEPARATORS) {
    const match = sep.exec(name);
    if (match && (earliestIndex === -1 || match.index < earliestIndex)) {
      earliestIndex = match.index;
      matchedLength = match[0].length;
    }
  }

  if (earliestIndex === -1) return null;
  return {
    prefix: name.slice(0, earliestIndex).trim(),
    suffix: name.slice(earliestIndex + matchedLength).trim(),
  };
}

/**
 * Strips a leading "Brand Name<sep>" prefix from an App Store title, e.g.
 * `"MyFitnessPal: Calorie Counter"` -> `"Calorie Counter"`. Returns the
 * original name unchanged if no separator is found, or if the text after
 * the separator is empty (defensive — never returns an empty string when
 * the input wasn't empty).
 */
export function stripBrandPrefix(name: string): string {
  const split = splitAtEarliestBrandSeparator(name);
  if (!split) return name;
  return split.suffix.length > 0 ? split.suffix : name;
}

/**
 * The inverse of `stripBrandPrefix`: returns the "Brand Name" PREFIX a real
 * App Store title carries before its earliest separator (e.g.
 * `"MyFitnessPal: Calorie Counter"` -> `"MyFitnessPal"`), or `null` when the
 * title has no separator or the prefix is empty. Consumed by
 * `keyword-brand.ts`'s insert-time brand-segment filter (Batch A budget
 * rescue, 2026-07-22) — building a set of known brand names from real,
 * already-scraped app titles (`getScannedAppNames`) so an autocomplete hint
 * that IS one of those brand names (no separator of its own — e.g. a bare
 * "duolingo" hint) can also be recognized, not just hints that already
 * contain a separator themselves (see `hasBrandSeparator`).
 */
export function extractBrandPrefix(name: string): string | null {
  const split = splitAtEarliestBrandSeparator(name);
  if (!split || split.prefix.length === 0) return null;
  return split.prefix;
}

/**
 * True iff `text` itself contains one of `BRAND_SEPARATORS` — i.e. looks
 * like a full "Brand: description" App Store title rather than a bare
 * search phrase. Consumed by `keyword-brand.ts`'s insert-time filter:
 * sampled autocomplete brand hints are overwhelmingly full titles with
 * subtitles (e.g. "duolingo: language lessons"), so this single check
 * catches the large majority on its own.
 */
export function hasBrandSeparator(text: string): boolean {
  return BRAND_SEPARATORS.some((sep) => sep.test(text));
}
