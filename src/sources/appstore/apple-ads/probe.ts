/**
 * probe.ts — EXPERIMENTAL, best-effort searchPopularity probe.
 * PENDING LIVE VALIDATION — do not wire this into demand/opportunity/
 * buildability scoring.
 *
 * Attempts Apple's Custom Reports ("Impression Share Report") async flow:
 * POST /custom-reports to create a report, poll GET
 * /custom-reports/{reportId} until state=COMPLETED, then fetch the
 * downloadUri. The exact request/response field names below are our best
 * reading of Apple's docs plus cross-referencing an independent third-party
 * v5 client's request shape (selector.conditions on countryOrRegion /
 * searchTerm, selector.fields, {name, startTime, endTime, granularity,
 * dateRange, selector}) — NOT verified against a live account. Every stage
 * is wrapped so a shape mismatch produces a diagnostic `error`, not a thrown
 * exception or (worse) a silently wrong scoring signal. The goal of this
 * phase is purely to LEARN the real shape/coverage before building a
 * store+scoring pipeline (see the design doc referenced from client.ts).
 */

import { createLogger } from "../../../logger";
import { getErrorMessage } from "../../../lib/error-serialization";
import {
  callApi,
  getAccessToken,
  isAppleHost,
  resolveDeps,
  safeReadText,
  type ClientDeps,
} from "./client";
import type { AppleAdsCreds, SearchPopularityProbeResult } from "./types";

const log = createLogger("apple-ads-probe");

const MAX_PROBE_KEYWORDS = 10;
const DEFAULT_POLL_ATTEMPTS = 10;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "ERROR"]);

export interface ProbeOptions {
  readonly creds: AppleAdsCreds;
  readonly deps?: ClientDeps;
  readonly maxPollAttempts?: number;
  readonly pollIntervalMs?: number;
  /** Injectable sleep so tests don't wait in real time. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

interface ReportEnvelope {
  readonly data?: {
    readonly reportId?: string | number;
    readonly id?: string | number;
    readonly state?: string;
    readonly downloadUri?: string;
    readonly download?: { readonly uri?: string };
  };
}

function extractReportId(body: unknown): string | undefined {
  const data = (body as ReportEnvelope | undefined)?.data;
  const id = data?.reportId ?? data?.id;
  return id === undefined || id === null ? undefined : String(id);
}

function extractState(body: unknown): string | undefined {
  return (body as ReportEnvelope | undefined)?.data?.state;
}

function extractDownloadUri(body: unknown): string | undefined {
  const data = (body as ReportEnvelope | undefined)?.data;
  return data?.downloadUri ?? data?.download?.uri;
}

/**
 * Defensively parse a downloaded report body. The real export format
 * (JSON array, JSON envelope, or CSV) is not yet confirmed live — try JSON
 * first, fall back to a naive CSV-to-object parse, and never throw.
 */
export function parseReportRows(text: string): readonly unknown[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)) {
      return (parsed as { data: unknown[] }).data;
    }
    return [parsed];
  } catch {
    // Not JSON — best-effort CSV parse (header row + comma-split rows).
    const lines = trimmed.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length === 0) return [];
    const header = lines[0]!.split(",").map((h) => h.trim());
    return lines.slice(1).map((line) => {
      const cells = line.split(",");
      const row: Record<string, string> = {};
      header.forEach((col, i) => {
        row[col] = cells[i] ?? "";
      });
      return row;
    });
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * EXPERIMENTAL: attempt to retrieve Apple's `searchPopularity` metric for up
 * to MAX_PROBE_KEYWORDS keywords via the Custom Reports async flow. Returns
 * a diagnostic — never throws. See the module-level comment above for the
 * "pending live validation" caveats; do not wire the result into scoring.
 */
export async function probeSearchPopularity(
  keywords: readonly string[],
  storefront: string,
  opts: ProbeOptions,
): Promise<SearchPopularityProbeResult> {
  const { creds, deps } = opts;
  const maxPollAttempts = opts.maxPollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleepFn = opts.sleepFn ?? defaultSleep;
  const resolved = resolveDeps(deps);
  const trimmedKeywords = keywords.slice(0, MAX_PROBE_KEYWORDS);

  try {
    const token = await getAccessToken(creds, deps);
    const now = resolved.nowSeconds();

    const createBody = {
      name: `opencrow-probe-${now}`.slice(0, 50),
      startTime: isoDate(now - 7 * 24 * 60 * 60),
      endTime: isoDate(now),
      selector: {
        conditions: [
          { field: "searchTerm", operator: "IN", values: trimmedKeywords },
          { field: "countryOrRegion", operator: "IN", values: [storefront] },
        ],
        fields: ["searchTerm", "countryOrRegion", "searchPopularity"],
      },
    };

    const createRes = await callApi("/custom-reports", {
      token,
      orgId: creds.orgId,
      deps,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(createBody),
      },
    });

    if (!createRes.ok) {
      return {
        state: "ERROR",
        rowCount: 0,
        sample: [],
        error: `custom-reports create failed: HTTP ${createRes.status}: ${await safeReadText(createRes)}`,
      };
    }

    let createJson: unknown;
    try {
      createJson = await createRes.json();
    } catch (err) {
      return {
        state: "ERROR",
        rowCount: 0,
        sample: [],
        error: `custom-reports create: non-JSON response: ${getErrorMessage(err)}`,
      };
    }

    const reportId = extractReportId(createJson);
    if (!reportId) {
      return {
        state: "ERROR",
        rowCount: 0,
        sample: [],
        error: "custom-reports create: response had no reportId (shape mismatch — needs live validation)",
      };
    }

    let state = extractState(createJson) ?? "PROCESSING";
    let lastBody: unknown = createJson;

    for (let attempt = 0; attempt < maxPollAttempts && !TERMINAL_STATES.has(state); attempt++) {
      await sleepFn(pollIntervalMs);

      const pollRes = await callApi(`/custom-reports/${reportId}`, {
        token,
        orgId: creds.orgId,
        deps,
      });
      if (!pollRes.ok) {
        return {
          state: "ERROR",
          rowCount: 0,
          sample: [],
          reportId,
          error: `custom-reports poll failed: HTTP ${pollRes.status}: ${await safeReadText(pollRes)}`,
        };
      }
      try {
        lastBody = await pollRes.json();
      } catch (err) {
        return {
          state: "ERROR",
          rowCount: 0,
          sample: [],
          reportId,
          error: `custom-reports poll: non-JSON response: ${getErrorMessage(err)}`,
        };
      }
      state = extractState(lastBody) ?? state;
    }

    if (state !== "COMPLETED") {
      return {
        state,
        rowCount: 0,
        sample: [],
        reportId,
        error:
          state === "PROCESSING" || state === "QUEUED"
            ? `report did not complete within ${maxPollAttempts} polls (last state=${state})`
            : `report finished in non-completed state=${state}`,
      };
    }

    const downloadUri = extractDownloadUri(lastBody);
    if (!downloadUri) {
      return {
        state,
        rowCount: 0,
        sample: [],
        reportId,
        error: "report COMPLETED but response had no downloadUri (shape mismatch — needs live validation)",
      };
    }

    let downloadHost: string;
    try {
      downloadHost = new URL(downloadUri).hostname;
    } catch {
      return {
        state,
        rowCount: 0,
        sample: [],
        reportId,
        error: `downloadUri is not a valid URL: ${downloadUri}`,
      };
    }
    if (!isAppleHost(downloadHost)) {
      log.warn("Apple Ads probe: refused non-apple.com downloadUri host", { host: downloadHost });
      return {
        state,
        rowCount: 0,
        sample: [],
        reportId,
        error: `SSRF guard: refused to fetch downloadUri — host "${downloadHost}" is not *.apple.com`,
      };
    }

    // SSRF hardening: do NOT follow redirects on the authenticated download —
    // a *.apple.com URI that 3xx-redirects elsewhere would otherwise replay the
    // bearer token to the redirect target, bypassing the host allowlist above.
    const downloadRes = await resolved.fetchFn(downloadUri, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    if (downloadRes.status >= 300 && downloadRes.status < 400) {
      return {
        state,
        rowCount: 0,
        sample: [],
        reportId,
        error: `SSRF guard: refused to follow redirect (HTTP ${downloadRes.status}) from downloadUri`,
      };
    }
    if (!downloadRes.ok) {
      return {
        state,
        rowCount: 0,
        sample: [],
        reportId,
        error: `download failed: HTTP ${downloadRes.status}`,
      };
    }

    const text = await downloadRes.text();
    const rows = parseReportRows(text);
    return {
      state,
      reportId,
      rowCount: rows.length,
      sample: rows.slice(0, 5),
    };
  } catch (err) {
    log.error("Apple Ads probeSearchPopularity failed", { err: getErrorMessage(err) });
    return { state: "ERROR", rowCount: 0, sample: [], error: getErrorMessage(err) };
  }
}
