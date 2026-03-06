import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { realpathSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveAllowedDirs, expandHome, isPathAllowed, isPathAllowedSync } from "./path-utils";

describe("expandHome", () => {
  it("should expand ~ to home directory", () => {
    const home = process.env.HOME || "/home/user";
    const result = expandHome("~/test");
    expect(result).toBe(`${home}/test`);
  });

  it("should expand ~ alone to home directory", () => {
    const home = process.env.HOME || "/home/user";
    const result = expandHome("~");
    expect(result).toBe(home);
  });

  it("should not modify paths without ~", () => {
    const result = expandHome("/absolute/path");
    expect(result).toBe("/absolute/path");
  });

  it("should handle empty string", () => {
    const result = expandHome("");
    expect(result).toBe("");
  });

  it("should handle paths with ~ in the middle (not expanded)", () => {
    const result = expandHome("/path/~/test");
    expect(result).toBe("/path/~/test");
  });

  it("should expand $HOME syntax", () => {
    const home = process.env.HOME || "/home/user";
    const result = expandHome("$HOME/test");
    expect(result).toBe(`${home}/test`);
  });
});

describe("resolveAllowedDirs", () => {
  it("should resolve relative paths to absolute", () => {
    const cwd = process.cwd();
    const result = resolveAllowedDirs(["./test"]);
    expect(result[0]).toBe(`${cwd}/test`);
  });

  it("should expand $HOME in paths", () => {
    const home = process.env.HOME || "/home/user";
    const result = resolveAllowedDirs(["$HOME/test"]);
    expect(result[0]).toBe(`${home}/test`);
  });

  it("should resolve existing paths through symlinks", () => {
    // Use an existing dir so realpathSync works inside resolveAllowedDirs
    const tmp = mkdtempSync(join(tmpdir(), "pathtest-"));
    const result = resolveAllowedDirs([tmp]);
    expect(result[0]).toBe(realpathSync(tmp));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("should handle empty array", () => {
    const result = resolveAllowedDirs([]);
    expect(result).toEqual([]);
  });

  it("should handle multiple existing paths", () => {
    const tmp1 = mkdtempSync(join(tmpdir(), "pathtest1-"));
    const tmp2 = mkdtempSync(join(tmpdir(), "pathtest2-"));
    const result = resolveAllowedDirs([tmp1, tmp2]);
    expect(result).toEqual([realpathSync(tmp1), realpathSync(tmp2)]);
    rmSync(tmp1, { recursive: true, force: true });
    rmSync(tmp2, { recursive: true, force: true });
  });
});

describe("isPathAllowed", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pathallow-"));
    mkdirSync(join(tempDir, "subdir"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should allow paths within allowed directories", async () => {
    const allowedDirs = resolveAllowedDirs([tempDir]);
    expect(await isPathAllowed(join(tempDir, "file.txt"), allowedDirs)).toBe(true);
    expect(await isPathAllowed(join(tempDir, "subdir", "file.txt"), allowedDirs)).toBe(true);
  });

  it("should reject paths outside allowed directories", async () => {
    const allowedDirs = resolveAllowedDirs([tempDir]);
    expect(await isPathAllowed("/etc/passwd", allowedDirs)).toBe(false);
  });

  it("should allow file within allowed directory", async () => {
    const allowedDirs = resolveAllowedDirs([tempDir]);
    expect(await isPathAllowed(join(tempDir, "file.txt"), allowedDirs)).toBe(true);
  });

  it("should handle trailing slashes", async () => {
    const allowedDirs = resolveAllowedDirs([tempDir]);
    expect(await isPathAllowed(join(tempDir, "file.txt"), allowedDirs)).toBe(true);
  });

  it("should reject path traversal attempts", async () => {
    const allowedDirs = resolveAllowedDirs([join(tempDir, "subdir")]);
    expect(await isPathAllowed(join(tempDir, "subdir", "..", "etc", "passwd"), allowedDirs)).toBe(false);
  });
});

describe("isPathAllowedSync", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "pathsync-")));
    mkdirSync(join(tempDir, "subdir"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should allow paths within allowed directories", () => {
    const allowedDirs = [tempDir];
    expect(isPathAllowedSync(join(tempDir, "file.txt"), allowedDirs)).toBe(true);
    expect(isPathAllowedSync(join(tempDir, "subdir", "file.txt"), allowedDirs)).toBe(true);
  });

  it("should reject paths outside allowed directories", () => {
    const allowedDirs = [tempDir];
    expect(isPathAllowedSync("/etc/passwd", allowedDirs)).toBe(false);
  });

  it("should allow file within allowed directory", () => {
    const allowedDirs = [tempDir];
    expect(isPathAllowedSync(join(tempDir, "file.txt"), allowedDirs)).toBe(true);
  });

  it("should handle trailing slashes", () => {
    const allowedDirs = [tempDir];
    expect(isPathAllowedSync(join(tempDir, "file.txt"), allowedDirs)).toBe(true);
  });

  it("should reject path traversal attempts", () => {
    const allowedDirs = [join(tempDir, "subdir")];
    expect(isPathAllowedSync(join(tempDir, "subdir", "..", "etc", "passwd"), allowedDirs)).toBe(false);
  });
});
