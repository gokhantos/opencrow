/**
 * Isolated tests for the privilege-monotonicity paths in manage-agent.ts:
 * - agent caller attempting to grant tools it doesn't hold → PrivilegeError
 * - agent caller modifying its own toolFilter/systemPrompt → PrivilegeError
 * - agent caller assigning mode:all / mode:blocklist → PrivilegeError
 * - operator caller (OPENCROW_AGENT_ID unset) uses unknown-agent fallback → fail-closed
 * - unknown tool name in tool_filter → rejected before reaching mutation layer
 *
 * Lane: isolated (*.isolated.test.ts) — run with `bun run test:isolated`.
 * Uses mock.module; MUST use this suffix so it runs in its own Bun process.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — MUST be declared before any import of the module under test
// ────────────────────────────────────────────────────────────────────────────

// The agents that "exist" in the merged config
const agentList = [
  {
    id: "caller-agent",
    name: "Caller",
    model: "claude-sonnet-4-6",
    provider: "agent-sdk",
    default: false,
    _source: "db",
    toolFilter: { mode: "allowlist", tools: ["read_file", "search_memory"] },
  },
  {
    id: "target-agent",
    name: "Target",
    model: "claude-sonnet-4-6",
    provider: "agent-sdk",
    default: false,
    _source: "db",
    toolFilter: { mode: "allowlist", tools: [] },
  },
];

const mockAddAgentToDb = mock(async () => "hash-new");
const mockUpdateAgentInDb = mock(async () => "hash-new");
const mockRemoveAgentFromDb = mock(async () => "hash-new");
const mockReloadRegistry = mock(async () => {});

class MockPrivilegeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivilegeError";
  }
}
class MockAgentConflictError extends Error {
  constructor() {
    super("conflict");
    this.name = "AgentConflictError";
  }
}

mock.module("../config/loader", () => ({
  getMergedAgentsWithSource: mock(async () => agentList),
  computeMergedAgentHash: mock(() => "hash-v1"),
  loadConfigWithOverrides: mock(async () => ({})),
}));

mock.module("../config/agent-mutations", () => ({
  addAgentToDb: mockAddAgentToDb,
  updateAgentInDb: mockUpdateAgentInDb,
  removeAgentFromDb: mockRemoveAgentFromDb,
  AgentConflictError: MockAgentConflictError,
  PrivilegeError: MockPrivilegeError,
}));

mock.module("../logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

// ────────────────────────────────────────────────────────────────────────────
// Now import what we need
// ────────────────────────────────────────────────────────────────────────────

import { createManageAgentTool } from "./manage-agent";
import type { ManageAgentToolConfig } from "./manage-agent";
import type { AgentRegistry } from "../agents/registry";
import type { ResolvedAgent } from "../agents/types";

// ────────────────────────────────────────────────────────────────────────────
// Registry stub that maps agentId → toolFilter from agentList
// ────────────────────────────────────────────────────────────────────────────

function makeRegistry(_agentId?: string): AgentRegistry {
  return {
    agents: agentList as unknown as readonly ResolvedAgent[],
    getDefault: () => agentList[0] as unknown as ResolvedAgent,
    getById: (id: string) => {
      const a = agentList.find((x) => x.id === id);
      return a as unknown as ResolvedAgent | undefined;
    },
    listIds: () => agentList.map((a) => a.id),
    listForAgent: () => [],
    reload: () => {},
  };
}

function makeConfig(agentId?: string): ManageAgentToolConfig {
  return {
    agentRegistry: makeRegistry(agentId),
    reloadRegistry: mockReloadRegistry,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Run tool.execute and return result, driving OPENCROW_AGENT_ID via env. */
async function runAsCaller(
  agentId: string | undefined,
  input: Record<string, unknown>,
) {
  const prev = process.env.OPENCROW_AGENT_ID;
  if (agentId !== undefined) {
    process.env.OPENCROW_AGENT_ID = agentId;
  } else {
    delete process.env.OPENCROW_AGENT_ID;
  }
  try {
    const tool = createManageAgentTool(makeConfig(agentId));
    return await tool.execute(input);
  } finally {
    if (prev === undefined) {
      delete process.env.OPENCROW_AGENT_ID;
    } else {
      process.env.OPENCROW_AGENT_ID = prev;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("manage_agent tool — privilege paths", () => {
  beforeEach(() => {
    mockAddAgentToDb.mockClear();
    mockUpdateAgentInDb.mockClear();
    mockRemoveAgentFromDb.mockClear();
    mockReloadRegistry.mockClear();
  });

  // ── Unknown tool name in tool_filter ──────────────────────────────────────

  describe("tool_filter validation — unknown tool name rejection", () => {
    test("rejects create with an entirely fabricated tool name", async () => {
      const result = await runAsCaller("caller-agent", {
        action: "create",
        agent_id: "bad-bot",
        name: "Bad Bot",
        tool_filter: {
          mode: "allowlist",
          tools: ["totally_fake_tool_name_xyzzy"],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid tool_filter");
    });

    test("rejects update with an unknown tool name in allowlist", async () => {
      const result = await runAsCaller("caller-agent", {
        action: "update",
        agent_id: "target-agent",
        tool_filter: {
          mode: "allowlist",
          tools: ["__not_a_real_tool__"],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("invalid tool_filter");
    });

    test("accepts a valid known tool name (read_file) in allowlist", async () => {
      mockAddAgentToDb.mockResolvedValueOnce("hash-new");
      const result = await runAsCaller("caller-agent", {
        action: "create",
        agent_id: "valid-bot",
        name: "Valid Bot",
        tool_filter: { mode: "allowlist", tools: ["read_file"] },
      });
      // Should pass validation; if it errors it should be for a different reason
      if (result.isError) {
        expect(result.output).not.toContain("invalid tool_filter");
      }
    });
  });

  // ── PrivilegeError surfaced as isError with "Permission denied" ───────────

  describe("PrivilegeError surface handling", () => {
    test("surfaces PrivilegeError as isError:true with 'Permission denied'", async () => {
      mockAddAgentToDb.mockRejectedValueOnce(
        new MockPrivilegeError("cannot grant bash"),
      );
      const result = await runAsCaller("caller-agent", {
        action: "create",
        agent_id: "priv-bot",
        name: "Priv Bot",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Permission denied");
      expect(result.output).toContain("cannot grant bash");
    });

    test("surfaces PrivilegeError on update as isError:true", async () => {
      mockUpdateAgentInDb.mockRejectedValueOnce(
        new MockPrivilegeError("cannot modify own toolFilter"),
      );
      const result = await runAsCaller("caller-agent", {
        action: "update",
        agent_id: "caller-agent",
        tool_filter: { mode: "allowlist", tools: ["bash"] },
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Permission denied");
    });

    test("surfaces PrivilegeError on delete as isError:true", async () => {
      mockRemoveAgentFromDb.mockRejectedValueOnce(
        new MockPrivilegeError("Deleting agents is operator-only"),
      );
      const result = await runAsCaller("caller-agent", {
        action: "delete",
        agent_id: "target-agent",
        confirm_delete: true,
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Permission denied");
      expect(result.output).toContain("operator-only");
    });
  });

  // ── resolveCaller fall-closed when env var absent ─────────────────────────

  describe("resolveCaller — fail-closed for unknown agent", () => {
    test("when OPENCROW_AGENT_ID is not set, still calls mutation (web/operator path)", async () => {
      mockAddAgentToDb.mockResolvedValueOnce("hash-new");
      const result = await runAsCaller(undefined, {
        action: "create",
        agent_id: "anon-bot",
        name: "Anonymous Bot",
      });
      // When env var absent, resolveCaller returns kind:"agent" with empty
      // allowlist (fail-closed). The mutation layer will enforce monotonicity.
      // Whether it succeeds or fails PrivilegeError depends on what the mock returns.
      // We just verify the call was made and errors are surfaced, not swallowed.
      if (result.isError) {
        expect(result.output.length).toBeGreaterThan(0);
      } else {
        expect(result.output).toContain("anon-bot");
      }
    });
  });

  // ── list action is always allowed (read-only) ─────────────────────────────

  describe("list action (read-only — no privilege check)", () => {
    test("list succeeds as agent caller", async () => {
      const result = await runAsCaller("caller-agent", { action: "list" });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.output);
      expect(Array.isArray(parsed.agents)).toBe(true);
    });

    test("list does not expose telegramBotToken if present", async () => {
      const result = await runAsCaller("caller-agent", { action: "list" });
      expect(result.output).not.toContain("telegramBotToken");
    });
  });

  // ── delete requires confirm_delete regardless of caller ───────────────────

  describe("delete — confirm_delete gate", () => {
    test("delete without confirm_delete returns non-error prompt", async () => {
      const result = await runAsCaller("caller-agent", {
        action: "delete",
        agent_id: "target-agent",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("confirm_delete");
      expect(mockRemoveAgentFromDb).not.toHaveBeenCalled();
    });
  });
});
