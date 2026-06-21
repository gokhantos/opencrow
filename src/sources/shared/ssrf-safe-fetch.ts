/**
 * ssrf-safe-fetch.ts — shared SSRF-prevention primitives for scrapers.
 *
 * Exports:
 *   isPrivateIp     — detect loopback / private / link-local / reserved IPs.
 *   validateUrl     — synchronous structural check (no DNS) for use in
 *                     deterministic contexts (redirect loops, scraper callsites).
 *   ssrfSafeFetch   — fetch helper that follows redirects MANUALLY, re-validating
 *                     each hop URL before connecting so redirect-to-private attacks
 *                     are blocked even after the initial check.
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
import { fetchWithTimeout } from "./fetch-with-timeout";

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

export interface SsrfSafeFetchOptions {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch `url` following redirects manually (redirect:"manual"), re-validating
 * each hop with validateUrl before connecting. This prevents open-redirect
 * attacks that bounce through a public URL to a private destination.
 *
 * Only GET requests are issued (for scraper use). If a redirect points to a
 * private address the fetch is aborted and an error thrown.
 *
 * Throws on network error, too many redirects, or SSRF rejection.
 * Returns the final Response on success.
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

    let response: Response;
    try {
      response = await fetchWithTimeout(
        currentUrl,
        {
          method: "GET",
          headers: opts.headers,
          redirect: "manual",
          signal: opts.signal,
        },
        timeoutMs,
      );
    } catch (err) {
      throw new Error(`Fetch error for ${currentUrl}: ${getErrorMessage(err)}`);
    }

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
