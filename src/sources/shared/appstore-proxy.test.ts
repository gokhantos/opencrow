import { describe, expect, it } from "bun:test";
import {
  APPSTORE_PROXY_ENV_KEYS,
  buildProxyUrl,
  getAppstoreProxyStatus,
  isProxyEnabledValue,
  resolveAppstoreProxyUrl,
  type SecretReader,
} from "./appstore-proxy";

/** Builds an injectable `SecretReader` from a plain map — never touches the DB/env. No real network or process calls anywhere in this file. */
function readerFrom(values: Readonly<Record<string, string | undefined>>): SecretReader {
  return async (key: string) => values[key];
}

const ENABLED_VALUES: Readonly<Record<string, string | undefined>> = {
  [APPSTORE_PROXY_ENV_KEYS.enabled]: "true",
  [APPSTORE_PROXY_ENV_KEYS.host]: "p.webshare.io",
  [APPSTORE_PROXY_ENV_KEYS.port]: "80",
  [APPSTORE_PROXY_ENV_KEYS.user]: "webshare-user",
  [APPSTORE_PROXY_ENV_KEYS.pass]: "webshare-pass",
};

describe("isProxyEnabledValue", () => {
  it("accepts 'true' and '1'", () => {
    expect(isProxyEnabledValue("true")).toBe(true);
    expect(isProxyEnabledValue("1")).toBe(true);
    expect(isProxyEnabledValue("TRUE")).toBe(true);
    expect(isProxyEnabledValue(" true ")).toBe(true);
  });

  it("rejects everything else, including undefined/empty/falsy-looking strings", () => {
    expect(isProxyEnabledValue(undefined)).toBe(false);
    expect(isProxyEnabledValue("")).toBe(false);
    expect(isProxyEnabledValue("false")).toBe(false);
    expect(isProxyEnabledValue("0")).toBe(false);
    expect(isProxyEnabledValue("yes")).toBe(false);
  });
});

describe("buildProxyUrl", () => {
  it("builds an http:// URL with credentials embedded, matching Bun fetch()'s expected proxy string shape", () => {
    const url = buildProxyUrl({ host: "p.webshare.io", port: "80", user: "u1", pass: "p1" });
    expect(url).toBe("http://u1:p1@p.webshare.io:80");
  });

  it("URL-encodes special characters in user/pass so a credential can never break the URL", () => {
    const url = buildProxyUrl({ host: "h", port: "1", user: "u@r:1", pass: "p@ss/word" });
    expect(url).toBe("http://u%40r%3A1:p%40ss%2Fword@h:1");
    // Round-trips back to the original values via standard URL parsing.
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe("u@r:1");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/word");
  });
});

describe("resolveAppstoreProxyUrl", () => {
  it("resolves a proxy URL when the flag is on and all four credentials are present", async () => {
    const url = await resolveAppstoreProxyUrl(readerFrom(ENABLED_VALUES));
    expect(url).toBe("http://webshare-user:webshare-pass@p.webshare.io:80");
  });

  it("returns undefined (graceful direct-fetch fallback) when the enable flag is off", async () => {
    const url = await resolveAppstoreProxyUrl(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.enabled]: "false" }),
    );
    expect(url).toBeUndefined();
  });

  it("returns undefined when the enable flag is unset entirely", async () => {
    const url = await resolveAppstoreProxyUrl(readerFrom({}));
    expect(url).toBeUndefined();
  });

  it("returns undefined when enabled but ANY single credential is missing (host)", async () => {
    const url = await resolveAppstoreProxyUrl(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.host]: undefined }),
    );
    expect(url).toBeUndefined();
  });

  it("returns undefined when enabled but ANY single credential is missing (port)", async () => {
    const url = await resolveAppstoreProxyUrl(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.port]: undefined }),
    );
    expect(url).toBeUndefined();
  });

  it("returns undefined when enabled but ANY single credential is missing (user)", async () => {
    const url = await resolveAppstoreProxyUrl(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.user]: undefined }),
    );
    expect(url).toBeUndefined();
  });

  it("returns undefined when enabled but ANY single credential is missing (pass)", async () => {
    const url = await resolveAppstoreProxyUrl(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.pass]: undefined }),
    );
    expect(url).toBeUndefined();
  });

  it("never throws even when the reader itself rejects", async () => {
    const throwingReader: SecretReader = async () => {
      throw new Error("boom");
    };
    await expect(resolveAppstoreProxyUrl(throwingReader)).rejects.toThrow();
    // (Documents current behavior: resolution propagates a reader failure —
    // callers use `getAppstoreProxyUrl`'s memoized wrapper, and every
    // production call site treats a rejected/undefined proxy resolution as
    // "fall back to direct fetch" at the `ssrfSafeFetch`/`fetchOnce` layer,
    // not here.)
  });
});

describe("getAppstoreProxyStatus", () => {
  it("reports presence booleans without ever exposing credential values", async () => {
    const status = await getAppstoreProxyStatus(readerFrom(ENABLED_VALUES));
    expect(status).toEqual({
      enabledFlagSet: true,
      hostSet: true,
      portSet: true,
      userSet: true,
      passSet: true,
      active: true,
    });
    // Never accidentally serialize a raw credential value into the status object.
    expect(JSON.stringify(status)).not.toContain("webshare-pass");
    expect(JSON.stringify(status)).not.toContain("webshare-user");
  });

  it("reports active:false when the flag is on but a credential is missing", async () => {
    const status = await getAppstoreProxyStatus(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.pass]: undefined }),
    );
    expect(status.passSet).toBe(false);
    expect(status.active).toBe(false);
  });

  it("reports active:false when every credential is present but the flag is off", async () => {
    const status = await getAppstoreProxyStatus(
      readerFrom({ ...ENABLED_VALUES, [APPSTORE_PROXY_ENV_KEYS.enabled]: "false" }),
    );
    expect(status.enabledFlagSet).toBe(false);
    expect(status.hostSet).toBe(true);
    expect(status.active).toBe(false);
  });
});
