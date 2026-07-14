/**
 * Unit tests for client.ts — signClientSecret, getAccessToken (+ cache/
 * refresh), callApi, and testConnection. `fetch` and the clock are always
 * dependency-injected; no live network is ever touched.
 * Lane: *.test.ts — `bun run test:unit`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { jwtVerify, decodeProtectedHeader, importSPKI } from "jose";
import {
  signClientSecret,
  getAccessToken,
  invalidateAccessToken,
  callApi,
  testConnection,
  isAppleHost,
} from "./client";
import type { AppleAdsCreds } from "./types";

// Generate a real EC P-256 keypair once — signClientSecret needs a
// structurally valid PKCS8 PEM to sign against.
const { privateKey: privateKeyObj, publicKey: publicKeyObj } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const PRIVATE_KEY_PEM = privateKeyObj.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_KEY_PEM = publicKeyObj.export({ type: "spki", format: "pem" }).toString();

const CREDS: AppleAdsCreds = {
  clientId: "SEARCHADS.test-client",
  teamId: "TEAMID123",
  keyId: "KEYID456",
  orgId: "998877",
  privateKey: PRIVATE_KEY_PEM,
};

describe("signClientSecret", () => {
  it("produces a JWT with the expected ES256 header", async () => {
    const jwt = await signClientSecret(CREDS, 1_700_000_000);
    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(CREDS.keyId);
  });

  it("produces claims matching the Apple auth contract", async () => {
    const now = 1_700_000_000;
    const jwt = await signClientSecret(CREDS, now);
    const publicKey = await importSPKI(PUBLIC_KEY_PEM, "ES256");
    const { payload } = await jwtVerify(jwt, publicKey, {
      audience: "https://appleid.apple.com",
      currentDate: new Date(now * 1000),
    });
    expect(payload.sub).toBe(CREDS.clientId);
    expect(payload.iss).toBe(CREDS.teamId);
    expect(payload.iat).toBe(now);
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp as number).toBeGreaterThan(payload.iat as number);
    // Design spec caps at 180 days; our default is a much shorter 1h window.
    expect((payload.exp as number) - now).toBeLessThanOrEqual(60 * 60 * 24 * 180);
  });

  it("rejects a malformed private key with a clear error, never leaking key material", async () => {
    const badCreds: AppleAdsCreds = { ...CREDS, privateKey: "not a pem" };
    await expect(signClientSecret(badCreds, 1_700_000_000)).rejects.toThrow(
      /failed to parse EC private key/,
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getAccessToken", () => {
  beforeEach(() => {
    invalidateAccessToken(CREDS.clientId);
  });

  it("exchanges the JWT for an access token via the token endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ access_token: "tok-abc", expires_in: 3600 });
    };

    const token = await getAccessToken(CREDS, { fetchFn, nowSeconds: () => 1_700_000_000 });

    expect(token).toBe("tok-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://appleid.apple.com/auth/oauth2/token");
    const body = new URLSearchParams(calls[0]!.init!.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe(CREDS.clientId);
    expect(body.get("scope")).toBe("searchadsorg");
    expect(body.get("client_secret")).toBeTruthy(); // the signed JWT
  });

  it("caches the token and does not re-fetch while still fresh", async () => {
    let callCount = 0;
    const fetchFn = async () => {
      callCount++;
      return jsonResponse({ access_token: "tok-cached", expires_in: 3600 });
    };
    const nowSeconds = () => 1_700_000_000;

    const first = await getAccessToken(CREDS, { fetchFn, nowSeconds });
    const second = await getAccessToken(CREDS, { fetchFn, nowSeconds });

    expect(first).toBe("tok-cached");
    expect(second).toBe("tok-cached");
    expect(callCount).toBe(1);
  });

  it("refreshes once the cached token is within the expiry skew window", async () => {
    let callCount = 0;
    let now = 1_700_000_000;
    const fetchFn = async () => {
      callCount++;
      return jsonResponse({ access_token: `tok-${callCount}`, expires_in: 3600 });
    };

    const t1 = await getAccessToken(CREDS, { fetchFn, nowSeconds: () => now });
    expect(t1).toBe("tok-1");

    // Jump forward past (3600 - 60s skew) — should trigger a refresh.
    now += 3600 - 30;
    const t2 = await getAccessToken(CREDS, { fetchFn, nowSeconds: () => now });

    expect(t2).toBe("tok-2");
    expect(callCount).toBe(2);
  });

  it("throws a clear error on invalid_client", async () => {
    const fetchFn = async () =>
      jsonResponse({ error: "invalid_client", error_description: "bad credentials" }, 401);

    await expect(
      getAccessToken(CREDS, { fetchFn, nowSeconds: () => 1_700_000_000 }),
    ).rejects.toThrow(/invalid_client/);
  });

  it("throws when the response is missing access_token/expires_in", async () => {
    const fetchFn = async () => jsonResponse({ ok: true });
    await expect(
      getAccessToken(CREDS, { fetchFn, nowSeconds: () => 1_700_000_000 }),
    ).rejects.toThrow(/missing access_token/);
  });
});

describe("callApi", () => {
  it("sets both the Authorization and X-AP-Context headers", async () => {
    let seenHeaders: Headers | undefined;
    const fetchFn = async (_url: string, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({ data: [] });
    };

    await callApi("/acls", { token: "my-token", orgId: "42", deps: { fetchFn } });

    expect(seenHeaders?.get("authorization")).toBe("Bearer my-token");
    expect(seenHeaders?.get("x-ap-context")).toBe("orgId=42");
  });

  it("builds the URL against the v5 API base", async () => {
    let seenUrl = "";
    const fetchFn = async (url: string) => {
      seenUrl = url;
      return jsonResponse({});
    };
    await callApi("custom-reports/1", { token: "t", orgId: "1", deps: { fetchFn } });
    expect(seenUrl).toBe("https://api.searchads.apple.com/api/v5/custom-reports/1");
  });
});

describe("testConnection", () => {
  beforeEach(() => {
    invalidateAccessToken(CREDS.clientId);
  });

  it("returns ok:true with the matching org name", async () => {
    const fetchFn = async (url: string) => {
      if (url.includes("/auth/oauth2/token")) {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      return jsonResponse({ data: [{ orgId: 998877, orgName: "Acme Inc" }] });
    };

    const status = await testConnection(CREDS, { fetchFn, nowSeconds: () => 1_700_000_000 });
    expect(status).toEqual({ ok: true, orgName: "Acme Inc" });
  });

  it("maps a non-2xx acls response to ok:false with an error", async () => {
    const fetchFn = async (url: string) => {
      if (url.includes("/auth/oauth2/token")) {
        return jsonResponse({ access_token: "tok", expires_in: 3600 });
      }
      return new Response("forbidden", { status: 403 });
    };

    const status = await testConnection(CREDS, { fetchFn, nowSeconds: () => 1_700_000_000 });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("403");
  });

  it("maps a token-exchange failure to ok:false", async () => {
    const fetchFn = async () => jsonResponse({ error: "invalid_client" }, 401);
    const status = await testConnection(CREDS, { fetchFn, nowSeconds: () => 1_700_000_000 });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("invalid_client");
  });
});

describe("isAppleHost", () => {
  it("accepts apple.com and subdomains", () => {
    expect(isAppleHost("apple.com")).toBe(true);
    expect(isAppleHost("api.searchads.apple.com")).toBe(true);
    expect(isAppleHost("Reports.Apple.Com")).toBe(true);
  });

  it("rejects lookalike / non-apple hosts", () => {
    expect(isAppleHost("apple.com.evil.example")).toBe(false);
    expect(isAppleHost("notapple.com")).toBe(false);
    expect(isAppleHost("evil.example")).toBe(false);
  });
});
