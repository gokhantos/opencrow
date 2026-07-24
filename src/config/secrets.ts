import { createLogger } from "../logger";

const log = createLogger("secrets");

/**
 * Retrieve a secret by key. Checks the DB secrets namespace first, then falls
 * back to the process environment. Returns undefined when neither source has a
 * value.
 *
 * Handles the case where the DB is not yet initialized: if `getOverride` throws
 * (e.g. because initDb() has not been called yet) we silently fall back to the
 * environment variable.
 */
/**
 * Max time to wait on the DB secrets lookup before falling back to env.
 *
 * The DB read is a best-effort optimization over the env fallback. A hung
 * query MUST NOT be able to hang the caller indefinitely: on 2026-07-24 a
 * `config_overrides` read for a Webshare proxy credential never returned under
 * the concurrent DB load the proxied App Store scan stream added, which wedged
 * every proxied request forever via the memoized `getAppstoreProxyUrl` (a
 * never-settling promise the whole lane awaited). The prior implementation
 * caught only THROWS, not never-settling promises. Env-sourced secrets (the
 * common case) resolve regardless of DB health once this timeout fires.
 */
const DB_LOOKUP_TIMEOUT_MS = 3_000;

export async function getSecret(key: string): Promise<string | undefined> {
  try {
    // Lazy import so that this module can be imported before initDb() is called
    // without triggering the "DB not initialized" error at import time.
    const { getOverride } = await import("../store/config-overrides");
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bound the DB read: a never-settling query falls through to env instead
    // of hanging the caller. Promise.race + a rejecting timer; the losing
    // getOverride promise is abandoned (its connection is returned by the pool
    // when it eventually settles) but never awaited.
    const dbValue = await Promise.race([
      getOverride("secrets", key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`getSecret DB lookup exceeded ${DB_LOOKUP_TIMEOUT_MS}ms`)),
          DB_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (dbValue !== null && typeof dbValue === "string" && dbValue !== "") {
      return dbValue;
    }
  } catch (err) {
    // DB not yet initialized, query failed, or timed out — fall through to env.
    log.debug("getSecret: DB lookup failed/timed out, using env fallback", { key, err });
  }

  return process.env[key] || undefined;
}
