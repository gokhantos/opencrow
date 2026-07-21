/**
 * ssrf-safe-fetch.ts — shared SSRF-prevention primitives for scrapers.
 *
 * Exports:
 *   isPrivateIp     — detect loopback / private / link-local / reserved IPs.
 *   validateUrl     — synchronous structural check (no DNS) for use in
 *                     deterministic contexts (redirect loops, scraper callsites).
 *   ssrfSafeFetch   — fetch helper that follows redirects MANUALLY, re-validating
 *                     each hop URL before connecting so redirect-to-private attacks
 *                     are blocked even after the initial check. Optionally retries
 *                     rate-limit-shaped responses (429/503/403+Retry-After) with
 *                     backoff via `retryOnRateLimit` — see SsrfSafeFetchOptions.
 *   RateLimitError  — re-exported from ./rate-limit-error; thrown by ssrfSafeFetch
 *                     when rate-limit retries are exhausted. Detect via
 *                     `err instanceof RateLimitError` or `err.code === "RATE_LIMITED"`.
 *
 * Proxy (throughput wave, item 1): `SsrfSafeFetchOptions.useProxy` opts a
 * single call into the Webshare rotating proxy (see `appstore-proxy.ts`, a
 * sibling module this one consumes). Default false for every caller across
 * every source; App Store lanes each carry their own config flag. SSRF
 * validation of the TARGET url is unaffected either way.
 *
 * Design rationale:
 *   Agent-supplied URL fetching goes through the SDK-native WebFetch tool, which
 *   performs its own DNS-resolving validation. Scrapers, by contrast, work with
 *   known-origin URLs (HN story URLs, news article URLs) where DNS resolution
 *   is impractical at scrape time (high volume, no retry budget). The sync check
 *   here blocks the obvious class: explicit IP literals, localhost, and reserved
 *   ranges. It does NOT replace DNS-TOCTOU mitigation — scrapers should only
 *   fetch URLs from trusted upstream APIs (Firebase, Reddit JSON) and treat the
 *   URL itself as potentially attacker-controlled only for meta-description or
 *   article-body extraction (where the URL came from scraped content).
 */

import { getErrorMessage } from "../../lib/error-serialization";
import { retryAsync } from "../../infra/retry";
import { getAppstoreProxyUrl } from "./appstore-proxy";
import { fetchWithTimeout } from "./fetch-with-timeout";
import { RateLimitError, isRateLimitStatus, parseRetryAfterMs } from "./rate-limit-error";

export { RateLimitError } from "./rate-limit-error";

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

function parseIpv4Octets(ip: string): readonly number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
  return octets;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  if (octets.length < 2) return false;
  const a = octets[0]!;
  const b = octets[1]!;

  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / AWS metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT/Tailscale
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved

  return false;
}

/**
 * Returns true if `ip` resolves to a loopback, private, link-local, CGNAT,
 * multicast, or otherwise reserved address. Handles IPv4, IPv6, and
 * IPv4-mapped / IPv4-compatible IPv6 addresses.
 */
export function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();
  const bare = normalized.split("%")[0] ?? normalized; // strip zone id

  // IPv4-mapped / IPv4-compatible IPv6 (::ffff:a.b.c.d or ::a.b.c.d)
  const mappedV4 = bare.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedV4) {
    const octets = parseIpv4Octets(mappedV4[1]!);
    return octets ? isPrivateIpv4(octets) : true;
  }

  // IPv4-mapped IPv6 in hex form (::ffff:7f00:1 == 127.0.0.1)
  const mappedHex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    return isPrivateIpv4(octets);
  }

  // Pure IPv6
  if (bare.includes(":")) {
    if (bare === "::1" || bare === "::") return true; // loopback / unspecified
    if (bare.startsWith("fc") || bare.startsWith("fd")) return true; // fc00::/7 ULA
    if (bare.startsWith("fe80")) return true; // link-local
    if (
      bare.startsWith("fe9") ||
      bare.startsWith("fea") ||
      bare.startsWith("feb")
    ) {
      return true; // remainder of fe80::/10
    }
    if (bare.startsWith("ff")) return true; // ff00::/8 multicast
    return false;
  }

  // Plain IPv4
  const octets = parseIpv4Octets(bare);
  if (!octets) return false;
  return isPrivateIpv4(octets);
}

// ---------------------------------------------------------------------------
// URL validation (synchronous — no DNS)
// ---------------------------------------------------------------------------

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true; // IPv6 (including brackets stripped by caller)
  return parseIpv4Octets(host) !== null;
}

/**
 * Validate a URL for SSRF safety using only structural / lexical checks —
 * no DNS resolution. Rejects non-http(s) protocols, localhost, embedded
 * credentials, and any literal IP that maps to a private/reserved range.
 *
 * Returns an error string on rejection, or null on acceptance.
 *
 * NOTE: This does not protect against DNS rebinding (a hostname that initially
 * resolves to a public IP then switches to a private one). Agent-supplied URLs
 * are fetched via the SDK-native WebFetch tool, which resolves DNS. Use this
 * function only inside redirect-follow loops or for high-volume scraper URLs
 * where DNS resolution per hop is impractical.
 */
export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: ${url}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Rejected protocol ${parsed.protocol} — only http/https allowed.`;
  }

  const hostname = parsed.hostname;
  const lowerHost = hostname.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost")) {
    return "Rejected: localhost is not allowed.";
  }

  // Reject URLs with embedded credentials (SSRF via auth-confused proxies)
  if (parsed.username !== "" || parsed.password !== "") {
    return "Rejected: embedded credentials in URL are not allowed.";
  }

  const literalIp =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  if (isIpLiteral(literalIp)) {
    if (isPrivateIp(literalIp)) {
      return `Rejected: ${literalIp} is a private/reserved address.`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Redirect-aware safe fetch
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

// Rate-limit backoff defaults — deliberately small: this guards a shared
// upstream (iTunes/search-suggest) that scrapers hit on a tight cycle, so
// retries must stay cheap rather than pile up latency.
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 3; // + the initial try = 4 attempts
const DEFAULT_RATE_LIMIT_MIN_DELAY_MS = 500;
const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 8_000;
const DEFAULT_RATE_LIMIT_MAX_TOTAL_WAIT_MS = 20_000;

export interface SsrfSafeFetchOptions {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Opt in to rate-limit-aware retry: when a response is 429/503 (or 403
   * with a `Retry-After` header — see `isRateLimitStatus`), retry with
   * exponential backoff + jitter, honoring `Retry-After` (seconds or
   * HTTP-date) when present. Default `false` — existing callers keep
   * today's behavior of returning non-ok responses as-is with no retry.
   * On exhausting retries (or if `Retry-After` pushes past
   * `maxTotalWaitMs`), throws `RateLimitError` instead of returning the
   * response, so callers can special-case it (`err instanceof RateLimitError`
   * or `err.code === "RATE_LIMITED"`).
   */
  readonly retryOnRateLimit?: boolean;
  /** Max retry attempts after the initial try. Default 3 (4 total tries). */
  readonly maxRetries?: number;
  /** Backoff delay bounds in ms for computed (non-`Retry-After`) waits. */
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Stop retrying once cumulative backoff wait would exceed this. Default 20_000. */
  readonly maxTotalWaitMs?: number;
  /**
   * Opt in to routing this fetch through the Webshare rotating proxy
   * (throughput wave, item 1 — see `appstore-proxy.ts`). Default `false`
   * (direct fetch) — every existing caller across every source (HN, Reddit,
   * GitHub, news, ...) is unaffected. Callers set this from their OWN
   * lane's config flag (e.g. `appstoreAppPages.useProxy`), never hardcoded,
   * so an operator can flip proxy usage per-lane without a code change.
   * Gracefully falls back to a direct fetch when the proxy is unconfigured
   * (`getAppstoreProxyUrl()` resolves to `undefined`) even if this is
   * `true` — never throws for a missing/incomplete proxy configuration.
   * The TARGET url is still validated for SSRF regardless of this flag —
   * routing through a proxy never bypasses `validateUrl`.
   */
  readonly useProxy?: boolean;
}

async function fetchOnce(
  url: string,
  opts: SsrfSafeFetchOptions,
  timeoutMs: number,
): Promise<Response> {
  try {
    const proxy = opts.useProxy ? await getAppstoreProxyUrl() : undefined;
    return await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: opts.headers,
        redirect: "manual",
        signal: opts.signal,
        ...(proxy ? { proxy } : {}),
      },
      timeoutMs,
    );
  } catch (err) {
    throw new Error(`Fetch error for ${url}: ${getErrorMessage(err)}`);
  }
}

/**
 * Perform (and, when opted in, rate-limit-retry) a single hop's fetch.
 * Re-validates the URL for SSRF safety on every attempt — including
 * retries — so a retried request can never skip the guard.
 */
async function fetchHop(
  url: string,
  opts: SsrfSafeFetchOptions,
  timeoutMs: number,
): Promise<Response> {
  if (!opts.retryOnRateLimit) {
    return fetchOnce(url, opts, timeoutMs);
  }

  const maxRetries = opts.maxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const minDelayMs = opts.minDelayMs ?? DEFAULT_RATE_LIMIT_MIN_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_RATE_LIMIT_MAX_DELAY_MS;
  const maxTotalWaitMs = opts.maxTotalWaitMs ?? DEFAULT_RATE_LIMIT_MAX_TOTAL_WAIT_MS;
  let elapsedWaitMs = 0;

  return retryAsync(
    async () => {
      const rejection = validateUrl(url);
      if (rejection) {
        throw new Error(`SSRF blocked: ${rejection}`);
      }

      const response = await fetchOnce(url, opts, timeoutMs);
      const retryAfterHeader = response.headers.get("retry-after");
      if (isRateLimitStatus(response.status, retryAfterHeader)) {
        throw new RateLimitError(
          `Rate limited (HTTP ${response.status}) fetching ${url}`,
          response.status,
          parseRetryAfterMs(retryAfterHeader),
        );
      }
      return response;
    },
    {
      attempts: maxRetries + 1,
      minDelayMs,
      maxDelayMs,
      signal: opts.signal,
      label: "ssrfSafeFetch:rateLimit",
      shouldRetry: (err) => err instanceof RateLimitError && elapsedWaitMs < maxTotalWaitMs,
      retryAfterMs: (err) => (err instanceof RateLimitError ? err.retryAfterMs : undefined),
      onRetry: (info) => {
        elapsedWaitMs += info.delayMs;
      },
    },
  );
}

/**
 * Fetch `url` following redirects manually (redirect:"manual"), re-validating
 * each hop with validateUrl before connecting. This prevents open-redirect
 * attacks that bounce through a public URL to a private destination.
 *
 * Only GET requests are issued (for scraper use). If a redirect points to a
 * private address the fetch is aborted and an error thrown.
 *
 * Throws on network error, too many redirects, SSRF rejection, or (when
 * `retryOnRateLimit` is set) an exhausted rate-limit backoff — see
 * `SsrfSafeFetchOptions.retryOnRateLimit`. Returns the final Response on
 * success (including non-ok statuses that aren't rate-limit-retried, to
 * preserve existing caller behavior).
 */
export async function ssrfSafeFetch(
  url: string,
  opts: SsrfSafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const rejection = validateUrl(currentUrl);
    if (rejection) {
      throw new Error(`SSRF blocked: ${rejection}`);
    }

    const response = await fetchHop(currentUrl, opts, timeoutMs);

    const status = response.status;
    if (status < 300 || status >= 400) {
      return response;
    }

    // Follow redirect
    const location = response.headers.get("location");
    if (!location) {
      return response; // redirect with no Location — treat as final
    }

    // Resolve relative redirects against the current URL
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`Invalid redirect Location header: ${location}`);
    }
  }

  throw new Error(`Too many redirects (max ${MAX_REDIRECTS}).`);
}
