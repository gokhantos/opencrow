/**
 * Isolated coverage proving synthesizeSignals never dispatches `model: undefined`.
 *
 * Regression guard for the live 2026-06-20 crash: a SIGE autonomous session
 * loaded a stale persisted config (no `model` field), so `config.model` was
 * undefined and was threaded straight into chat(), which crashed the Anthropic
 * provider with an opaque `undefined.toLowerCase()` TypeError. synthesizeSignals
 * must now resolve/default the model (mirroring the existing provider default)
 * so the model passed to chat() is always a concrete string.
 *
 * Uses mock.module on the narrowest dependency (../agent/chat) to capture the
 * options chat() received — no real HTTP, no DB.
 *
 * Lane: isolated (own process) because it uses mock.module.
 */
import { describe, expect, it, mock } from "bun:test";
import type { AgentOptions, ConversationMessage } from "../agent/types";

// Captures the options the LLM call received so we can assert on the threaded
// model/provider without making a real request.
// Boxed so the mock-closure write isn't lost to control-flow narrowing in the
// test bodies. `readOptions()` returns the union type to defeat the narrowing
// TS would otherwise apply after a reset + await (it can't see the closure
// write, so a direct field read narrows to `never`).
const captured: { options: AgentOptions | undefined } = { options: undefined };
const readOptions = (): AgentOptions | undefined => captured.options;

mock.module("../agent/chat", () => ({
  chat: (_messages: readonly ConversationMessage[], options: AgentOptions) => {
    captured.options = options;
    // Minimal valid synthesis payload so synthesizeSignals parses cleanly.
    return Promise.resolve({
      text: JSON.stringify({
        painClusters: [],
        emergingPatterns: [],
        gapSignals: [],
        collisionPoints: [],
      }),
      provider: options.provider,
    });
  },
}));

const { synthesizeSignals } = await import("./signal-synthesis");

const SEED = "- users hate setup\n- onboarding is slow";

describe("synthesizeSignals model threading", () => {
  it("defaults the model when the caller threads undefined (never model: undefined)", async () => {
    captured.options = undefined;
    // Cast: the runtime path that caused the crash passed an undefined model
    // despite the (former) `string` type — that is exactly what we guard.
    await synthesizeSignals(SEED, { model: undefined as unknown as string });
    const opts = readOptions();
    expect(opts).toBeDefined();
    expect(opts?.model).toBeTruthy();
    expect(opts?.model).toBe("claude-sonnet-4-6");
    // Provider still defaults to anthropic as before.
    expect(opts?.provider).toBe("anthropic");
  });

  it("defaults the model when the caller threads an empty string", async () => {
    captured.options = undefined;
    await synthesizeSignals(SEED, { model: "" });
    expect(readOptions()?.model).toBe("claude-sonnet-4-6");
  });

  it("passes through an explicit model and provider unchanged", async () => {
    captured.options = undefined;
    await synthesizeSignals(SEED, { model: "claude-opus-4-8", provider: "alibaba" });
    const opts = readOptions();
    expect(opts?.model).toBe("claude-opus-4-8");
    expect(opts?.provider).toBe("alibaba");
  });
});
