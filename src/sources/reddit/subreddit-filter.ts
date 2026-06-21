/**
 * Subreddit filtering — allowlist (curated end-user/vertical-pain subs) and
 * denylist (AI-builder echo chamber + crypto) applied at ingestion time so
 * the reddit_posts corpus reflects real end-user pain rather than meta
 * discussions about building software.
 *
 * SSRF guard: subreddit names are validated to the safe character set
 * (alphanumeric + underscore) before they are interpolated into request URLs.
 * This module is the single choke-point; callers MUST validate through here.
 */

import { createLogger } from "../../logger";
import type { RedditCorpusConfig } from "../../config/schema";

const log = createLogger("reddit:subreddit-filter");

/**
 * Subreddit names may only contain letters, digits, and underscores — no
 * slashes, dots, percent-signs, or control characters. Reddit's own rules
 * are slightly more permissive (hyphens allowed) but we err conservative to
 * eliminate any ambiguity about URL injection.
 */
const SAFE_SUBREDDIT_RE = /^[A-Za-z0-9_]{1,50}$/;

/**
 * Validate that a subreddit name is safe to interpolate into a URL path.
 * Returns true if safe, false if the name would alter the URL structure.
 */
export function isSafeSubredditName(name: string): boolean {
  return SAFE_SUBREDDIT_RE.test(name);
}

/**
 * Filter and validate a list of subreddit names, dropping anything that fails
 * the safe-character check and logging a warning per dropped name.
 */
export function sanitizeSubredditList(names: readonly string[]): readonly string[] {
  const safe: string[] = [];
  for (const name of names) {
    if (isSafeSubredditName(name)) {
      safe.push(name);
    } else {
      log.warn("Dropping subreddit with unsafe name from list", { name });
    }
  }
  return safe;
}

/**
 * Returns true if the post's subreddit is on the denylist.
 * Comparison is case-insensitive so corpus variants like "ClaudeCode" and
 * "claudecode" are both caught.
 */
export function isDenylisted(subreddit: string, denylistLower: ReadonlySet<string>): boolean {
  return denylistLower.has(subreddit.toLowerCase());
}

/**
 * Build a lower-cased Set from a config denylist array for O(1) lookup.
 * Unsafe names are dropped (same guard as sanitizeSubredditList).
 */
export function buildDenylistSet(denylist: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const name of denylist) {
    if (isSafeSubredditName(name)) {
      set.add(name.toLowerCase());
    } else {
      log.warn("Dropping unsafe name from denylist", { name });
    }
  }
  return set;
}

/**
 * Resolve which subreddits to scrape given:
 *  - the curated allowlist from config (always scraped)
 *  - the account's subscribed list (only included when includeSubscriptions is true)
 *  - the denylist set (applied to ALL sources case-insensitively)
 *
 * Returns a readonly deduped list of safe, non-denylisted subreddit names.
 */
export function resolveSubredditsToScrape(
  config: RedditCorpusConfig,
  subscribedSubreddits: readonly string[],
): readonly string[] {
  const denylistSet = buildDenylistSet(config.denylist);

  // Start with the curated allowlist — always included
  const candidates = new Set<string>(sanitizeSubredditList(config.allowlist));

  // Optionally include the account's subscriptions (still filtered through denylist)
  if (config.includeSubscriptions) {
    for (const sub of sanitizeSubredditList(subscribedSubreddits)) {
      candidates.add(sub);
    }
  }

  // Apply denylist case-insensitively
  const result: string[] = [];
  for (const sub of candidates) {
    if (isDenylisted(sub, denylistSet)) {
      log.debug("Subreddit filtered by denylist", { sub });
    } else {
      result.push(sub);
    }
  }

  return result;
}

/**
 * Filter a list of already-fetched subreddit names through the denylist.
 * Used for the home feed (which returns posts with subreddit metadata) and
 * any other path where we receive the subreddit name post-fetch.
 */
export function filterByDenylist(
  subreddits: readonly string[],
  denylistSet: ReadonlySet<string>,
): readonly string[] {
  return subreddits.filter((sub) => !isDenylisted(sub, denylistSet));
}
