/**
 * appstore-proxy.ts — Webshare rotating-proxy URL resolution for the App
 * Store scraper's outbound fetches (throughput wave, item 1).
 *
 * Ported from Chartera's `pipeline/shared/http-dispatcher.ts` dispatcher
 * pattern, adapted to this codebase's conventions: credential reads go
 * through `getSecret()` (DB `secrets` namespace first, `process.env`
 * fallback — see `src/config/secrets.ts`) rather than a bespoke config
 * loader, mirroring `appstore/apple-ads/config.ts`'s
 * `getAppleAdsCredentials()` (same all-or-nothing gate, same injectable
 * `SecretReader` seam for tests).
 *
 * Env var names are FIXED (already deployed to `~/opencrow-run/.env` — see
 * the 2026-07-21 throughput-wave design note): `OPENCROW_APPSTORE_PROXY_ENABLED`,
 * `WEBSHARE_PROXY_HOST`, `WEBSHARE_PROXY_PORT`, `WEBSHARE_PROXY_USER`,
 * `WEBSHARE_PROXY_PASS`. Credential VALUES are never logged — only presence
 * booleans (see `getAppstoreProxyStatus`).
 *
 * Bun's native `fetch()` accepts a `proxy: "<url>"` string option directly
 * (verified against Bun's docs: username/password embedded in the URL,
 * `http://` or `https://` proxy protocol) — no `undici`/`ProxyAgent`
 * dependency needed, unlike Chartera's Node-runtime dispatcher. The
 * resolved URL from this module is passed straight through as that string.
 */

import { getSecret } from "../../config/secrets";
import { createLogger } from "../../logger";

const log = createLogger("appstore-proxy");

const ENV_KEYS = {
  enabled: "OPENCROW_APPSTORE_PROXY_ENABLED",
  host: "WEBSHARE_PROXY_HOST",
  port: "WEBSHARE_PROXY_PORT",
  user: "WEBSHARE_PROXY_USER",
  pass: "WEBSHARE_PROXY_PASS",
} as const;

/** Injectable secret reader so tests never touch the DB/env — mirrors `apple-ads/config.ts`'s `SecretReader`. */
export type SecretReader = (key: string) => Promise<string | undefined>;

export interface AppstoreProxyCredentials {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly pass: string;
}

/**
 * True iff `raw` (an env/secret string value) reads as an enabled flag.
 * Accepts `"true"`/`"1"` (case-insensitive on the former) — matches the
 * loose boolean-from-string parsing convention used for env-sourced flags
 * elsewhere in the codebase.
 */
export function isProxyEnabledValue(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/** Pure URL builder — encodes user/pass so special characters in Webshare credentials can't break the URL. Injectable/testable without any env/DB access. */
export function buildProxyUrl(creds: AppstoreProxyCredentials): string {
  return `http://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.pass)}@${creds.host}:${creds.port}`;
}

/**
 * Resolves the four Webshare credentials + the enable flag via `readSecret`
 * (defaults to `getSecret`) and builds the proxy URL. Returns `undefined`
 * (graceful direct-fetch fallback) when the flag is off OR any credential
 * is missing — an operator can therefore stage credentials ahead of
 * flipping the flag with zero risk of a half-configured proxy URL being
 * built. Never throws.
 */
export async function resolveAppstoreProxyUrl(
  readSecret: SecretReader = getSecret,
): Promise<string | undefined> {
  const enabledRaw = await readSecret(ENV_KEYS.enabled);
  if (!isProxyEnabledValue(enabledRaw)) {
    return undefined;
  }

  const [host, port, user, pass] = await Promise.all([
    readSecret(ENV_KEYS.host),
    readSecret(ENV_KEYS.port),
    readSecret(ENV_KEYS.user),
    readSecret(ENV_KEYS.pass),
  ]);

  if (!host || !port || !user || !pass) {
    log.warn(
      "Webshare proxy enabled but one or more credentials are missing — falling back to direct fetch",
      { hostSet: !!host, portSet: !!port, userSet: !!user, passSet: !!pass },
    );
    return undefined;
  }

  return buildProxyUrl({ host, port, user, pass });
}

// Mutable by design: memoized singleton, mirroring Chartera's
// `http-dispatcher.ts` `_dispatcher`/`_initialised` pair — resolved at most
// once per process (credentials/flag don't change at runtime), reset via
// `__resetAppstoreProxyCache()` in tests.
let cachedProxyUrlPromise: Promise<string | undefined> | undefined;

/**
 * Memoized accessor — safe to call on every request (the underlying
 * `resolveAppstoreProxyUrl` only actually runs once per process). Logs
 * once, on first resolution, whether the proxy is active (never the URL/
 * credential values themselves).
 */
export function getAppstoreProxyUrl(
  readSecret: SecretReader = getSecret,
): Promise<string | undefined> {
  if (!cachedProxyUrlPromise) {
    cachedProxyUrlPromise = resolveAppstoreProxyUrl(readSecret).then((url) => {
      log.info("Webshare proxy resolution complete", { proxyActive: url !== undefined });
      return url;
    });
  }
  return cachedProxyUrlPromise;
}

/** Test-only reset of the memoized proxy URL. */
export function __resetAppstoreProxyCache(): void {
  cachedProxyUrlPromise = undefined;
}

export interface AppstoreProxyStatus {
  readonly enabledFlagSet: boolean;
  readonly hostSet: boolean;
  readonly portSet: boolean;
  readonly userSet: boolean;
  readonly passSet: boolean;
  readonly active: boolean;
}

/** Per-key presence booleans (never values) — for a status/health surface. */
export async function getAppstoreProxyStatus(
  readSecret: SecretReader = getSecret,
): Promise<AppstoreProxyStatus> {
  const [enabledRaw, host, port, user, pass] = await Promise.all([
    readSecret(ENV_KEYS.enabled),
    readSecret(ENV_KEYS.host),
    readSecret(ENV_KEYS.port),
    readSecret(ENV_KEYS.user),
    readSecret(ENV_KEYS.pass),
  ]);
  const enabledFlagSet = isProxyEnabledValue(enabledRaw);
  const hostSet = !!host;
  const portSet = !!port;
  const userSet = !!user;
  const passSet = !!pass;
  return {
    enabledFlagSet,
    hostSet,
    portSet,
    userSet,
    passSet,
    active: enabledFlagSet && hostSet && portSet && userSet && passSet,
  };
}

export { ENV_KEYS as APPSTORE_PROXY_ENV_KEYS };
