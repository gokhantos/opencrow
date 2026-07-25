/**
 * zero-yield-notify.ts — the delivery half of the zero-yield alarm. Kept in its
 * own module so `zero-yield.ts` stays pure and DB/IO-free (and therefore fully
 * unit-testable without mocks).
 *
 * Delivery reuses the EXISTING cron delivery queue (`DeliveryStore.enqueue`),
 * exactly like `gap-alerts.ts` and `monitor/runner.ts` do — this module must
 * never instantiate its own Telegram bot, because a second `getUpdates` poller
 * alongside the channel process risks a 409 Conflict / duplicate-message race.
 * See `gap-alerts.ts`'s module doc for the full rationale.
 *
 * Best-effort by contract: a notification failure must never turn a
 * zero-yield run into a thrown error. The run record is the durable signal;
 * the message is the convenience.
 */

import { createDeliveryStore } from "../../cron/delivery-store";
import { createLogger } from "../../logger";
import { getErrorMessage } from "../../lib/error-serialization";
import { formatZeroYieldAlert, type ZeroYieldAlertParams } from "./zero-yield";

const log = createLogger("pipeline:zero-yield");

/** Job name the delivery row is tagged with (mirrors `gap-alerts`' convention). */
export const ZERO_YIELD_JOB_NAME = "ideas-pipeline-zero-yield";

export interface NotifyZeroYieldParams extends ZeroYieldAlertParams {
  /** Delivery channel, e.g. "telegram". Omit to skip delivery entirely. */
  readonly channel?: string;
  /** Destination chat id. Omit to skip delivery entirely. */
  readonly chatId?: string;
}

/**
 * Enqueue the operator notification for a zero-yield run. Returns whether a
 * delivery was actually enqueued (`false` when the run was healthy, when no
 * destination is configured, or when enqueueing failed). Never throws.
 */
export async function notifyZeroYield(params: NotifyZeroYieldParams): Promise<boolean> {
  const text = formatZeroYieldAlert(params);
  if (text === "") return false;

  if (!params.channel || !params.chatId) {
    log.warn("Zero-yield run detected but no notification destination configured", {
      runId: params.runId,
      reason: params.verdict.reason,
    });
    return false;
  }

  try {
    const deliveryStore = createDeliveryStore();
    await deliveryStore.enqueue({
      channel: params.channel,
      chatId: params.chatId,
      jobName: ZERO_YIELD_JOB_NAME,
      text,
      preformatted: false,
    });
    log.warn("Zero-yield run detected — operator notification enqueued", {
      runId: params.runId,
      pipelineId: params.pipelineId,
      reason: params.verdict.reason,
    });
    return true;
  } catch (err) {
    log.warn("Failed to enqueue zero-yield notification", {
      runId: params.runId,
      error: getErrorMessage(err),
    });
    return false;
  }
}
