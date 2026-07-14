/**
 * apple-ads.ts — Apple Ads (Search Ads) connection foundation routes.
 *
 * Mounted under /api (see app.ts), so it inherits the existing /api/*
 * bearer-auth middleware — every route here is already admin-gated.
 *
 * Routes:
 *   GET  /appstore/apple-ads/config  — which of the 5 creds are set
 *                                       (booleans only, NEVER values; the
 *                                       private key is write-only).
 *   POST /appstore/apple-ads/config  — save creds to the DB secrets
 *                                       namespace (Zod-validated).
 *   POST /appstore/apple-ads/test    — verify creds + org access via
 *                                       GET /acls. Never returns secrets.
 *   POST /appstore/apple-ads/probe   — EXPERIMENTAL searchPopularity probe
 *                                       (see apple-ads/probe.ts) — returns a
 *                                       raw diagnostic, not a scoring signal.
 *
 * All three creds-dependent routes are no-ops ({ok:false, error:"not
 * configured"}) when getAppleAdsCredentials() returns null, so this surface
 * is fully inert on a deployment that hasn't configured Apple Ads yet.
 */

import { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import { setOverride } from "../../store/config-overrides";
import {
  getAppleAdsCredentials,
  getAppleAdsCredentialStatus,
  APPLE_ADS_SECRET_KEYS,
} from "../../sources/appstore/apple-ads/config";
import { testConnection } from "../../sources/appstore/apple-ads/client";
import { probeSearchPopularity } from "../../sources/appstore/apple-ads/probe";

const log = createLogger("apple-ads-api");

const saveConfigSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  teamId: z.string().trim().min(1).max(512),
  keyId: z.string().trim().min(1).max(512),
  orgId: z.string().trim().min(1).max(512),
  // EC P-256 private key, PEM-encoded. Generous max length — PEM keys are
  // short (~250-350 bytes) but allow headroom for whitespace/formatting.
  privateKey: z.string().trim().min(1).max(8192),
});

const probeRequestSchema = z.object({
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  storefront: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/, "storefront must be a 2-letter ISO country code, e.g. US")
    .default("US"),
});

export function createAppleAdsRoutes(): Hono {
  const app = new Hono();

  // GET status: booleans only, never the values. The PEM field is
  // write-only by design — it is never echoed back, masked or otherwise.
  app.get("/appstore/apple-ads/config", async (c) => {
    try {
      const status = await getAppleAdsCredentialStatus();
      return c.json({ success: true, data: status });
    } catch (err) {
      log.error("Failed to read Apple Ads config status", { err });
      return c.json({ success: false, error: "Failed to read config status" }, 500);
    }
  });

  // POST save: persist the 5 creds to the DB secrets namespace.
  app.post("/appstore/apple-ads/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = saveConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    try {
      const { clientId, teamId, keyId, orgId, privateKey } = parsed.data;
      await Promise.all([
        setOverride("secrets", APPLE_ADS_SECRET_KEYS.clientId, clientId),
        setOverride("secrets", APPLE_ADS_SECRET_KEYS.teamId, teamId),
        setOverride("secrets", APPLE_ADS_SECRET_KEYS.keyId, keyId),
        setOverride("secrets", APPLE_ADS_SECRET_KEYS.orgId, orgId),
        setOverride("secrets", APPLE_ADS_SECRET_KEYS.privateKey, privateKey),
      ]);
      // Audit log: this writes credentials capable of billing an Apple Ads
      // account — record who/when, never the values themselves.
      log.warn("AUDIT apple-ads config write", {
        ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
        userAgent: c.req.header("user-agent") ?? "unknown",
      });
      return c.json({ success: true });
    } catch (err) {
      log.error("Failed to save Apple Ads config", { err });
      return c.json({ success: false, error: "Failed to save config" }, 500);
    }
  });

  // POST test: verify creds + org access. Never returns secret values.
  app.post("/appstore/apple-ads/test", async (c) => {
    try {
      const creds = await getAppleAdsCredentials();
      if (!creds) {
        return c.json({ success: true, data: { ok: false, error: "not configured" } });
      }
      const status = await testConnection(creds);
      return c.json({ success: true, data: status });
    } catch (err) {
      log.error("Apple Ads test-connection route failed", { err });
      return c.json({ success: false, error: "Test connection failed" }, 500);
    }
  });

  // POST probe: EXPERIMENTAL searchPopularity probe. Best-effort, returns a
  // raw diagnostic — NOT wired into any scoring pipeline.
  app.post("/appstore/apple-ads/probe", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const parsed = probeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    try {
      const creds = await getAppleAdsCredentials();
      if (!creds) {
        return c.json({
          success: true,
          data: { state: "NOT_CONFIGURED", rowCount: 0, sample: [], error: "not configured" },
        });
      }
      const { keywords, storefront } = parsed.data;
      const result = await probeSearchPopularity(keywords, storefront, { creds });
      return c.json({ success: true, data: result });
    } catch (err) {
      log.error("Apple Ads probe route failed", { err });
      return c.json({ success: false, error: "Probe failed" }, 500);
    }
  });

  return app;
}
