// src/cli/native/qdrant.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { NativePaths } from "./paths.ts";
import { QDRANT_LABEL } from "./paths.ts";
import { buildInfraPlist } from "./plist.ts";
import { QDRANT_VERSION, qdrantDownloadUrl, renderQdrantConfig } from "./qdrant-config.ts";

function plistPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadBinary(p: NativePaths): Promise<void> {
  const url = qdrantDownloadUrl(QDRANT_VERSION, "aarch64");
  const tmp = path.join(os.tmpdir(), "qdrant.tar.gz");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Qdrant download failed: ${res.status} ${url}`);
  await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fs.mkdir(p.bin, { recursive: true });
  const tar = spawnSync("tar", ["-xzf", tmp, "-C", p.bin, "qdrant"], {
    stdio: "inherit",
  });
  if (tar.status !== 0) throw new Error("Failed to extract qdrant binary");
  await fs.chmod(p.qdrantBinary, 0o755);
}

export async function provisionQdrant(p: NativePaths): Promise<void> {
  await fs.mkdir(p.qdrantStorage, { recursive: true });
  await fs.mkdir(p.logDir, { recursive: true });
  if (!(await exists(p.qdrantBinary))) await downloadBinary(p);

  await fs.writeFile(p.qdrantConfig, renderQdrantConfig(p), "utf8");

  const plist = buildInfraPlist({
    label: QDRANT_LABEL,
    programArguments: [p.qdrantBinary, "--config-path", p.qdrantConfig],
    workingDirectory: path.dirname(p.qdrantStorage),
    stdoutPath: path.join(p.logDir, "qdrant.log"),
    stderrPath: path.join(p.logDir, "qdrant.err.log"),
  });
  const dest = plistPath(QDRANT_LABEL);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, plist, "utf8");

  const domain = `gui/${process.getuid?.() ?? ""}`;
  spawnSync("launchctl", ["bootout", domain, dest], { stdio: "ignore" });
  const boot = spawnSync("launchctl", ["bootstrap", domain, dest], { stdio: "inherit" });
  if (boot.status !== 0) throw new Error("launchctl bootstrap (qdrant) failed");
  spawnSync("launchctl", ["kickstart", "-k", `${domain}/${QDRANT_LABEL}`], { stdio: "inherit" });
}
