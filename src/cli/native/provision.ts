// src/cli/native/provision.ts
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativePaths } from "./paths.ts";
import { provisionQdrant } from "./qdrant.ts";
import { provisionMem0 } from "./mem0.ts";
import { provisionNeo4j } from "./neo4j.ts";
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

/**
 * Read an existing secret from .env, or generate + persist a new one (appended
 * to .env, preserving everything else). Mirrors how setup.ts reuses-or-mints
 * OPENCROW_INTERNAL_TOKEN: .env is the single native secrets store. Idempotent —
 * re-running `native up` keeps the same value so the Neo4j auth store and the
 * mem0 env file stay in sync.
 */
function ensureEnvSecret(repoDir: string, key: string): string {
  const envPath = path.join(repoDir, ".env");
  const existing = readEnv(repoDir)[key];
  if (existing) return existing;
  const value = crypto.randomBytes(24).toString("hex");
  const prefix = fs.existsSync(envPath) && fs.readFileSync(envPath, "utf8").endsWith("\n") ? "" : "\n";
  // .env holds NEO4J_PASSWORD, OPENCROW tokens, and API keys. Open with mode
  // 0600 so a freshly-created file is never momentarily world/group-readable,
  // then chmod to tighten an existing file that may have looser perms.
  const fd = fs.openSync(envPath, "a", 0o600);
  try {
    fs.writeSync(fd, `${prefix}${key}=${value}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(envPath, 0o600);
  return value;
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

  // mem0 provisioning now uses uv for venv creation (avoids broken pyexpat on macOS).
  const uvCheck = spawnSync("uv", ["--version"]);
  if (uvCheck.status !== 0 || uvCheck.error) {
    throw new Error("uv not found — install it: brew install uv");
  }

  w.write("Starting native Postgres (brew services)…\n");
  const brewResult = spawnSync("brew", ["services", "start", "postgresql@17"], { stdio: "inherit" });
  if (brewResult.status !== 0 && brewResult.status !== null) {
    w.write("Warning: brew services start postgresql@17 returned non-zero status\n");
  }
  const pgReady = path.join(pgBinDir(brewPrefix), "pg_isready");
  for (let i = 0; i < 30; i++) {
    if (spawnSync(pgReady, ["-h", "127.0.0.1", "-p", "5432"]).status === 0) break;
    spawnSync("sleep", ["1"]);
  }
  if (spawnSync(pgReady, ["-h", "127.0.0.1", "-p", "5432"]).status !== 0) {
    throw new Error("Postgres did not become ready on 127.0.0.1:5432 after 30s");
  }

  const env = readEnv(repoDir);
  const internalToken = env["OPENCROW_INTERNAL_TOKEN"] ?? "";
  const llmApiKey = env["MEM0_LLM_API_KEY"] ?? "";
  const missingKeys = [
    !internalToken && "OPENCROW_INTERNAL_TOKEN",
    !llmApiKey && "MEM0_LLM_API_KEY",
  ].filter(Boolean);
  if (missingKeys.length > 0) {
    throw new Error(`Missing required keys in .env: ${missingKeys.join(", ")}`);
  }

  // Neo4j password: generated once and persisted to .env, then reused on every
  // re-provision so the auth store and mem0's env file stay in sync.
  const neo4jPassword = ensureEnvSecret(repoDir, "NEO4J_PASSWORD");

  w.write("Ensuring Postgres role/db…\n");
  await ensureOpencrowDb(`postgres://${os.userInfo().username}@127.0.0.1:5432/postgres`);

  w.write("Provisioning Qdrant…\n");
  await provisionQdrant(p);

  // Neo4j BEFORE mem0: mem0's init connects to Bolt during from_config(), so the
  // graph store must be reachable first.
  w.write("Provisioning Neo4j…\n");
  await provisionNeo4j(neo4jPassword, w);

  w.write("Provisioning mem0…\n");
  await provisionMem0(p, repoDir, { internalToken, llmApiKey, neo4jPassword });

  w.write("\nNative stack up. Next: `bun run src/cli.ts doctor` then `bun run dev`.\n");
}
