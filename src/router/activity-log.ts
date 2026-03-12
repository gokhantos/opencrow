import type { Channel } from "../channels/types";
import type { ProgressEvent } from "../agent/types";
import { escapeHtml } from "../channels/telegram/format";
import { createLogger } from "../logger";

const log = createLogger("activity-log");

/** Leave headroom for the header/footer lines */
const MAX_TEXT_LENGTH = 3800;

/** Minimum interval between status message edits (ms) */
const EDIT_THROTTLE_MS = 3_000;

/** How many leading events to keep when truncating */
const TRUNCATION_HEAD = 3;

/** How many trailing events to keep when truncating */
const TRUNCATION_TAIL = 15;

/** Max chars for sub-agent task description */
const MAX_TASK_LENGTH = 50;

interface ActivityEntry {
  readonly text: string;
  readonly indent: number;
}

interface SubAgentState {
  readonly name: string;
  toolCount: number;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds - minutes * 60;
  return `${minutes}m ${remaining.toFixed(0)}s`;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Convert a progress event into a display entry.
 * Sub-agent events get extra indentation via indentOffset.
 */
function entryForEvent(
  event: ProgressEvent,
  indentOffset: number,
): ActivityEntry | null {
  switch (event.type) {
    case "thinking":
      return {
        text: `💭 <i>${escapeHtml(event.summary)}</i>`,
        indent: indentOffset,
      };

    case "text_output":
      return null;

    case "tool_start":
      return {
        text: `🔧 <code>${escapeHtml(event.tool)}</code>`,
        indent: indentOffset,
      };

    case "tool_done": {
      if (!event.result) return null;
      const prefix = event.isError ? "❌" : "↳";
      return {
        text: `${prefix} ${escapeHtml(event.result)}`,
        indent: 1 + indentOffset,
      };
    }

    case "subagent_start": {
      const task = truncateText(event.task, MAX_TASK_LENGTH);
      return {
        text: `🤖 <b>${escapeHtml(event.childAgent)}</b>: ${escapeHtml(task)}`,
        indent: indentOffset,
      };
    }

    case "subagent_done":
      // Handled separately in onProgress (with tool count)
      return null;

    case "iteration":
      if (event.iteration <= 1) return null;
      return {
        text: `<i>Thinking... (step ${event.iteration})</i>`,
        indent: indentOffset,
      };

    case "complete":
      return null;

    default:
      return null;
  }
}

function renderEntries(
  entries: readonly ActivityEntry[],
  isComplete: boolean,
  completeEvent?: Extract<ProgressEvent, { readonly type: "complete" }>,
  errorFlag?: boolean,
): string {
  const header = isComplete
    ? "<b>OpenCrow worked on this:</b>"
    : "<b>OpenCrow is working...</b>";
  const lines: string[] = [header, ""];

  // Smart truncation: head + "... (N hidden) ..." + tail
  const maxEntries = TRUNCATION_HEAD + TRUNCATION_TAIL;
  let displayEntries: readonly ActivityEntry[];

  if (entries.length > maxEntries) {
    const head = entries.slice(0, TRUNCATION_HEAD);
    const tail = entries.slice(-TRUNCATION_TAIL);
    const hidden = entries.length - TRUNCATION_HEAD - TRUNCATION_TAIL;
    displayEntries = [
      ...head,
      { text: `<i>... (${hidden} hidden) ...</i>`, indent: 0 },
      ...tail,
    ];
  } else {
    displayEntries = entries;
  }

  for (const entry of displayEntries) {
    const indent = entry.indent > 0 ? "  ".repeat(entry.indent) : "";
    lines.push(`${indent}${entry.text}`);
  }

  if (isComplete) {
    lines.push("");
    if (errorFlag) {
      const duration = completeEvent
        ? formatDuration(completeEvent.durationMs)
        : "?";
      lines.push(`❗ <i>Failed after ${duration}</i>`);
    } else if (completeEvent) {
      const parts: string[] = [
        `Done in ${formatDuration(completeEvent.durationMs)}`,
      ];
      if (completeEvent.toolUseCount > 0) {
        parts.push(`${completeEvent.toolUseCount} tools`);
      }
      if (completeEvent.tokenUsage) {
        parts.push(
          `${formatTokens(completeEvent.tokenUsage.input)} in / ${formatTokens(completeEvent.tokenUsage.output)} out`,
        );
      }
      lines.push(`<i>${parts.join(" · ")}</i>`);
    } else {
      lines.push("<i>Done</i>");
    }
  }

  return lines.join("\n");
}

export interface ActivityLog {
  readonly onProgress: (event: ProgressEvent) => void;
  start(): Promise<void>;
  finalize(opts?: { readonly error?: boolean }): Promise<void>;
}

export function createActivityLog(
  channel: Channel,
  chatId: string,
): ActivityLog {
  const entries: ActivityEntry[] = [];
  const allEvents: ProgressEvent[] = [];
  let statusMessageId: number | null = null;
  let lastEditTime = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<void> | null = null;
  let startTime = 0;
  /** Root agent ID — first event's agentId, used to distinguish parent from child */
  let rootAgentId: string | null = null;
  /** Active sub-agents keyed by their agentId (childAgent from subagent_start) */
  const activeSubAgents = new Map<string, SubAgentState>();

  function scheduleEdit() {
    if (!statusMessageId || !channel.editMessage) return;

    const now = Date.now();
    const elapsed = now - lastEditTime;

    if (elapsed >= EDIT_THROTTLE_MS) {
      flushEdit();
    } else if (!pendingEdit) {
      pendingEdit = setTimeout(flushEdit, EDIT_THROTTLE_MS - elapsed);
    }
  }

  function flushEdit() {
    if (pendingEdit) {
      clearTimeout(pendingEdit);
      pendingEdit = null;
    }
    if (!statusMessageId || !channel.editMessage) return;

    const text = renderEntries(entries, false);

    // If text would exceed limit, overflow to a new message
    if (text.length > MAX_TEXT_LENGTH) {
      overflowToNewMessage(text);
      return;
    }

    lastEditTime = Date.now();
    inflight = channel
      .editMessage(chatId, statusMessageId, text)
      .catch((err) => {
        log.warn("Activity log edit failed", { error: err });
      })
      .finally(() => {
        inflight = null;
      });
  }

  function overflowToNewMessage(_currentText: string) {
    if (!statusMessageId || !channel.editMessage) return;

    // Finalize the current message with a continuation marker
    const overflowText =
      renderEntries(entries.slice(0, TRUNCATION_HEAD), false) +
      "\n\n...continued below";

    lastEditTime = Date.now();
    inflight = channel
      .editMessage(chatId, statusMessageId, overflowText)
      .then(async () => {
        // Clear old entries, keep only recent ones
        const recent = entries.splice(0, entries.length);
        entries.push(...recent.slice(-TRUNCATION_TAIL));

        // Send a new message to continue the log
        const newText = renderEntries(entries, false);
        const msgId = await channel.sendMessage(chatId, {
          text: newText,
          parseAsHtml: true,
        });
        if (typeof msgId === "number") {
          statusMessageId = msgId;
        }
      })
      .catch((err) => {
        log.warn("Activity log overflow failed", { error: err });
      })
      .finally(() => {
        inflight = null;
      });
  }

  function addEntry(entry: ActivityEntry) {
    entries.push(entry);
    scheduleEdit();
  }

  return {
    onProgress(event: ProgressEvent) {
      allEvents.push(event);

      // Capture root agent ID from the first event
      if (rootAgentId === null) {
        rootAgentId = event.agentId;
      }

      // Determine if this event is from a sub-agent
      const isSubAgent = activeSubAgents.has(event.agentId);
      const indentOffset = isSubAgent ? 1 : 0;

      // Handle sub-agent lifecycle
      if (event.type === "subagent_start") {
        activeSubAgents.set(event.childAgent, {
          name: event.childAgent,
          toolCount: 0,
        });
        const entry = entryForEvent(event, indentOffset);
        if (entry) addEntry(entry);
        return;
      }

      if (event.type === "subagent_done") {
        const state = activeSubAgents.get(event.childAgent);
        const toolInfo =
          state && state.toolCount > 0 ? ` · ${state.toolCount} tools` : "";
        addEntry({
          text: `✅ ${event.childAgent} done${toolInfo}`,
          indent: 1,
        });
        activeSubAgents.delete(event.childAgent);
        return;
      }

      // Track sub-agent tool usage
      if (isSubAgent && event.type === "tool_start") {
        const state = activeSubAgents.get(event.agentId);
        if (state) state.toolCount++;
      }

      // Skip sub-agent's own "complete" event (parent handles the final footer)
      if (event.type === "complete" && isSubAgent) {
        return;
      }

      const entry = entryForEvent(event, indentOffset);
      if (entry) addEntry(entry);
    },

    async start() {
      startTime = Date.now();
      if (!channel.editMessage) return;
      const msgId = await channel.sendMessage(chatId, {
        text: "<b>OpenCrow is working...</b>",
        parseAsHtml: true,
      });
      if (typeof msgId === "number") {
        statusMessageId = msgId;
      }
    },

    async finalize(opts) {
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }
      if (inflight) {
        await inflight;
      }

      if (!statusMessageId) return;

      // Find the complete event if one was emitted (from the root agent)
      const completeEvent = allEvents.find(
        (e): e is Extract<ProgressEvent, { readonly type: "complete" }> =>
          e.type === "complete" && e.agentId === rootAgentId,
      );

      // Build a fallback complete event if none was emitted
      const fallback: Extract<ProgressEvent, { readonly type: "complete" }> = {
        type: "complete",
        agentId: rootAgentId ?? "default",
        durationMs: Date.now() - startTime,
        toolUseCount: allEvents.filter((e) => e.type === "tool_start").length,
      };

      const finalText = renderEntries(
        entries,
        true,
        completeEvent ?? fallback,
        opts?.error,
      );

      if (channel.editMessage) {
        await channel
          .editMessage(chatId, statusMessageId, finalText)
          .catch((err) => {
            log.warn("Activity log finalize edit failed", { error: err });
          });
      }
    },
  };
}

/**
 * Backward-compat alias — same API shape but finalize() replaces cleanup().
 */
export function createProgressTracker(
  channel: Channel,
  chatId: string,
): {
  readonly onProgress: (event: ProgressEvent) => void;
  start(): Promise<void>;
  cleanup(): Promise<void>;
} {
  const activityLog = createActivityLog(channel, chatId);
  return {
    onProgress: activityLog.onProgress,
    start: activityLog.start,
    cleanup: () => activityLog.finalize(),
  };
}
