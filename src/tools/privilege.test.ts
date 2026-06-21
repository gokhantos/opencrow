/**
 * Unit tests for src/tools/privilege.ts
 *
 * These tests are deterministic and touch no network/DB — pure logic only.
 * Lane: unit (*.test.ts) — run with `bun run test:unit`.
 */

import { describe, test, expect } from "bun:test";
import {
  HIGH_IMPACT_TOOLS,
  ADMIN_TOOLS,
  SDK_NATIVE_HIGH_IMPACT_TOOLS,
  DEFAULT_AGENT_TOOL_ALLOWLIST,
  FAIL_CLOSED_DEFAULT_TOOL_FILTER,
  isHighImpactTool,
  isAdminTool,
  isToolGranted,
  grantedHighImpactTools,
  buildAgentDisallowedNativeTools,
} from "./privilege";
import type { ToolFilter } from "../agents/types";

// ---------------------------------------------------------------------------
// HIGH_IMPACT_TOOLS membership
// ---------------------------------------------------------------------------

describe("HIGH_IMPACT_TOOLS", () => {
  const knownHighImpact = [
    "bash",
    "write_file",
    "edit_file",
    "process_manage",
    "self_restart",
    "cron",
    "trigger_cron",
    "cron_trigger",
    "spawn_agent",
    "db_query",
  ] as const;

  for (const name of knownHighImpact) {
    test(`contains "${name}"`, () => {
      expect(HIGH_IMPACT_TOOLS.has(name)).toBe(true);
    });
  }

  test("does NOT contain read-only tools like read_file", () => {
    expect(HIGH_IMPACT_TOOLS.has("read_file")).toBe(false);
  });

  test("does NOT contain search_memory", () => {
    expect(HIGH_IMPACT_TOOLS.has("search_memory")).toBe(false);
  });

  test("does NOT contain list_agents", () => {
    expect(HIGH_IMPACT_TOOLS.has("list_agents")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADMIN_TOOLS — strict subset of HIGH_IMPACT
// ---------------------------------------------------------------------------

describe("ADMIN_TOOLS", () => {
  const knownAdmin = ["spawn_agent", "process_manage", "self_restart"] as const;

  for (const name of knownAdmin) {
    test(`contains "${name}"`, () => {
      expect(ADMIN_TOOLS.has(name)).toBe(true);
    });

    test(`"${name}" is also in HIGH_IMPACT_TOOLS (subset invariant)`, () => {
      expect(HIGH_IMPACT_TOOLS.has(name)).toBe(true);
    });
  }

  test("does NOT contain bash (high-impact but not admin)", () => {
    expect(ADMIN_TOOLS.has("bash")).toBe(false);
  });

  test("does NOT contain db_query", () => {
    expect(ADMIN_TOOLS.has("db_query")).toBe(false);
  });

  test("every ADMIN tool is also HIGH_IMPACT", () => {
    for (const name of ADMIN_TOOLS) {
      expect(HIGH_IMPACT_TOOLS.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SDK_NATIVE_HIGH_IMPACT_TOOLS
// ---------------------------------------------------------------------------

describe("SDK_NATIVE_HIGH_IMPACT_TOOLS", () => {
  test("contains bash, write_file, edit_file", () => {
    expect(SDK_NATIVE_HIGH_IMPACT_TOOLS).toContain("bash");
    expect(SDK_NATIVE_HIGH_IMPACT_TOOLS).toContain("write_file");
    expect(SDK_NATIVE_HIGH_IMPACT_TOOLS).toContain("edit_file");
  });

  test("every entry is also in HIGH_IMPACT_TOOLS", () => {
    for (const name of SDK_NATIVE_HIGH_IMPACT_TOOLS) {
      expect(HIGH_IMPACT_TOOLS.has(name)).toBe(true);
    }
  });

  test("does NOT contain process_manage (that comes via MCP bridge, not SDK native)", () => {
    expect(SDK_NATIVE_HIGH_IMPACT_TOOLS).not.toContain("process_manage");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_AGENT_TOOL_ALLOWLIST — fail-closed defaults
// ---------------------------------------------------------------------------

describe("DEFAULT_AGENT_TOOL_ALLOWLIST", () => {
  const expectedReadOnly = [
    "read_file",
    "list_files",
    "grep",
    "glob",
    "list_skills",
    "use_skill",
    "remember",
    "search_memory",
  ] as const;

  for (const name of expectedReadOnly) {
    test(`includes read-only tool "${name}"`, () => {
      expect(DEFAULT_AGENT_TOOL_ALLOWLIST).toContain(name);
    });
  }

  // Critical: none of the HIGH_IMPACT tools must appear in the default allowlist.
  test("contains NO high-impact tool", () => {
    for (const name of DEFAULT_AGENT_TOOL_ALLOWLIST) {
      expect(HIGH_IMPACT_TOOLS.has(name)).toBe(false);
    }
  });

  test("contains NO admin tool", () => {
    for (const name of DEFAULT_AGENT_TOOL_ALLOWLIST) {
      expect(ADMIN_TOOLS.has(name)).toBe(false);
    }
  });

  // Spot-check specific dangerous tools are absent.
  const forbidden = [
    "bash",
    "write_file",
    "edit_file",
    "process_manage",
    "self_restart",
    "db_query",
    "spawn_agent",
    "cron",
    "trigger_cron",
  ] as const;

  for (const name of forbidden) {
    test(`does NOT contain dangerous tool "${name}"`, () => {
      expect(DEFAULT_AGENT_TOOL_ALLOWLIST).not.toContain(name);
    });
  }
});

// ---------------------------------------------------------------------------
// FAIL_CLOSED_DEFAULT_TOOL_FILTER
// ---------------------------------------------------------------------------

describe("FAIL_CLOSED_DEFAULT_TOOL_FILTER", () => {
  test("mode is allowlist, never all or blocklist", () => {
    expect(FAIL_CLOSED_DEFAULT_TOOL_FILTER.mode).toBe("allowlist");
  });

  test("tools list equals DEFAULT_AGENT_TOOL_ALLOWLIST", () => {
    expect(FAIL_CLOSED_DEFAULT_TOOL_FILTER.tools).toEqual(DEFAULT_AGENT_TOOL_ALLOWLIST);
  });

  test("contains no high-impact tool", () => {
    for (const name of FAIL_CLOSED_DEFAULT_TOOL_FILTER.tools) {
      expect(HIGH_IMPACT_TOOLS.has(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isHighImpactTool
// ---------------------------------------------------------------------------

describe("isHighImpactTool", () => {
  test("returns true for bash", () => {
    expect(isHighImpactTool("bash")).toBe(true);
  });

  test("returns true for db_query", () => {
    expect(isHighImpactTool("db_query")).toBe(true);
  });

  test("returns true for process_manage", () => {
    expect(isHighImpactTool("process_manage")).toBe(true);
  });

  test("returns false for read_file", () => {
    expect(isHighImpactTool("read_file")).toBe(false);
  });

  test("returns false for search_memory", () => {
    expect(isHighImpactTool("search_memory")).toBe(false);
  });

  test("returns false for completely unknown tool name", () => {
    expect(isHighImpactTool("totally_made_up_tool")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAdminTool
// ---------------------------------------------------------------------------

describe("isAdminTool", () => {
  test("returns true for spawn_agent", () => {
    expect(isAdminTool("spawn_agent")).toBe(true);
  });

  test("returns true for process_manage", () => {
    expect(isAdminTool("process_manage")).toBe(true);
  });

  test("returns true for self_restart", () => {
    expect(isAdminTool("self_restart")).toBe(true);
  });

  test("returns false for bash (high-impact but not admin)", () => {
    expect(isAdminTool("bash")).toBe(false);
  });

  test("returns false for db_query", () => {
    expect(isAdminTool("db_query")).toBe(false);
  });

  test("returns false for read_file", () => {
    expect(isAdminTool("read_file")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isToolGranted — the core invariant
// ---------------------------------------------------------------------------

describe("isToolGranted", () => {
  // mode:"all" must NOT grant any high-impact tool
  describe('mode:"all"', () => {
    const allFilter: ToolFilter = { mode: "all", tools: [] };

    test("grants a normal (non-high-impact) tool", () => {
      expect(isToolGranted(allFilter, "read_file")).toBe(true);
    });

    test("grants search_memory", () => {
      expect(isToolGranted(allFilter, "search_memory")).toBe(true);
    });

    test("does NOT grant bash even under mode:all", () => {
      expect(isToolGranted(allFilter, "bash")).toBe(false);
    });

    test("does NOT grant db_query even under mode:all", () => {
      expect(isToolGranted(allFilter, "db_query")).toBe(false);
    });

    test("does NOT grant process_manage even under mode:all", () => {
      expect(isToolGranted(allFilter, "process_manage")).toBe(false);
    });

    test("does NOT grant spawn_agent even under mode:all", () => {
      expect(isToolGranted(allFilter, "spawn_agent")).toBe(false);
    });

    test("does NOT grant self_restart even under mode:all", () => {
      expect(isToolGranted(allFilter, "self_restart")).toBe(false);
    });

    test("does NOT grant write_file even under mode:all", () => {
      expect(isToolGranted(allFilter, "write_file")).toBe(false);
    });

    test("does NOT grant edit_file even under mode:all", () => {
      expect(isToolGranted(allFilter, "edit_file")).toBe(false);
    });

    test("does NOT grant cron even under mode:all", () => {
      expect(isToolGranted(allFilter, "cron")).toBe(false);
    });

    test("does NOT grant trigger_cron even under mode:all", () => {
      expect(isToolGranted(allFilter, "trigger_cron")).toBe(false);
    });

    test("does NOT grant cron_trigger alias even under mode:all", () => {
      expect(isToolGranted(allFilter, "cron_trigger")).toBe(false);
    });
  });

  // mode:"allowlist" with no tools grants nothing
  describe('mode:"allowlist" empty', () => {
    const emptyAllowlist: ToolFilter = { mode: "allowlist", tools: [] };

    test("denies read_file when not listed", () => {
      expect(isToolGranted(emptyAllowlist, "read_file")).toBe(false);
    });

    test("denies bash when not listed", () => {
      expect(isToolGranted(emptyAllowlist, "bash")).toBe(false);
    });
  });

  // mode:"allowlist" with explicit high-impact grants them
  describe('mode:"allowlist" with explicit high-impact tools', () => {
    const filter: ToolFilter = {
      mode: "allowlist",
      tools: ["bash", "db_query", "spawn_agent", "read_file"],
    };

    test("grants bash when explicitly listed", () => {
      expect(isToolGranted(filter, "bash")).toBe(true);
    });

    test("grants db_query when explicitly listed", () => {
      expect(isToolGranted(filter, "db_query")).toBe(true);
    });

    test("grants spawn_agent when explicitly listed", () => {
      expect(isToolGranted(filter, "spawn_agent")).toBe(true);
    });

    test("grants read_file when listed", () => {
      expect(isToolGranted(filter, "read_file")).toBe(true);
    });

    test("denies write_file when not listed", () => {
      expect(isToolGranted(filter, "write_file")).toBe(false);
    });

    test("denies process_manage when not listed even though other admin tools are", () => {
      expect(isToolGranted(filter, "process_manage")).toBe(false);
    });
  });

  // mode:"blocklist" must NOT grant high-impact tools
  describe('mode:"blocklist"', () => {
    const blocklistFilter: ToolFilter = {
      mode: "blocklist",
      tools: ["list_files"], // blocking an innocuous tool
    };

    test("grants read_file (not in blocklist)", () => {
      expect(isToolGranted(blocklistFilter, "read_file")).toBe(true);
    });

    test("denies list_files (in blocklist)", () => {
      expect(isToolGranted(blocklistFilter, "list_files")).toBe(false);
    });

    test("does NOT grant bash even if not in blocklist", () => {
      expect(isToolGranted(blocklistFilter, "bash")).toBe(false);
    });

    test("does NOT grant db_query even if not in blocklist", () => {
      expect(isToolGranted(blocklistFilter, "db_query")).toBe(false);
    });

    test("does NOT grant spawn_agent even if not in blocklist", () => {
      expect(isToolGranted(blocklistFilter, "spawn_agent")).toBe(false);
    });

    // Attempts to un-block a high-impact tool via blocklist must fail closed:
    // putting it in `tools` means blocked — not putting it means it's still high-impact
    // and therefore never granted. Either way, no grant.
    const blocklistWithHighImpact: ToolFilter = {
      mode: "blocklist",
      tools: [], // nothing blocked — but high-impact is still never granted
    };

    test("does NOT grant bash via blocklist even with empty block list", () => {
      expect(isToolGranted(blocklistWithHighImpact, "bash")).toBe(false);
    });
  });

  // Validate all HIGH_IMPACT_TOOLS are excluded from every non-allowlist mode
  describe("invariant: all HIGH_IMPACT_TOOLS excluded from mode:all and mode:blocklist", () => {
    const allFilter: ToolFilter = { mode: "all", tools: [] };
    const blockFilter: ToolFilter = { mode: "blocklist", tools: [] };

    for (const name of HIGH_IMPACT_TOOLS) {
      test(`mode:all does not grant "${name}"`, () => {
        expect(isToolGranted(allFilter, name)).toBe(false);
      });

      test(`mode:blocklist does not grant "${name}"`, () => {
        expect(isToolGranted(blockFilter, name)).toBe(false);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// grantedHighImpactTools
// ---------------------------------------------------------------------------

describe("grantedHighImpactTools", () => {
  test("returns empty set for mode:all", () => {
    const filter: ToolFilter = { mode: "all", tools: [] };
    expect(grantedHighImpactTools(filter).size).toBe(0);
  });

  test("returns empty set for mode:blocklist", () => {
    const filter: ToolFilter = { mode: "blocklist", tools: [] };
    expect(grantedHighImpactTools(filter).size).toBe(0);
  });

  test("returns empty set for empty allowlist", () => {
    const filter: ToolFilter = { mode: "allowlist", tools: [] };
    expect(grantedHighImpactTools(filter).size).toBe(0);
  });

  test("returns only the high-impact tools from a mixed allowlist", () => {
    const filter: ToolFilter = {
      mode: "allowlist",
      tools: ["bash", "read_file", "db_query", "search_memory", "process_manage"],
    };
    const granted = grantedHighImpactTools(filter);
    expect(granted.has("bash")).toBe(true);
    expect(granted.has("db_query")).toBe(true);
    expect(granted.has("process_manage")).toBe(true);
    // Non-high-impact must NOT appear
    expect(granted.has("read_file")).toBe(false);
    expect(granted.has("search_memory")).toBe(false);
    expect(granted.size).toBe(3);
  });

  test("returns all declared high-impact tools for an explicit full-power allowlist", () => {
    const highImpactList = Array.from(HIGH_IMPACT_TOOLS);
    const filter: ToolFilter = { mode: "allowlist", tools: highImpactList };
    const granted = grantedHighImpactTools(filter);
    for (const name of highImpactList) {
      expect(granted.has(name)).toBe(true);
    }
    expect(granted.size).toBe(highImpactList.length);
  });
});

// ---------------------------------------------------------------------------
// buildAgentDisallowedNativeTools
// ---------------------------------------------------------------------------

describe("buildAgentDisallowedNativeTools", () => {
  test("disallows all SDK native tools when filter grants none", () => {
    const filter: ToolFilter = { mode: "allowlist", tools: [] };
    const disallowed = buildAgentDisallowedNativeTools(filter);
    for (const name of SDK_NATIVE_HIGH_IMPACT_TOOLS) {
      expect(disallowed).toContain(name);
    }
  });

  test("does NOT disallow a native tool that is explicitly granted", () => {
    const filter: ToolFilter = {
      mode: "allowlist",
      tools: ["bash", "write_file"],
    };
    const disallowed = buildAgentDisallowedNativeTools(filter);
    expect(disallowed).not.toContain("bash");
    expect(disallowed).not.toContain("write_file");
    // edit_file is not granted → still disallowed
    expect(disallowed).toContain("edit_file");
  });

  test("disallows all native tools under mode:all (high-impact not granted implicitly)", () => {
    const filter: ToolFilter = { mode: "all", tools: [] };
    const disallowed = buildAgentDisallowedNativeTools(filter);
    for (const name of SDK_NATIVE_HIGH_IMPACT_TOOLS) {
      expect(disallowed).toContain(name);
    }
  });

  test("disallows all native tools under mode:blocklist", () => {
    const filter: ToolFilter = { mode: "blocklist", tools: [] };
    const disallowed = buildAgentDisallowedNativeTools(filter);
    for (const name of SDK_NATIVE_HIGH_IMPACT_TOOLS) {
      expect(disallowed).toContain(name);
    }
  });

  test("returns empty array when all SDK native tools are explicitly granted", () => {
    const filter: ToolFilter = {
      mode: "allowlist",
      tools: Array.from(SDK_NATIVE_HIGH_IMPACT_TOOLS),
    };
    const disallowed = buildAgentDisallowedNativeTools(filter);
    expect(disallowed).toHaveLength(0);
  });
});
