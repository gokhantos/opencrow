import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restageMem0 } from "./mem0.ts";
import { nativePaths } from "./paths.ts";

// Guard-only coverage: when the sidecar was never provisioned (no .venv under
// mem0AppDir) restageMem0 must bail BEFORE touching git/launchctl, with an
// actionable message. This path runs no spawnSync, so it needs no mocking.
describe("restageMem0 guard", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "restage-mem0-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("throws an actionable error when the venv is absent (not provisioned)", async () => {
    const p = nativePaths(tmpHome);
    // mem0AppDir exists but has no .venv → treated as not provisioned.
    await fs.mkdir(p.mem0AppDir, { recursive: true });

    await expect(restageMem0(p, tmpHome)).rejects.toThrow(
      "mem0 sidecar not provisioned — run `opencrow native up` first",
    );
  });

  it("throws the same error when mem0AppDir itself does not exist", async () => {
    const p = nativePaths(tmpHome);

    await expect(restageMem0(p, tmpHome)).rejects.toThrow(
      "mem0 sidecar not provisioned — run `opencrow native up` first",
    );
  });
});
