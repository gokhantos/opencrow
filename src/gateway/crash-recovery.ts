import type { Channel } from "../channels/types";
import { createLogger } from "../logger";

const log = createLogger("gateway:crash-recovery");

export async function notifyRollbackRecovery(
  channels: Map<string, Channel>,
): Promise<void> {
  try {
    const { consumeRollbackEvents } = await import("../health/rollback-notifier");
    const rollbackEvents = await consumeRollbackEvents();
    const seen = new Set<string>();

    for (const event of rollbackEvents) {
      const msg =
        `[Guardian] Crash-loop detected and auto-recovered.\n` +
        `Rolled back from ${event.from.slice(0, 8)} to ${event.to.slice(0, 8)}.\n` +
        `Reason: ${event.reason}\n` +
        `Time: ${event.timestamp}`;

      log.warn("Rollback recovery notification", { event });

      for (const [id, ch] of channels) {
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          await ch.sendMessage("rollback", { text: msg });
        } catch {
          // Channel may not support arbitrary chatId — best-effort
        }
      }
    }
  } catch (err) {
    log.error("Failed to process rollback events (non-fatal)", { error: err });
  }
}
