// src/cli/native/mem0.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { NativePaths } from "./paths.ts";
import { MEM0_LABEL } from "./paths.ts";
import { buildInfraPlist } from "./plist.ts";
import { renderMem0Env } from "./mem0-env.ts";

function plistPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export async function provisionMem0(
  p: NativePaths,
  repoDir: string,
  secrets: { readonly internalToken: string; readonly llmApiKey: string },
): Promise<void> {
  const serverDir = path.join(repoDir, "mem0-server");
  const venv = path.join(serverDir, ".venv");
  const venvPython = path.join(venv, "bin", "python");
  const venvUvicorn = path.join(venv, "bin", "uvicorn");

  await fs.mkdir(p.mem0Dir, { recursive: true });
  await fs.mkdir(p.logDir, { recursive: true });

  const py = spawnSync("python3.11", ["-m", "venv", venv], { stdio: "inherit" });
  if (py.status !== 0) throw new Error("Failed to create mem0 venv (python3.11)");
  const pip = spawnSync(
    venvPython,
    ["-m", "pip", "install", "--quiet", "-r", path.join(serverDir, "requirements.txt")],
    { stdio: "inherit" },
  );
  if (pip.status !== 0) throw new Error("Failed to pip install mem0 requirements");

  await fs.writeFile(p.mem0EnvFile, renderMem0Env(p, secrets), { mode: 0o600 });

  // Wrapper sources the env file (chmod 600), then execs uvicorn — keeps secrets
  // out of the world-readable plist while still being a single ProgramArguments.
  const wrapper = path.join(p.mem0Dir, "run-mem0.sh");
  await fs.writeFile(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
set -a; source "${p.mem0EnvFile}"; set +a
exec "${venvUvicorn}" app:app --host 127.0.0.1 --port 8050
`,
    { mode: 0o700 },
  );

  const plist = buildInfraPlist({
    label: MEM0_LABEL,
    programArguments: ["/bin/bash", wrapper],
    workingDirectory: serverDir,
    stdoutPath: path.join(p.logDir, "mem0.log"),
    stderrPath: path.join(p.logDir, "mem0.err.log"),
  });
  const dest = plistPath(MEM0_LABEL);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, plist, "utf8");

  const domain = `gui/${process.getuid?.() ?? ""}`;
  spawnSync("launchctl", ["bootout", domain, dest], { stdio: "ignore" });
  const boot = spawnSync("launchctl", ["bootstrap", domain, dest], { stdio: "inherit" });
  if (boot.status !== 0) throw new Error("launchctl bootstrap (mem0) failed");
  spawnSync("launchctl", ["kickstart", "-k", `${domain}/${MEM0_LABEL}`], { stdio: "inherit" });
}
