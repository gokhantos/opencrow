// src/cli/native/provision.ts
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativePaths } from "./paths.ts";
import { provisionQdrant } from "./qdrant.ts";
import { provisionMem0 } from "./mem0.ts";
import { ensureOpencrowDb } from "./postgres.ts";
import { REQUIRED_FORMULAE, pgBinDir } from "./brew.ts";

function readEnv(repoDir: string): Record<string, string> {
  const envPath = path.join(repoDir, ".env");
  if (!fs.existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

export async function runNativeUp(): Promise<void> {
  const repoDir = process.cwd();
  const p = nativePaths(os.homedir());
  const w = process.stdout;

  const brewPrefix = spawnSync("brew", ["--prefix"], { encoding: "utf8" }).stdout?.trim();
  if (!brewPrefix) throw new Error("Homebrew not found — install from https://brew.sh");

  const installed = new Set(
    (spawnSync("brew", ["list", "--formula"], { encoding: "utf8" }).stdout ?? "").split("\n").map((s) => s.trim()),
  );
  const missing = REQUIRED_FORMULAE.filter((f) => !installed.has(f));
  if (missing.length > 0) {
    throw new Error(`Missing Homebrew formulae: ${missing.join(", ")}. Run: brew install ${missing.join(" ")}`);
  }

  w.write("Starting native Postgres (brew services)…\n");
  spawnSync("brew", ["services", "start", "postgresql@17"], { stdio: "inherit" });
  const pgReady = path.join(pgBinDir(brewPrefix), "pg_isready");
  for (let i = 0; i < 30; i++) {
    if (spawnSync(pgReady, ["-h", "127.0.0.1", "-p", "5432"]).status === 0) break;
    spawnSync("sleep", ["1"]);
  }

  const env = readEnv(repoDir);
  const internalToken = env["OPENCROW_INTERNAL_TOKEN"] ?? "";
  const llmApiKey = env["MEM0_LLM_API_KEY"] ?? "";
  if (!internalToken || !llmApiKey) {
    throw new Error("OPENCROW_INTERNAL_TOKEN and MEM0_LLM_API_KEY must be set in .env");
  }

  w.write("Ensuring Postgres role/db…\n");
  await ensureOpencrowDb(`postgres://${os.userInfo().username}@127.0.0.1:5432/postgres`);

  w.write("Provisioning Qdrant…\n");
  await provisionQdrant(p);

  w.write("Provisioning mem0…\n");
  await provisionMem0(p, repoDir, { internalToken, llmApiKey });

  w.write("\nNative stack up. Next: `bun run src/cli.ts doctor` then `bun run dev`.\n");
}
