# Apple Ads External-Demand — Connection Foundation + Feasibility Probe (Phase 4a)

**Date:** 2026-07-14
**Goal:** Lay the credential + OAuth foundation to pull Apple's real App Store
`searchPopularity` (search-volume) signal, and a PROBE to learn — against a live
account — exactly how/whether `searchPopularity` is accessible for our keywords,
BEFORE committing to the full fetch→store→scoring pipeline.

## Why staged
Apple's `searchPopularity` (5–100 / 1–5 depending on report) lives only in the
**Apple Ads Campaign Management API v5**, via async **Custom Reports / Impression
Share Reports**. It is uncertain whether it serves popularity for *arbitrary*
keywords (vs. only campaign/impression-share terms). So this phase ships the
CERTAIN, testable substrate + a probe; the store+blend pipeline is a follow-up
gated on what the probe reveals with real creds.

## Hard dependency (user-provided)
Apple Ads account + API creds from ads.apple.com → Account Settings → API:
`clientId`, `teamId`, `keyId`, `orgId`, and an EC P-256 **private key (PEM)**.
Stored as DB **secrets** (never env-committed), keys:
`APPLE_ADS_CLIENT_ID`, `APPLE_ADS_TEAM_ID`, `APPLE_ADS_KEY_ID`,
`APPLE_ADS_ORG_ID`, `APPLE_ADS_PRIVATE_KEY`. Read via `getSecret()`
(`src/config/secrets.ts` — DB secrets namespace, env fallback).

## Auth contract (verified from Apple docs)
- Client secret = JWT signed **ES256** with the private key.
  - header: `{ alg: "ES256", kid: <keyId> }`
  - payload: `{ sub: <clientId>, aud: "https://appleid.apple.com",
    iss: <teamId>, iat, exp }` (exp ≤ 180 days; use a short exp, e.g. 1h–24h).
- Token: `POST https://appleid.apple.com/auth/oauth2/token`
  form-encoded: `grant_type=client_credentials`, `client_id=<clientId>`,
  `client_secret=<jwt>`, `scope=searchadsorg`. → `{ access_token, expires_in }`
  (valid ~1h). Cache until near expiry.
- API base: `https://api.searchads.apple.com/api/v5/`.
  Headers on every call: `Authorization: Bearer <token>` and
  `X-AP-Context: orgId=<orgId>`.

Use the **`jose`** library for ES256 signing (add to deps) — raw `node:crypto`
needs manual DER→JOSE signature conversion and is error-prone.

## Scope of THIS phase (all flag-gated + inert without creds → safe to merge)

### Backend / integration (`src/sources/appstore/apple-ads/`)
1. `config.ts` — `getAppleAdsCredentials(): Promise<AppleAdsCreds | null>` reads
   the five secrets; returns null if ANY is missing (feature stays inert). A
   config flag `appstore.externalDemand.enabled` (default false) gates activation.
2. `client.ts` — pure, dependency-injectable HTTP (`fetch` injected for tests):
   - `signClientSecret(creds, now)` → ES256 JWT (unit-tested: decode header+claims).
   - `getAccessToken(creds, deps)` → token POST + in-memory cache keyed by clientId,
     refresh when <60s to expiry. Comprehensive error handling (invalid_client etc.).
   - `callApi(path, {creds, token})` → adds Bearer + `X-AP-Context: orgId=…`.
   - `testConnection(creds, deps)` → `GET /api/v5/acls` (or `/me`); returns
     `{ ok, orgName?, error? }` to verify creds + org access.
   - `probeSearchPopularity(keywords, storefront, {creds, deps})` → EXPERIMENTAL,
     best-effort: attempt the custom-reports flow (POST create → poll GET until
     COMPLETED → fetch downloadUri) requesting `searchPopularity` by
     keyword/searchTerm + countryOrRegion. Return the RAW parsed result + a
     diagnostic (status, rows, any error) so we LEARN the real shape/coverage.
     Clearly comment: pending live validation; do NOT wire into scoring yet.
3. Route (`src/web/routes/appstore.ts` or a new `apple-ads.ts` router):
   - `POST /api/appstore/apple-ads/test` (bearer-auth like the rest) → runs
     testConnection, returns status. Never returns the secrets.
   - `POST /api/appstore/apple-ads/probe` → runs probeSearchPopularity on a small
     supplied keyword list; returns the diagnostic. (Admin-only surface.)
   - A thin CLI/tool entry is optional; the route is enough.

### Frontend (settings)
4. A **Settings → Apple Ads** panel (`src/web/ui/views/settings/…`) following the
   existing settings pattern (see `Embeddings-memorySettings.tsx`):
   - inputs for clientId/teamId/keyId/orgId + a textarea for the private key PEM;
     save → persists to secrets via a config route (write-only; never echo the
     PEM back — show "•••• set" state).
   - a **Test connection** button hitting `/api/appstore/apple-ads/test`, showing
     ok/org-name or the error.
   - the `externalDemand.enabled` flag toggle.

## Security (call security-reviewer before ship)
- Secrets: stored via DB secrets namespace only; NEVER logged, NEVER returned in
  API responses, NEVER echoed to the client (write-only PEM field).
- SSRF: all outbound calls are to fixed Apple hosts (`appleid.apple.com`,
  `api.searchads.apple.com`) — hardcode host allowlist; the report `downloadUri`
  comes from Apple's API response, still restrict to the apple.com domain before
  fetching it (don't blindly fetch an arbitrary URI).
- The test/probe routes are behind the existing bearer auth; treat as admin.

## NOT in this phase (follow-ups, gated on probe results)
- A migration + `search_popularity` column, a batch refresh job/scanner step,
  rate-limited bulk fetch of all ~37k keywords, and BLENDING popularity into the
  demand / buildability / opportunity scores. We build these once the probe
  confirms how searchPopularity actually behaves for our keywords.

## Tests
- Unit (isolated for any mock.module): JWT header/claims correctness; token cache
  refresh logic; config returns null when a secret is missing; callApi sets both
  headers; testConnection ok/error mapping; probe parsing against a sample
  custom-reports response fixture; SSRF host-allowlist rejects a non-apple URI.
- No live network in tests — inject a fake `fetch`.

## Success criteria (this phase)
With creds saved, the Settings → Apple Ads "Test connection" returns the org name
(auth works end-to-end), and the probe returns a real diagnostic telling us
whether `searchPopularity` is retrievable for our keywords — enough to design the
full pipeline with confidence and zero speculative scoring changes shipped.
