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
  secrets: {
    readonly internalToken: string;
    readonly llmApiKey: string;
    readonly neo4jPassword: string;
  },
): Promise<void> {
  // Source files live in the repo; app + venv are staged OUTSIDE the repo to
  // avoid macOS TCC "Operation not permitted" when launchd accesses ~/Desktop.
  const serverSrc = path.join(repoDir, "mem0-server");
  const appDir = p.mem0AppDir;
  const venv = path.join(appDir, ".venv");
  const venvUvicorn = path.join(venv, "bin", "uvicorn");

  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(p.logDir, { recursive: true });

  // Copy app.py into the staging dir so uvicorn's cwd is TCC-safe.
  await fs.copyFile(path.join(serverSrc, "app.py"), path.join(appDir, "app.py"));

  // Bug fix #1: create venv with uv (self-contained CPython) instead of
  // python3.11 -m venv, which fails on up-to-date macOS because Homebrew's
  // python@3.11 resolves pyexpat to /usr/lib/libexpat.1.dylib (missing symbol).
  const uv = spawnSync("uv", ["venv", "--python", "3.11", "--seed", venv], { stdio: "inherit" });
  if (uv.status !== 0) {
    throw new Error(
      `Failed to create mem0 venv (uv): ${uv.error?.message ?? `exited ${uv.status}`}`,
    );
  }

  const uvPip = spawnSync(
    "uv",
    ["pip", "install", "--python", path.join(venv, "bin", "python"), "-r", path.join(serverSrc, "requirements.txt")],
    { stdio: "inherit" },
  );
  if (uvPip.status !== 0) {
    throw new Error(
      `Failed to uv pip install mem0 requirements: ${uvPip.error?.message ?? `exited ${uvPip.status}`}`,
    );
  }

  // Env file: mode 0o600, secrets stay here — never written to the plist.
  await fs.writeFile(p.mem0EnvFile, renderMem0Env(p, secrets), { mode: 0o600 });
  await fs.chmod(p.mem0EnvFile, 0o600);

  // Wrapper sources the env file (chmod 600), then execs uvicorn — keeps secrets
  // out of the world-readable plist while still being a single ProgramArguments.
  // Bug fix #2: cd into appDir (TCC-safe, outside ~/Desktop) so uvicorn finds app.py.
  const wrapper = path.join(p.mem0Dir, "run-mem0.sh");
  await fs.writeFile(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
set -a; source "${p.mem0EnvFile}"; set +a
cd "${appDir}"
exec "${venvUvicorn}" app:app --host 127.0.0.1 --port 8050
`,
    { mode: 0o700 },
  );
  await fs.chmod(wrapper, 0o700);

  const plist = buildInfraPlist({
    label: MEM0_LABEL,
    programArguments: ["/bin/bash", wrapper],
    workingDirectory: appDir,
    stdoutPath: path.join(p.logDir, "mem0.log"),
    stderrPath: path.join(p.logDir, "mem0.err.log"),
    // Defense-in-depth thread cap. Steady-state is ~20-30 threads under a
    // sustained backfill (app.py removes the mem0 per-write PostHog thread leak —
    // the real fix). This bound is ~25x that headroom so it never trips normally,
    // but if a future mem0/driver regression starts leaking threads again, it caps
    // the blast radius to this service (launchd restarts it) instead of exhausting
    // the host-wide maxproc (default 4000) and wedging Postgres/Qdrant/Neo4j too.
    // NOT a substitute for the source fix — a raised limit alone would only delay
    // a true leak hitting the wall.
    processLimit: 768,
  });
  const dest = plistPath(MEM0_LABEL);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, plist, "utf8");

  const domain = `gui/${process.getuid?.() ?? ""}`;
  spawnSync("launchctl", ["bootout", domain, dest], { stdio: "ignore" });
  const boot = spawnSync("launchctl", ["bootstrap", domain, dest], { stdio: "inherit" });
  if (boot.status !== 0) {
    throw new Error(
      `launchctl bootstrap (mem0) failed: ${boot.error?.message ?? `exited ${boot.status}`}`,
    );
  }
  const kick = spawnSync("launchctl", ["kickstart", "-k", `${domain}/${MEM0_LABEL}`], {
    stdio: "inherit",
  });
  if (kick.status !== 0) {
    throw new Error(
      `launchctl kickstart (mem0) failed: ${kick.error?.message ?? `exited ${kick.status}`}`,
    );
  }
}
