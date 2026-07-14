/**
 * client.ts — Apple Ads (Search Ads Campaign Management API v5) HTTP client:
 * ES256 client-secret signing, access-token exchange/cache, the generic
 * authenticated `callApi`, and `testConnection`.
 *
 * The EXPERIMENTAL searchPopularity probe lives in probe.ts (built on top of
 * this module's exports) — kept separate because it is speculative/
 * best-effort and pending live validation, while this module is the CERTAIN
 * substrate (verified against Apple's docs + cross-checked against a
 * third-party open-source v5 client for field-shape sanity).
 *
 * Auth contract:
 *   - Client secret = an ES256 JWT signed with the account's EC P-256
 *     private key: header {alg:"ES256", kid:<keyId>}, payload
 *     {sub:<clientId>, aud:"https://appleid.apple.com", iss:<teamId>,
 *     iat, exp}. Signed via `jose` (never hand-rolled — ES256's DER↔JOSE
 *     signature conversion is easy to get subtly wrong with raw
 *     node:crypto).
 *   - Token: POST https://appleid.apple.com/auth/oauth2/token, form-encoded
 *     grant_type=client_credentials & client_id & client_secret=<jwt> &
 *     scope=searchadsorg → {access_token, expires_in}. Cached in-process
 *     (keyed by clientId) until <60s from expiry.
 *   - Every API call: Authorization: Bearer <token> AND
 *     X-AP-Context: orgId=<orgId>, against https://api.searchads.apple.com/api/v5/.
 *
 * All outbound hosts are hardcoded (appleid.apple.com, api.searchads.apple.com)
 * — no caller-supplied host is ever fetched here. `fetch` is
 * dependency-injected (`ClientDeps.fetchFn`) so tests never touch the
 * network; production code defaults to `fetchWithTimeout`.
 */

import { importPKCS8, SignJWT } from "jose";
import { createLogger } from "../../../logger";
import { getErrorMessage } from "../../../lib/error-serialization";
import { fetchWithTimeout } from "../../shared/fetch-with-timeout";
import type { AppleAdsConnectionStatus, AppleAdsCreds } from "./types";

const log = createLogger("apple-ads-client");

const TOKEN_HOST = "appleid.apple.com";
const API_HOST = "api.searchads.apple.com";
const TOKEN_URL = `https://${TOKEN_HOST}/auth/oauth2/token`;
export const API_BASE = `https://${API_HOST}/api/v5`;
const AUDIENCE = "https://appleid.apple.com";

// Keep the assertion short-lived per the design spec (Apple allows up to
// 180 days; we deliberately use a much shorter window since a fresh JWT is
// cheap to mint and a short exp limits the blast radius of a leaked token).
const ASSERTION_LIFETIME_SECONDS = 60 * 60; // 1h
// Refresh the cached access token once fewer than this many seconds remain.
const TOKEN_REFRESH_SKEW_SECONDS = 60;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClientDeps {
  /** Injectable fetch. Defaults to fetchWithTimeout(url, init, 30_000). */
  readonly fetchFn?: FetchLike;
  /** Injectable clock (epoch seconds). Defaults to the real clock. */
  readonly nowSeconds?: () => number;
}

const defaultFetch: FetchLike = (url, init) => fetchWithTimeout(url, init, 30_000);

export function resolveDeps(
  deps: ClientDeps | undefined,
): { fetchFn: FetchLike; nowSeconds: () => number } {
  return {
    fetchFn: deps?.fetchFn ?? defaultFetch,
    nowSeconds: deps?.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
  };
}

/** True if `hostname` is apple.com or a subdomain of it. */
export function isAppleHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "apple.com" || lower.endsWith(".apple.com");
}

// ---------------------------------------------------------------------------
// JWT client-secret signing
// ---------------------------------------------------------------------------

/**
 * Sign the ES256 client-secret JWT Apple's token endpoint expects.
 * `nowSeconds` is injectable for deterministic tests.
 */
export async function signClientSecret(
  creds: AppleAdsCreds,
  nowSeconds?: number,
): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  let key: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    key = await importPKCS8(creds.privateKey, "ES256");
  } catch (err) {
    // Never include the key material itself in the error.
    throw new Error(
      `Apple Ads: failed to parse EC private key (expected PKCS8 PEM, "-----BEGIN PRIVATE KEY-----"): ${getErrorMessage(err)}`,
    );
  }

  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: creds.keyId, typ: "JWT" })
    .setIssuer(creds.teamId)
    .setSubject(creds.clientId)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ASSERTION_LIFETIME_SECONDS)
    .sign(key);
}

// ---------------------------------------------------------------------------
// Access-token exchange + in-memory cache
// ---------------------------------------------------------------------------

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number; // epoch seconds
}

// Module-level cache keyed by clientId. This process (the web/API process,
// not a scraper child) is the only thing that calls this client, so an
// in-memory cache here does not violate scraper process-isolation — it is
// simply request-coalescing for a single long-lived process.
const tokenCache = new Map<string, CachedToken>();

interface TokenResponseBody {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
}

async function exchangeToken(
  creds: AppleAdsCreds,
  deps: { fetchFn: FetchLike; nowSeconds: () => number },
): Promise<CachedToken> {
  const now = deps.nowSeconds();
  const assertion = await signClientSecret(creds, now);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: assertion,
    scope: "searchadsorg",
  });

  let response: Response;
  try {
    response = await deps.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
  } catch (err) {
    log.error("Apple Ads token exchange: network error", { err: getErrorMessage(err) });
    throw new Error(`Apple Ads token exchange failed (network error): ${getErrorMessage(err)}`);
  }

  const text = await response.text();
  let parsed: TokenResponseBody = {};
  try {
    parsed = text ? (JSON.parse(text) as TokenResponseBody) : {};
  } catch {
    // fall through — treated as a malformed response below
  }

  if (!response.ok) {
    const reason = parsed.error
      ? `${parsed.error}${parsed.error_description ? `: ${parsed.error_description}` : ""}`
      : `HTTP ${response.status}`;
    log.error("Apple Ads token exchange failed", { status: response.status, reason });
    throw new Error(`Apple Ads token exchange failed: ${reason}`);
  }

  if (!parsed.access_token || typeof parsed.expires_in !== "number") {
    throw new Error("Apple Ads token exchange: response missing access_token/expires_in");
  }

  return {
    accessToken: parsed.access_token,
    expiresAt: now + parsed.expires_in - TOKEN_REFRESH_SKEW_SECONDS,
  };
}

/**
 * Get a valid access token, refreshing when the cached one is within
 * TOKEN_REFRESH_SKEW_SECONDS of expiry. Cached in-memory, keyed by clientId.
 */
export async function getAccessToken(creds: AppleAdsCreds, deps: ClientDeps = {}): Promise<string> {
  const resolved = resolveDeps(deps);
  const now = resolved.nowSeconds();
  const cached = tokenCache.get(creds.clientId);
  if (cached && cached.expiresAt > now) {
    return cached.accessToken;
  }

  const fresh = await exchangeToken(creds, resolved);
  tokenCache.set(creds.clientId, fresh);
  return fresh.accessToken;
}

/** Clear the cached token for a clientId (e.g. after a 401). Test/ops hook. */
export function invalidateAccessToken(clientId: string): void {
  tokenCache.delete(clientId);
}

// ---------------------------------------------------------------------------
// Generic authenticated API call
// ---------------------------------------------------------------------------

export interface CallApiOptions {
  readonly token: string;
  readonly orgId: string;
  readonly deps?: ClientDeps;
  readonly init?: Omit<RequestInit, "headers"> & { readonly headers?: Record<string, string> };
}

/** Call `${API_BASE}${path}` with Bearer + X-AP-Context headers attached. */
export async function callApi(path: string, opts: CallApiOptions): Promise<Response> {
  const { fetchFn } = resolveDeps(opts.deps);
  const url = `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  return fetchFn(url, {
    ...opts.init,
    headers: {
      ...opts.init?.headers,
      Authorization: `Bearer ${opts.token}`,
      "X-AP-Context": `orgId=${opts.orgId}`,
    },
  });
}

export async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 512);
  } catch {
    return "<unreadable body>";
  }
}

// ---------------------------------------------------------------------------
// testConnection — verify creds + org access
// ---------------------------------------------------------------------------

interface AclsEntry {
  readonly orgId?: number | string;
  readonly orgName?: string;
}
interface AclsEnvelope {
  readonly data?: readonly AclsEntry[];
}

function extractOrgName(body: unknown, orgId: string): string | undefined {
  const envelope = body as AclsEnvelope | undefined;
  const entries = Array.isArray(envelope?.data) ? envelope.data : [];
  const match = entries.find((entry) => String(entry.orgId) === orgId);
  return match?.orgName ?? entries[0]?.orgName;
}

/**
 * GET /api/v5/acls — the lightest authenticated call available; used purely
 * to verify the creds + org access work end-to-end. Never returns secrets.
 */
export async function testConnection(
  creds: AppleAdsCreds,
  deps: ClientDeps = {},
): Promise<AppleAdsConnectionStatus> {
  try {
    const token = await getAccessToken(creds, deps);
    const response = await callApi("/acls", { token, orgId: creds.orgId, deps });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      return {
        ok: false,
        error: `Apple Ads API returned ${response.status}: ${bodyText}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: true }; // 2xx with a non-JSON body — still treat as reachable.
    }

    return { ok: true, orgName: extractOrgName(body, creds.orgId) };
  } catch (err) {
    log.warn("Apple Ads testConnection failed", { err: getErrorMessage(err) });
    return { ok: false, error: getErrorMessage(err) };
  }
}
