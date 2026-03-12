import { test, expect, describe } from "bun:test";
import { createChannelRegistry } from "./registry";
import type { ChannelPlugin } from "./plugin-types";
import type { OpenCrowConfig } from "../config/schema";

const mockPlugin = (id: string, order: number, enabled = true): ChannelPlugin =>
  ({
    id,
    meta: { order, name: id, icon: "" },
    config: {
      isEnabled: () => enabled,
      getAllowedSenders: () => [],
      getSnapshot: () => ({ enabled, connected: false }),
    },
  }) as unknown as ChannelPlugin;

// Minimal config stub — isEnabled ignores config in these mocks
const cfg = {} as OpenCrowConfig;

describe("createChannelRegistry", () => {
  test("empty registry returns empty list", () => {
    const registry = createChannelRegistry();
    expect(registry.list()).toEqual([]);
  });

  test("register and retrieve by id", () => {
    const registry = createChannelRegistry();
    const plugin = mockPlugin("telegram", 1);
    registry.register(plugin);
    expect(registry.get("telegram")).toBe(plugin);
  });

  test("get returns undefined for unknown id", () => {
    const registry = createChannelRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("list returns registered plugin", () => {
    const registry = createChannelRegistry();
    registry.register(mockPlugin("telegram", 1));
    expect(registry.list()).toHaveLength(1);
  });

  test("list returns plugins sorted by order ascending", () => {
    const registry = createChannelRegistry();
    registry.register(mockPlugin("whatsapp", 2));
    registry.register(mockPlugin("telegram", 1));
    const ids = registry.list().map((p) => p.id);
    expect(ids).toEqual(["telegram", "whatsapp"]);
  });

  test("registering multiple plugins, list returns all sorted", () => {
    const registry = createChannelRegistry();
    registry.register(mockPlugin("c", 3));
    registry.register(mockPlugin("a", 1));
    registry.register(mockPlugin("b", 2));
    const ids = registry.list().map((p) => p.id);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  test("getEnabled filters out disabled plugins", () => {
    const registry = createChannelRegistry();
    registry.register(mockPlugin("telegram", 1, true));
    registry.register(mockPlugin("whatsapp", 2, false));
    const enabled = registry.getEnabled(cfg);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.id).toBe("telegram");
  });

  test("getEnabled with no enabled plugins returns empty array", () => {
    const registry = createChannelRegistry();
    registry.register(mockPlugin("telegram", 1, false));
    registry.register(mockPlugin("whatsapp", 2, false));
    expect(registry.getEnabled(cfg)).toEqual([]);
  });

  test("getEnabled respects sort order", () => {
    const registry = createChannelRegistry();
    registry.register(mockPlugin("z-channel", 10, true));
    registry.register(mockPlugin("a-channel", 1, true));
    registry.register(mockPlugin("m-channel", 5, true));
    const ids = registry.getEnabled(cfg).map((p) => p.id);
    expect(ids).toEqual(["a-channel", "m-channel", "z-channel"]);
  });

  test("registering same id overwrites previous plugin", () => {
    const registry = createChannelRegistry();
    const first = mockPlugin("telegram", 1);
    const second = mockPlugin("telegram", 2);
    registry.register(first);
    registry.register(second);
    expect(registry.get("telegram")).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });
});
