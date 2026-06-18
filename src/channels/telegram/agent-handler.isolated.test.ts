/**
 * Isolated tests for the fail-closed allowedUserIds gate in createAgentBotHandler.
 *
 * Security invariant: an empty allowedUserIds list MUST deny every message
 * (fail-closed). A non-empty list only allows senders whose numeric ID
 * appears in the list.
 *
 * These tests use mock.module to stub every heavy dependency (DB, chat SDK,
 * session store, activity log) so that:
 *  1. The test runs without Postgres.
 *  2. We can assert that the handler body is never reached when access is denied.
 *  3. We can assert that the handler body IS reached when access is granted.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Channel, IncomingMessage, MessageHandler, MessageContent } from "../types";

// ---------------------------------------------------------------------------
// Module stubs — must be declared before the dynamic import below.
// ---------------------------------------------------------------------------

const mockChat = mock(async () => ({
  text: "response",
  toolUseCount: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
}));

const mockAddUserMessage = mock(async () => {});
const mockAddAssistantMessage = mock(async () => {});
const mockGetSessionHistory = mock(async () => []);
const mockClearSession = mock(async () => {});
const mockClearAllSdkSessions = mock(async () => {});
const mockGetSdkSessionId = mock(async () => null);
const mockSaveSdkSessionId = mock(async () => {});
const mockClearSdkSession = mock(async () => {});

const mockTrackerStart = mock(async () => {});
const mockTrackerFinalize = mock(async () => {});
const mockTrackerOnProgress = mock(() => {});
const mockCreateActivityLog = mock(() => ({
  start: mockTrackerStart,
  finalize: mockTrackerFinalize,
  onProgress: mockTrackerOnProgress,
}));

mock.module("../../agent/chat", () => ({ chat: mockChat }));
mock.module("../../agent/chunk", () => ({
  chunkMessage: (text: string) => [text],
}));
mock.module("../../agent/session", () => ({
  getSessionHistory: mockGetSessionHistory,
  addUserMessage: mockAddUserMessage,
  addAssistantMessage: mockAddAssistantMessage,
  clearSession: mockClearSession,
}));
mock.module("../../store/sdk-sessions", () => ({
  getSdkSessionId: mockGetSdkSessionId,
  saveSdkSessionId: mockSaveSdkSessionId,
  clearSdkSession: mockClearSdkSession,
  clearAllSdkSessions: mockClearAllSdkSessions,
}));
mock.module("../../router/activity-log", () => ({
  createActivityLog: mockCreateActivityLog,
}));
mock.module("../../logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// Dynamic import AFTER all mock.module calls.
const { createAgentBotHandler } = await import("./agent-handler");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ResolvedAgent-shaped object for the tests.
 */
function makeAgent(id = "test-agent") {
  return {
    id,
    name: "Test Agent",
    description: "a test agent",
    default: false,
    provider: "agent-sdk" as const,
    model: "claude-sonnet-4-6",
    systemPrompt: "You are helpful.",
    maxIterations: undefined,
    toolFilter: { mode: "all" as const, tools: [] },
    subagents: { allowAgents: [], maxChildren: 0 },
    mcpServers: {},
    skills: [],
    category: "coding" as const,
  };
}

/**
 * Build a Channel stub that captures the onMessage callback so we can invoke
 * it directly in tests. Keeps a log of sent messages.
 */
function makeChannelStub() {
  let capturedHandler: MessageHandler | null = null;
  const sentMessages: Array<{ chatId: string; content: MessageContent }> = [];

  const channel: Channel = {
    name: "telegram" as const,
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async (chatId: string, content: MessageContent) => {
      sentMessages.push({ chatId, content });
    },
    onMessage: (handler: MessageHandler) => {
      capturedHandler = handler;
    },
    isConnected: () => true,
  };

  return {
    channel,
    sentMessages,
    trigger: async (msg: IncomingMessage) => {
      if (!capturedHandler) throw new Error("onMessage was never registered");
      await capturedHandler(msg);
    },
  };
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: "msg-1",
    channel: "telegram" as const,
    chatId: "chat-100",
    senderId: "42",
    senderName: "Alice",
    content: { text: "hello" },
    timestamp: 1_000_000,
    ...overrides,
  };
}

const noBuildOptions = async () => ({
  provider: "agent-sdk" as const,
  model: "claude-sonnet-4-6",
  systemPrompt: "...",
  agentId: "test-agent",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAgentBotHandler — fail-closed allowedUserIds gate", () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockAddUserMessage.mockClear();
    mockGetSessionHistory.mockClear();
    mockCreateActivityLog.mockClear();
  });

  test("(a) empty allowedUserIds → message is denied; chat is never called", async () => {
    const { channel, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [], // empty — fail-closed
      buildOptions: noBuildOptions,
    });

    await trigger(makeMessage({ senderId: "99999" }));

    // The handler must not reach the AI layer.
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockAddUserMessage).not.toHaveBeenCalled();
  });

  test("(a) empty allowedUserIds revert check — if we made it fail-open this test would catch it", async () => {
    // This test is structurally identical to (a), but framed as a regression
    // guard: if someone reverts to the old fail-open behaviour (where an
    // empty list means "allow all"), chat() would be called and the assertion
    // below would fail.
    const { channel, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [],
      buildOptions: noBuildOptions,
    });

    await trigger(makeMessage({ senderId: "12345" }));

    expect(mockChat).not.toHaveBeenCalled();
  });

  test("(b) non-empty list but senderId NOT in list → message is dropped; chat is never called", async () => {
    const { channel, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [100, 200], // 42 is not in the list
      buildOptions: noBuildOptions,
    });

    await trigger(makeMessage({ senderId: "42" })); // 42 not in [100, 200]

    expect(mockChat).not.toHaveBeenCalled();
    expect(mockAddUserMessage).not.toHaveBeenCalled();
  });

  test("(b) non-empty list and senderId NOT in list — no reply sent to channel either", async () => {
    const { channel, sentMessages, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [111],
      buildOptions: noBuildOptions,
    });

    await trigger(makeMessage({ senderId: "999" }));

    // Silent drop — no message back to the user.
    expect(sentMessages).toHaveLength(0);
  });

  test("(c) senderId IS in allowedUserIds → message proceeds to the AI layer", async () => {
    const { channel, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [42, 100], // 42 is allowed
      buildOptions: noBuildOptions,
    });

    await trigger(makeMessage({ senderId: "42" }));

    // chat() should have been invoked.
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  test("(c) senderId in list as string-encoded number — numeric comparison works", async () => {
    // The handler converts senderId via Number() before comparing.
    const { channel, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [7],
      buildOptions: noBuildOptions,
    });

    await trigger(makeMessage({ senderId: "7" }));

    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  test("(c) second user in list is allowed; first user denied proves list specificity", async () => {
    const { channel, trigger } = makeChannelStub();

    createAgentBotHandler({
      agent: makeAgent(),
      channel,
      allowedUserIds: [200, 300],
      buildOptions: noBuildOptions,
    });

    // Denied
    await trigger(makeMessage({ senderId: "99", chatId: "chat-1" }));
    expect(mockChat).not.toHaveBeenCalled();

    // Allowed
    await trigger(makeMessage({ senderId: "300", chatId: "chat-2" }));
    expect(mockChat).toHaveBeenCalledTimes(1);
  });
});
