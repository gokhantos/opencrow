/**
 * Unit tests for config.ts — credential reads are fully dependency-injected
 * (a fake SecretReader), so these never touch the DB or process.env.
 * Lane: *.test.ts — `bun run test:unit`.
 */
import { describe, it, expect } from "bun:test";
import { getAppleAdsCredentials, getAppleAdsCredentialStatus } from "./config";

const PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----";

const ALL_SECRETS = {
  APPLE_ADS_CLIENT_ID: "client-123",
  APPLE_ADS_TEAM_ID: "team-456",
  APPLE_ADS_KEY_ID: "key-789",
  APPLE_ADS_ORG_ID: "org-321",
  APPLE_ADS_PRIVATE_KEY: PRIVATE_KEY_PEM,
} as const;

function makeReader(overrides: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...ALL_SECRETS, ...overrides };
  return async (key: string): Promise<string | undefined> => merged[key];
}

describe("getAppleAdsCredentials", () => {
  it("returns the full creds object when all 5 secrets are present", async () => {
    const creds = await getAppleAdsCredentials(makeReader());
    expect(creds).not.toBeNull();
    expect(creds).toEqual({
      clientId: "client-123",
      teamId: "team-456",
      keyId: "key-789",
      orgId: "org-321",
      privateKey: PRIVATE_KEY_PEM,
    });
  });

  it("returns null when the private key is missing", async () => {
    const creds = await getAppleAdsCredentials(makeReader({ APPLE_ADS_PRIVATE_KEY: undefined }));
    expect(creds).toBeNull();
  });

  it("returns null when clientId is missing", async () => {
    const creds = await getAppleAdsCredentials(makeReader({ APPLE_ADS_CLIENT_ID: undefined }));
    expect(creds).toBeNull();
  });

  it("returns null when a secret resolves to an empty string", async () => {
    const creds = await getAppleAdsCredentials(makeReader({ APPLE_ADS_ORG_ID: "" }));
    expect(creds).toBeNull();
  });

  it("returns null when nothing is configured", async () => {
    const creds = await getAppleAdsCredentials(async () => undefined);
    expect(creds).toBeNull();
  });
});

describe("getAppleAdsCredentialStatus", () => {
  it("reports all-set booleans without ever exposing values", async () => {
    const status = await getAppleAdsCredentialStatus(makeReader());
    expect(status).toEqual({
      clientIdSet: true,
      teamIdSet: true,
      keyIdSet: true,
      orgIdSet: true,
      privateKeySet: true,
      configured: true,
    });
    expect(JSON.stringify(status)).not.toContain("client-123");
    expect(JSON.stringify(status)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("reports per-key status when only some secrets are set", async () => {
    const status = await getAppleAdsCredentialStatus(
      makeReader({ APPLE_ADS_PRIVATE_KEY: undefined, APPLE_ADS_ORG_ID: undefined }),
    );
    expect(status).toEqual({
      clientIdSet: true,
      teamIdSet: true,
      keyIdSet: true,
      orgIdSet: false,
      privateKeySet: false,
      configured: false,
    });
  });

  it("reports all-false when nothing is configured", async () => {
    const status = await getAppleAdsCredentialStatus(async () => undefined);
    expect(status.configured).toBe(false);
    expect(status.clientIdSet).toBe(false);
    expect(status.privateKeySet).toBe(false);
  });
});
