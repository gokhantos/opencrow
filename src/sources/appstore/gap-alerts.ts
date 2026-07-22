/**
 * gap-alerts.ts — Batch F4: alert on new signature hits & first-time
 * opportunity-threshold crossings.
 *
 * The screener (`keyword-screener.ts`) and the keyword-gap scanner
 * (`keyword-gaps.ts`) both already persist rich, continuously-updated data
 * (`appstore_signature_hits`, `appstore_keyword_scans`), but nothing ever
 * NOTIFIES an operator when something new shows up — the user has to
 * remember to open the dashboard and ask "anything new this week?" This
 * module answers that question proactively: a daily digest of
 *
 *   (a) signature hits that are new / freshly detected since the last run
 *       (see `signature-hits-store.ts`'s `getSignatureHitsSince`), and
 *   (b) keywords whose LATEST scan crossed the seed-opportunity threshold
 *       for the FIRST TIME EVER (see `getFirstEverCrossings` below) —
 *       deliberately NOT "crossed since last alert", which would re-fire on
 *       every noisy oscillation around the threshold.
 *
 * Delivery is via the EXISTING cron delivery queue
 * (`src/cron/delivery-poller.ts` / `delivery-store.ts`) — this module never
 * instantiates its own Telegram bot (that would double-poll Telegram's
 * getUpdates alongside the channel process and risk a 409 Conflict /
 * duplicate-message race). `runGapAlerts` only ever calls
 * `DeliveryStore.enqueue`; the existing poller picks it up and sends it,
 * exactly like the proactive monitor (`src/monitor/runner.ts`) does.
 *
 * The "since last alert" watermark is persisted via the existing
 * `config_overrides` mechanism (`src/store/config-overrides.ts`) under
 * {@link GAP_ALERTS_NAMESPACE} — same pattern as `src/ingestion/cursor.ts`'s
 * composite cursors. `GET /appstore/whats-new` (the dashboard's "New this
 * week" strip) reads the SAME digest shape but against a fixed rolling
 * lookback window, NOT the cron watermark — a read-only GET must never
 * advance state that the alert job depends on for dedup, or polling the
 * dashboard would silently suppress real alerts.
 */

import { createDeliveryStore } from "../../cron/delivery-store";
import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import { getOverride, setOverride } from "../../store/config-overrides";
import { getSignatureHitsSince, type SignatureHit } from "./signature-hits-store";

const log = createLogger("appstore-gap-alerts");

/** `config_overrides` namespace for the alert-run watermark. */
export const GAP_ALERTS_NAMESPACE = "appstore-gap-alerts";
const WATERMARK_KEY = "lastAlertRunAt";

/** Rolling lookback window `GET /appstore/whats-new` uses instead of the cron watermark. */
export const WHATS_NEW_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface KeywordCrossing {
  readonly keyword: string;
  readonly scannedAt: number;
  readonly opportunity: number;
}

/**
 * Keywords whose LATEST `app`-store, non-`low_confidence` scan cleared
 * `opts.threshold` for the FIRST TIME EVER, with that crossing scan recorded
 * at/after `opts.sinceWatermark`. One query over `appstore_keyword_scans`
 * using a window function to detect true first-ever crossings rather than
 * "crossed since last alert" — a keyword oscillating around the threshold
 * (scan N above, N+1 below, N+2 above again) must only ever fire ONCE, the
 * very first time it crosses, never on every later re-crossing.
 *
 * How: for each keyword, `crossed_before` is `1` iff ANY scan STRICTLY
 * before the current row (by `scanned_at`) already cleared the threshold
 * (`ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING`). Only the keyword's
 * single LATEST scan (`rn = 1`) is considered as a candidate crossing, and
 * only kept when it clears the threshold AND no earlier scan ever did. The
 * `scanned_at >= sinceWatermark` filter additionally guards against
 * re-emitting the SAME crossing on a later alert run when no new scan has
 * landed for that keyword since (the crossing scan's timestamp doesn't
 * advance, so it falls out of the window on the next run).
 *
 * `store = 'app'` and `low_confidence = FALSE` are excluded from the
 * candidate pool entirely (not just the final row) — the DE storefront lane
 * is querying/mining-only data (same reasoning as `collectKeywordGaps`'s
 * `store: "app"` filter) and a low-confidence scan's opportunity is an
 * unreliable fabricated-fallback estimate, so neither should ever count as
 * "history" for the crossing detection either.
 */
export async function getFirstEverCrossings(opts: {
  readonly threshold: number;
  readonly sinceWatermark: number;
}): Promise<readonly KeywordCrossing[]> {
  const db = getDb();
  const rows = await db`
    WITH scans AS (
      SELECT keyword, scanned_at, opportunity
      FROM appstore_keyword_scans
      WHERE store = 'app' AND low_confidence = FALSE
    ),
    ranked AS (
      SELECT
        keyword,
        scanned_at,
        opportunity,
        ROW_NUMBER() OVER (PARTITION BY keyword ORDER BY scanned_at DESC) AS rn,
        MAX(CASE WHEN opportunity >= ${opts.threshold} THEN 1 ELSE 0 END) OVER (
          PARTITION BY keyword ORDER BY scanned_at
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS crossed_before
      FROM scans
    )
    SELECT keyword, scanned_at, opportunity
    FROM ranked
    WHERE rn = 1
      AND opportunity >= ${opts.threshold}
      AND coalesce(crossed_before, 0) = 0
      AND scanned_at >= ${opts.sinceWatermark}
    ORDER BY scanned_at DESC
  `;
  return (
    rows as ReadonlyArray<{
      keyword: string;
      scanned_at: number | string;
      opportunity: number | string;
    }>
  ).map((r) => ({
    keyword: r.keyword,
    scannedAt: Number(r.scanned_at),
    opportunity: Number(r.opportunity),
  }));
}

/** Read the persisted "last alert run" watermark (epoch seconds); `0` if never run. */
export async function getAlertWatermark(): Promise<number> {
  const stored = await getOverride(GAP_ALERTS_NAMESPACE, WATERMARK_KEY);
  return typeof stored === "number" && Number.isFinite(stored) ? stored : 0;
}

/** Persist the "last alert run" watermark (epoch seconds). */
export async function setAlertWatermark(atEpochSeconds: number): Promise<void> {
  await setOverride(GAP_ALERTS_NAMESPACE, WATERMARK_KEY, atEpochSeconds);
}

export interface GapAlertsDigest {
  readonly newSignatureHits: readonly SignatureHit[];
  readonly newCrossings: readonly KeywordCrossing[];
}

/** True iff a digest has nothing worth surfacing. */
export function isEmptyDigest(digest: GapAlertsDigest): boolean {
  return digest.newSignatureHits.length === 0 && digest.newCrossings.length === 0;
}

/** Load both halves of a digest for a given `sinceWatermark` cutoff. Read-only. */
export async function buildGapAlertsDigest(opts: {
  readonly opportunityThreshold: number;
  readonly sinceWatermark: number;
}): Promise<GapAlertsDigest> {
  const [newSignatureHits, newCrossings] = await Promise.all([
    getSignatureHitsSince(opts.sinceWatermark),
    getFirstEverCrossings({
      threshold: opts.opportunityThreshold,
      sinceWatermark: opts.sinceWatermark,
    }),
  ]);
  return { newSignatureHits, newCrossings };
}

/** Max rows rendered per section in {@link formatGapAlertsDigest} — keeps the Telegram message bounded. */
const MAX_LINES_PER_SECTION = 20;

/** Render a digest into a plain-text message. `""` when the digest is empty. */
export function formatGapAlertsDigest(digest: GapAlertsDigest): string {
  if (isEmptyDigest(digest)) return "";

  const lines: string[] = ["📈 App Store keyword-gap: what's new"];

  if (digest.newSignatureHits.length > 0) {
    lines.push("", `Newborn-velocity signature hits (${digest.newSignatureHits.length}):`);
    for (const hit of digest.newSignatureHits.slice(0, MAX_LINES_PER_SECTION)) {
      const demand = hit.demand === null ? "n/a" : hit.demand.toFixed(1);
      const trend = hit.trend ?? "n/a";
      lines.push(`  • ${hit.keyword} — demand ${demand}, trend ${trend}`);
    }
    if (digest.newSignatureHits.length > MAX_LINES_PER_SECTION) {
      lines.push(`  … and ${digest.newSignatureHits.length - MAX_LINES_PER_SECTION} more`);
    }
  }

  if (digest.newCrossings.length > 0) {
    lines.push("", `First-time opportunity crossings (${digest.newCrossings.length}):`);
    for (const crossing of digest.newCrossings.slice(0, MAX_LINES_PER_SECTION)) {
      lines.push(`  • ${crossing.keyword} — opportunity ${crossing.opportunity.toFixed(3)}`);
    }
    if (digest.newCrossings.length > MAX_LINES_PER_SECTION) {
      lines.push(`  … and ${digest.newCrossings.length - MAX_LINES_PER_SECTION} more`);
    }
  }

  return lines.join("\n");
}

export interface RunGapAlertsResult {
  readonly sent: boolean;
  readonly signatureHits: number;
  readonly crossings: number;
}

/**
 * Full alert-run cycle: read the watermark, build the digest, ADVANCE the
 * watermark unconditionally (even on an empty digest — see below), and
 * enqueue a delivery only when there's something to say.
 *
 * The watermark advances every run regardless of whether anything fired: an
 * empty run still means "everything up to now has been considered", so the
 * NEXT run's window should start from here, not silently re-scan the same
 * (still-empty) window forever.
 */
export async function runGapAlerts(opts: {
  readonly opportunityThreshold: number;
  readonly channel: string;
  readonly chatId: string;
}): Promise<RunGapAlertsResult> {
  const watermark = await getAlertWatermark();
  const now = Math.floor(Date.now() / 1000);

  const digest = await buildGapAlertsDigest({
    opportunityThreshold: opts.opportunityThreshold,
    sinceWatermark: watermark,
  });

  await setAlertWatermark(now);

  if (isEmptyDigest(digest)) {
    return { sent: false, signatureHits: 0, crossings: 0 };
  }

  const text = formatGapAlertsDigest(digest);
  const deliveryStore = createDeliveryStore();
  await deliveryStore.enqueue({
    channel: opts.channel,
    chatId: opts.chatId,
    jobName: "appstore-gap-alerts",
    text,
    preformatted: false,
  });

  log.info("Gap alerts digest enqueued", {
    signatureHits: digest.newSignatureHits.length,
    crossings: digest.newCrossings.length,
  });

  return {
    sent: true,
    signatureHits: digest.newSignatureHits.length,
    crossings: digest.newCrossings.length,
  };
}

/**
 * Read-only digest for `GET /appstore/whats-new` — the dashboard's "New this
 * week" strip. Uses a FIXED rolling lookback window
 * ({@link WHATS_NEW_LOOKBACK_MS} by default), never the cron alert watermark:
 * a GET must be idempotent and safe to poll, and sharing the watermark would
 * let a dashboard page-load silently advance it and suppress a real alert.
 */
export async function getWhatsNewDigest(opts: {
  readonly opportunityThreshold: number;
  readonly lookbackMs?: number;
}): Promise<GapAlertsDigest> {
  const lookbackMs = opts.lookbackMs ?? WHATS_NEW_LOOKBACK_MS;
  const sinceWatermark = Math.floor((Date.now() - lookbackMs) / 1000);
  return buildGapAlertsDigest({ opportunityThreshold: opts.opportunityThreshold, sinceWatermark });
}
