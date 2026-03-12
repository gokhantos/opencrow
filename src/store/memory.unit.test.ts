import { describe, it, expect } from "bun:test";
import { formatMemoryBlock, type MemoryEntry } from "./memory";

describe("formatMemoryBlock", () => {
  it("returns empty string for empty entries", () => {
    expect(formatMemoryBlock([])).toBe("");
  });

  it("formats a single entry", () => {
    const entries: MemoryEntry[] = [
      { key: "goal", value: "ship feature", updatedAt: 1000 },
    ];
    expect(formatMemoryBlock(entries)).toBe(
      "## Your Memory\n- goal: ship feature",
    );
  });

  it("formats multiple entries with newlines", () => {
    const entries: MemoryEntry[] = [
      { key: "name", value: "Alice", updatedAt: 1000 },
      { key: "role", value: "engineer", updatedAt: 2000 },
      { key: "team", value: "platform", updatedAt: 3000 },
    ];
    const result = formatMemoryBlock(entries);
    expect(result).toBe(
      "## Your Memory\n- name: Alice\n- role: engineer\n- team: platform",
    );
  });

  it("preserves special characters in values", () => {
    const entries: MemoryEntry[] = [
      { key: "note", value: "uses: TypeScript & React", updatedAt: 1000 },
    ];
    expect(formatMemoryBlock(entries)).toContain(
      "- note: uses: TypeScript & React",
    );
  });
});
