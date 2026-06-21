/**
 * Anthropic provider using pi-ai — same library OpenClaw uses.
 *
 * Features (matching OpenClaw):
 * - Streaming via pi-ai's completeSimple (streams internally, returns complete)
 * - OAuth token auto-refresh via pi-ai's getOAuthApiKey
 * - Prompt caching via cacheRetention: "short"
 * - Proper Anthropic beta headers for OAuth
 */
import {
  completeSimple,
  getOAuthApiKey,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type OAuthCredentials,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logger";
import type { AgentOptions, AgentResponse, ConversationMessage } from "./types";

const log = createLogger("anthropic-direct");

/**
 * Per-model metadata: context window, max output tokens, and per-token cost.
 * No project-wide model registry exists, so this is the small keyed source of
 * truth used here. Cache reads bill at ~0.1x input and cache writes at ~1.25x
 * input — both must be counted, or a cached prompt looks nearly free.
 *
 * Prices are USD per 1M tokens (input / output). Matched by longest-prefix so
 * dated aliases (e.g. claude-haiku-4-5-20251001) resolve to the family entry.
 * Verified against the claude-api skill model catalog (cached 2026-06). Update
 * here when model pricing/limits change rather than hardcoding at call sites.
 */
interface ModelMetadata {
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** USD per 1M input tokens. */
  readonly inputPerMillion: number;
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number;
}

const MODEL_METADATA: ReadonlyArray<readonly [string, ModelMetadata]> = [
  // Fable 5 / Mythos 5 — 1M context, 128K output, $10 / $50.
  ["claude-fable-5", { contextWindow: 1_000_000, maxTokens: 128_000, inputPerMillion: 10, outputPerMillion: 50 }],
  ["claude-mythos-5", { contextWindow: 1_000_000, maxTokens: 128_000, inputPerMillion: 10, outputPerMillion: 50 }],
  // Opus 4.6 / 4.7 / 4.8 — 1M context, 128K output, $5 / $25.
  ["claude-opus-4-8", { contextWindow: 1_000_000, maxTokens: 128_000, inputPerMillion: 5, outputPerMillion: 25 }],
  ["claude-opus-4-7", { contextWindow: 1_000_000, maxTokens: 128_000, inputPerMillion: 5, outputPerMillion: 25 }],
  ["claude-opus-4-6", { contextWindow: 1_000_000, maxTokens: 128_000, inputPerMillion: 5, outputPerMillion: 25 }],
  // Sonnet 4.6 — 1M context, 64K output, $3 / $15.
  ["claude-sonnet-4-6", { contextWindow: 1_000_000, maxTokens: 64_000, inputPerMillion: 3, outputPerMillion: 15 }],
  // Haiku 4.5 — 200K context, 64K output, $1 / $5.
  ["claude-haiku-4-5", { contextWindow: 200_000, maxTokens: 64_000, inputPerMillion: 1, outputPerMillion: 5 }],
];

/**
 * Conservative default for an unknown model id: a 200K window and 16K output
 * cap (safe for every current Claude model) priced at the Sonnet-tier rate.
 * Documented so non-Sonnet usage isn't silently mis-accounted, but an
 * unrecognized id still gets a sane, non-zero estimate.
 */
const DEFAULT_MODEL_METADATA: ModelMetadata = {
  contextWindow: 200_000,
  maxTokens: 16_384,
  inputPerMillion: 3,
  outputPerMillion: 15,
};

/**
 * Fallback model id used when a caller dispatches an Anthropic call with a
 * missing/empty `model`. A bad caller (e.g. a SIGE session whose persisted
 * config predates a `model` field) must never crash the provider with an
 * opaque `undefined.toLowerCase()` TypeError; it falls back to this documented
 * default with a warn so the misconfiguration is visible in logs. Kept in sync
 * with the cheapest current Sonnet-tier id in MODEL_METADATA.
 */
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

/**
 * Resolve per-model metadata, failing safe on a missing/empty id. `modelId` is
 * typed `string` at the boundary, but a stale persisted config can still thread
 * `undefined`/`""` here at runtime; guard explicitly rather than letting
 * `.toLowerCase()` throw.
 */
export function resolveModelMetadata(modelId: string | undefined): ModelMetadata {
  if (!modelId) {
    log.warn("Missing model id — using conservative default metadata", { modelId });
    return DEFAULT_MODEL_METADATA;
  }
  const id = modelId.toLowerCase();
  for (const [prefix, meta] of MODEL_METADATA) {
    if (id.startsWith(prefix)) return meta;
  }
  log.warn("Unknown model id — using conservative default metadata", { modelId });
  return DEFAULT_MODEL_METADATA;
}

/** Cache reads bill at ~0.1x input; cache writes at ~1.25x input. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** A flattened, fully-accounted view of a pi-ai usage record. */
export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

/**
 * Flatten a pi-ai usage record into our accounting shape. With prompt caching on
 * (cacheRetention: "short"), Anthropic bills a fresh large prompt as cacheWrite
 * and a repeat as cacheRead — `input` is only the uncached remainder. The old
 * code logged just `input` (so a 6k-token prompt read as "3") and costed only
 * input+output (so cached prompts looked ~free). Prefer pi-ai's own cost (it
 * applies the model's per-token rates to every bucket); fall back to a FULL
 * estimate — including cache read + write — when cost is absent.
 *
 * `model` selects the per-token rates for the fallback estimate; omit it (or
 * pass an unknown id) to use the conservative Sonnet-tier default. Always
 * prefer passing the actual model so non-Sonnet usage is accounted correctly.
 */
export function summarizeUsage(
  usage: AssistantMessage["usage"] | undefined,
  model?: string,
): UsageSummary {
  const inputTokens = usage?.input ?? 0;
  const outputTokens = usage?.output ?? 0;
  const cacheReadTokens = usage?.cacheRead ?? 0;
  const cacheWriteTokens = usage?.cacheWrite ?? 0;
  const meta = model ? resolveModelMetadata(model) : DEFAULT_MODEL_METADATA;
  const inputPerToken = meta.inputPerMillion / 1_000_000;
  const outputPerToken = meta.outputPerMillion / 1_000_000;
  const costUsd =
    usage?.cost?.total ??
    (inputTokens * inputPerToken +
      outputTokens * outputPerToken +
      cacheReadTokens * inputPerToken * CACHE_READ_MULTIPLIER +
      cacheWriteTokens * inputPerToken * CACHE_WRITE_MULTIPLIER);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");

// OAuth beta headers — same as OpenClaw's PI_AI_OAUTH_ANTHROPIC_BETAS.
//
// `fine-grained-tool-streaming-2025-05-14` and `interleaved-thinking-2025-05-14`
// are GA on the 4.6+ family, but this set deliberately mirrors the Claude Code
// CLI's OAuth handshake (these are still accepted, harmless flags). The OAuth
// bearer path is sensitive to looking like the CLI, so we keep the exact set
// rather than trimming GA flags. `oauth-2025-04-20` is required on the OAuth
// path. Revisit only alongside the OAuth-emulation contract, not as a pure
// cleanup.
const OAUTH_BETA_HEADERS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "prompt-caching-2024-07-31",
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
].join(",");

// ─── OAuth Credential Management ─────────────────────────────────────────────

let _cachedCreds: OAuthCredentials | undefined;

async function readOAuthCredentials(): Promise<OAuthCredentials> {
  const raw = await readFile(CREDS_PATH, "utf-8");
  const parsed = JSON.parse(raw) as {
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
    };
  };
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "No OAuth token in ~/.claude/.credentials.json. Run 'claude login' first.",
    );
  }
  return {
    access: oauth.accessToken,
    refresh: oauth.refreshToken ?? "",
    expires: oauth.expiresAt ?? 0,
  };
}

/**
 * Get a valid API key using pi-ai's OAuth token refresh.
 * If the token is expired, pi-ai will refresh it automatically using
 * the same endpoint and client ID that OpenClaw uses.
 */
async function getApiKey(): Promise<string> {
  // Headless / container auth: a long-lived OAuth token supplied via
  // CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) takes precedence over the
  // on-disk ~/.claude/.credentials.json, which does not exist in Docker/CI. Used
  // directly as the OAuth bearer (the request already sends the oauth beta headers).
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  // Re-read credentials if we don't have them or they're about to expire
  if (!_cachedCreds || Date.now() > _cachedCreds.expires - 60_000) {
    _cachedCreds = await readOAuthCredentials();
  }

  try {
    // pi-ai getOAuthApiKey takes Record<string, OAuthCredentials>
    // Key MUST match the providerId ("anthropic") — getOAuthApiKey does credentials[providerId]
    const result = await getOAuthApiKey("anthropic", {
      anthropic: _cachedCreds,
    });

    if (result) {
      // Update cached credentials with refreshed ones
      _cachedCreds = result.newCredentials;
      return result.apiKey;
    }

    // Fallback: use access token directly
    return _cachedCreds.access;
  } catch (err) {
    // If refresh fails, re-read credentials (another process may have refreshed)
    log.warn("OAuth token refresh failed, re-reading credentials", { err });
    _cachedCreds = await readOAuthCredentials();
    return _cachedCreds.access;
  }
}

// ─── Model Builder ───────────────────────────────────────────────────────────

export function buildModel(modelId: string | undefined): Model<"anthropic-messages"> {
  // Fail safe on a missing/empty id: never send `model: undefined` to the
  // Anthropic API (which would 400) — fall back to a documented default with a
  // warn so the misconfigured caller is visible in logs.
  const resolvedId = modelId || DEFAULT_MODEL_ID;
  if (!modelId) {
    log.warn("Missing model id — falling back to default Anthropic model", {
      fallbackModel: resolvedId,
    });
  }
  // Source window / output cap / cost from per-model metadata so non-Sonnet
  // usage is accounted correctly instead of pinned to Sonnet 200K/16K/$3/$15.
  const meta = resolveModelMetadata(resolvedId);
  const inputPerToken = meta.inputPerMillion;
  const outputPerToken = meta.outputPerMillion;
  return {
    id: resolvedId,
    name: resolvedId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: inputPerToken,
      output: outputPerToken,
      cacheRead: inputPerToken * CACHE_READ_MULTIPLIER,
      cacheWrite: inputPerToken * CACHE_WRITE_MULTIPLIER,
    },
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    headers: {
      "anthropic-beta": OAUTH_BETA_HEADERS,
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/1.0.0 (external, cli)",
      "x-app": "cli",
    },
  };
}

// ─── Message Conversion ──────────────────────────────────────────────────────

function toPiMessages(
  messages: readonly ConversationMessage[],
): UserMessage[] {
  // For simple chat completions, all messages are sent as user messages.
  // Multi-turn conversations with assistant context are flattened into the
  // system prompt or handled by the caller before reaching here.
  // If there ARE assistant messages, we include them as context in the last
  // user message to avoid pi-ai type mismatches.
  if (messages.length <= 1 || messages.every((m) => m.role === "user")) {
    return messages.map((msg) => ({
      role: "user" as const,
      content: msg.content,
      timestamp: msg.timestamp,
    }));
  }

  // Flatten multi-turn into a single user message with conversation context
  const contextLines: string[] = [];
  for (const msg of messages.slice(0, -1)) {
    const prefix = msg.role === "assistant" ? "Assistant" : "User";
    contextLines.push(`${prefix}: ${msg.content}`);
  }
  const lastMsg = messages[messages.length - 1]!;
  const flattenedContent = contextLines.length > 0
    ? `Previous conversation:\n${contextLines.join("\n")}\n\nUser: ${lastMsg.content}`
    : lastMsg.content;

  return [{
    role: "user" as const,
    content: flattenedContent,
    timestamp: lastMsg.timestamp,
  }];
}

// ─── Public API ──────────────────────────────────────────────────────────────

function isTextBlock(
  block: AssistantMessage["content"][number],
): block is { type: "text"; text: string } {
  return block.type === "text";
}

export async function chat(
  messages: readonly ConversationMessage[],
  options: AgentOptions,
): Promise<AgentResponse> {
  log.debug("Sending message to Anthropic via pi-ai", {
    model: options.model,
    messageCount: messages.length,
  });

  const apiKey = await getApiKey();
  const model = buildModel(options.model);
  const piMessages = toPiMessages(messages);

  const streamOptions: SimpleStreamOptions = {
    apiKey,
    maxTokens: options.maxOutputTokens ?? 16384,
    cacheRetention: "short",
    // Wire the per-call deadline / external abort into the actual HTTP request
    // so a hung provider response is genuinely cancelled, not just flagged.
    ...(options.abortSignal ? { signal: options.abortSignal } : {}),
  };

  try {
    const response: AssistantMessage = await completeSimple(
      model,
      {
        systemPrompt: options.systemPrompt ?? undefined,
        messages: piMessages,
      },
      streamOptions,
    );

    const textBlocks = response.content.filter(isTextBlock);
    const text = textBlocks.map((b) => b.text).join("");

    if (!text) {
      const blockTypes = response.content.map((b) => b.type).join(", ");
      log.error("Anthropic response contained no text blocks", {
        model: options.model,
        blockTypes: blockTypes || "empty",
        contentLength: response.content.length,
        stopReason: response.stopReason,
        usage: response.usage,
      });
      throw new Error(
        `Anthropic response contained no text (blocks: [${blockTypes || "none"}], stopReason: ${response.stopReason ?? "unknown"})`,
      );
    }

    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } =
      summarizeUsage(response.usage, options.model);

    log.info("Anthropic pi-ai response received", {
      model: options.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: costUsd.toFixed(4),
    });

    return {
      text,
      provider: "anthropic",
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens: cacheWriteTokens,
        costUsd,
      },
    };
  } catch (error) {
    log.error("Anthropic pi-ai API error", { error });
    throw new Error(
      `Anthropic API error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
