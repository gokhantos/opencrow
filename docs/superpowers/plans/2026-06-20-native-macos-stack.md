# Native macOS Stack (de-Colima) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run OpenCrow's Postgres + Qdrant + mem0 + app natively on macOS and tear down the local Colima VM, keeping `docker-compose.yml`/Dockerfiles for a future Linux server.

**Architecture:** Postgres via Homebrew (`brew services`); Qdrant via a pinned arm64 release binary under `~/.opencrow/bin` managed by a launchd plist; mem0 via a Python venv + uvicorn under a launchd plist; the Bun app via its existing `service core/web install`. A new `src/cli/native/` module provisions all of this and a `scripts/migrate-to-native.sh` one-shot copies data out of the Docker volumes. The app needs **zero** code changes — its config defaults already target `127.0.0.1`.

**Tech Stack:** Bun, TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Biome, launchd, Homebrew, Python 3.11, Qdrant 1.13.2, Postgres 17.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-20-native-macos-stack-design.md`.
- All work in an isolated worktree under `.claude/worktrees/` on branch `feat/native-macos-stack`; run `bun install` in it before any check (new worktree has no `node_modules`; `tsc` falsely exits 0 otherwise).
- Integrate via PR to `origin/master` only. Never merge/reset the shared local `master`.
- Immutability: never mutate inputs; return new objects. Domain types `readonly`.
- Strict TS: `import type` for type-only imports; index access is `T | undefined`.
- Logging via `createLogger("scope")`, never bare `console.log` in `src/`. CLI user-facing output uses the existing `stdout.write` / `@clack/prompts` pattern already in `src/cli/`.
- Lint/format: Biome (2-space, double quotes, semicolons, trailing commas, width 100). Run `bun run lint`.
- Test lanes by filename suffix: `*.test.ts` (unit, no DB), `*.integration.test.ts` (needs Postgres), `*.isolated.test.ts` (`mock.module`, own process). Never run bare `bun test`.
- Pinned versions (copy verbatim): Qdrant `v1.13.2`; Postgres `17`; Python `3.11`; mem0 embed model `nomic-embed-text:latest` (768 dims).
- Native paths: `~/.opencrow/bin/qdrant`, `~/.opencrow/qdrant/storage`, `~/.opencrow/mem0/kuzu`. Resolve `~` to an absolute path before writing into any plist (launchd does NOT expand `~`).
- Secrets (`OPENCROW_INTERNAL_TOKEN`, `MEM0_LLM_API_KEY`) are read from `.env` at render time and written into a `chmod 600` env file — never hardcoded into a plist or committed.

---

## Task 1: Worktree + native module skeleton + path resolution

**Files:**
- Create: `src/cli/native/paths.ts`
- Test: `src/cli/native/paths.test.ts`

**Interfaces:**
- Produces: `nativePaths(home: string): NativePaths` where
  `NativePaths = { readonly root: string; readonly bin: string; readonly qdrantBinary: string; readonly qdrantStorage: string; readonly qdrantConfig: string; readonly mem0Dir: string; readonly mem0Kuzu: string; readonly mem0EnvFile: string; readonly logDir: string }`.
- Produces: label constants `QDRANT_LABEL = "com.opencrow.qdrant"`, `MEM0_LABEL = "com.opencrow.mem0"`.

- [ ] **Step 1: Create the worktree and install deps**

```bash
git worktree add .claude/worktrees/native-macos-stack -b feat/native-macos-stack origin/master
cd .claude/worktrees/native-macos-stack
bun install
```

Verify CWD is under `.claude/worktrees/` before any edit.

- [ ] **Step 2: Copy the approved spec into the branch**

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /Users/gokhan/Desktop/opencrow/docs/superpowers/specs/2026-06-20-native-macos-stack-design.md docs/superpowers/specs/
cp /Users/gokhan/Desktop/opencrow/docs/superpowers/plans/2026-06-20-native-macos-stack.md docs/superpowers/plans/
```

- [ ] **Step 3: Write the failing test**

```typescript
// src/cli/native/paths.test.ts
import { test, expect } from "bun:test";
import { nativePaths, QDRANT_LABEL, MEM0_LABEL } from "./paths.ts";

test("nativePaths resolves all dirs under the given home, absolute (no ~)", () => {
  const p = nativePaths("/Users/test");
  expect(p.root).toBe("/Users/test/.opencrow");
  expect(p.qdrantBinary).toBe("/Users/test/.opencrow/bin/qdrant");
  expect(p.qdrantStorage).toBe("/Users/test/.opencrow/qdrant/storage");
  expect(p.qdrantConfig).toBe("/Users/test/.opencrow/qdrant/config.yaml");
  expect(p.mem0Kuzu).toBe("/Users/test/.opencrow/mem0/kuzu");
  expect(p.mem0EnvFile).toBe("/Users/test/.opencrow/mem0/mem0.env");
  expect(Object.values(p).every((v) => !v.includes("~"))).toBe(true);
});

test("service labels are stable", () => {
  expect(QDRANT_LABEL).toBe("com.opencrow.qdrant");
  expect(MEM0_LABEL).toBe("com.opencrow.mem0");
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test src/cli/native/paths.test.ts`
Expected: FAIL — `Cannot find module './paths.ts'`.

- [ ] **Step 5: Implement `paths.ts`**

```typescript
// src/cli/native/paths.ts
import path from "node:path";

export const QDRANT_LABEL = "com.opencrow.qdrant";
export const MEM0_LABEL = "com.opencrow.mem0";

export type NativePaths = {
  readonly root: string;
  readonly bin: string;
  readonly qdrantBinary: string;
  readonly qdrantStorage: string;
  readonly qdrantConfig: string;
  readonly mem0Dir: string;
  readonly mem0Kuzu: string;
  readonly mem0EnvFile: string;
  readonly logDir: string;
};

export function nativePaths(home: string): NativePaths {
  const root = path.join(home, ".opencrow");
  return {
    root,
    bin: path.join(root, "bin"),
    qdrantBinary: path.join(root, "bin", "qdrant"),
    qdrantStorage: path.join(root, "qdrant", "storage"),
    qdrantConfig: path.join(root, "qdrant", "config.yaml"),
    mem0Dir: path.join(root, "mem0"),
    mem0Kuzu: path.join(root, "mem0", "kuzu"),
    mem0EnvFile: path.join(root, "mem0", "mem0.env"),
    logDir: path.join(root, "logs"),
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test src/cli/native/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers src/cli/native/paths.ts src/cli/native/paths.test.ts
git commit -m "feat(native): path resolution + module skeleton for native macOS stack"
```

---

## Task 2: Generic launchd plist builder with env dict + KeepAlive

The existing `buildLaunchdPlist` only injects a single `OPENCROW_ENV_FILE` var. Qdrant/mem0 need an arbitrary env dict. Add a sibling builder rather than overloading the app one.

**Files:**
- Create: `src/cli/native/plist.ts`
- Test: `src/cli/native/plist.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `buildInfraPlist(opts: InfraPlistOptions): string` where
  `InfraPlistOptions = { readonly label: string; readonly programArguments: readonly string[]; readonly workingDirectory: string; readonly env?: Readonly<Record<string, string>>; readonly stdoutPath: string; readonly stderrPath: string; readonly throttleInterval?: number }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/native/plist.test.ts
import { test, expect } from "bun:test";
import { buildInfraPlist } from "./plist.ts";

const plist = buildInfraPlist({
  label: "com.opencrow.qdrant",
  programArguments: ["/Users/test/.opencrow/bin/qdrant", "--config-path", "/cfg.yaml"],
  workingDirectory: "/Users/test/.opencrow/qdrant",
  env: { QDRANT__SERVICE__HTTP_PORT: "6333" },
  stdoutPath: "/log/qdrant.log",
  stderrPath: "/log/qdrant.err.log",
});

test("includes label, KeepAlive, RunAtLoad", () => {
  expect(plist).toContain("<string>com.opencrow.qdrant</string>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(plist).toContain("<key>RunAtLoad</key>");
});

test("renders each program argument as a <string>", () => {
  expect(plist).toContain("<string>--config-path</string>");
  expect(plist).toContain("<string>/cfg.yaml</string>");
});

test("renders the env dict as EnvironmentVariables", () => {
  expect(plist).toContain("<key>EnvironmentVariables</key>");
  expect(plist).toContain("<key>QDRANT__SERVICE__HTTP_PORT</key>");
  expect(plist).toContain("<string>6333</string>");
});

test("defaults ThrottleInterval to 5", () => {
  expect(plist).toContain("<key>ThrottleInterval</key>");
  expect(plist).toContain("<integer>5</integer>");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/native/plist.test.ts`
Expected: FAIL — `Cannot find module './plist.ts'`.

- [ ] **Step 3: Implement `plist.ts`**

```typescript
// src/cli/native/plist.ts

export type InfraPlistOptions = {
  readonly label: string;
  readonly programArguments: readonly string[];
  readonly workingDirectory: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly throttleInterval?: number;
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildInfraPlist(opts: InfraPlistOptions): string {
  const throttle = opts.throttleInterval ?? 5;
  const args = opts.programArguments
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");

  const envEntries = Object.entries(opts.env ?? {});
  const envBlock =
    envEntries.length === 0
      ? ""
      : `
  <key>EnvironmentVariables</key>
  <dict>
${envEntries
  .map(
    ([k, v]) =>
      `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`,
  )
  .join("\n")}
  </dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(opts.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.stderrPath)}</string>${envBlock}
</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/native/plist.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/native/plist.ts src/cli/native/plist.test.ts
git commit -m "feat(native): infra launchd plist builder with env dict"
```

---

## Task 3: Qdrant config render + pinned download URL

**Files:**
- Create: `src/cli/native/qdrant-config.ts`
- Test: `src/cli/native/qdrant-config.test.ts`

**Interfaces:**
- Consumes: `NativePaths` from Task 1.
- Produces: `QDRANT_VERSION = "v1.13.2"`; `qdrantDownloadUrl(version: string, arch: "aarch64"): string`; `renderQdrantConfig(p: NativePaths): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/native/qdrant-config.test.ts
import { test, expect } from "bun:test";
import { QDRANT_VERSION, qdrantDownloadUrl, renderQdrantConfig } from "./qdrant-config.ts";
import { nativePaths } from "./paths.ts";

test("pins qdrant to v1.13.2", () => {
  expect(QDRANT_VERSION).toBe("v1.13.2");
});

test("download URL targets the macOS aarch64 release archive", () => {
  const url = qdrantDownloadUrl(QDRANT_VERSION, "aarch64");
  expect(url).toBe(
    "https://github.com/qdrant/qdrant/releases/download/v1.13.2/qdrant-aarch64-apple-darwin.tar.gz",
  );
});

test("config binds loopback :6333 and points storage at the native dir", () => {
  const cfg = renderQdrantConfig(nativePaths("/Users/test"));
  expect(cfg).toContain("host: 127.0.0.1");
  expect(cfg).toContain("http_port: 6333");
  expect(cfg).toContain("storage_path: /Users/test/.opencrow/qdrant/storage");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/native/qdrant-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `qdrant-config.ts`**

```typescript
// src/cli/native/qdrant-config.ts
import type { NativePaths } from "./paths.ts";

export const QDRANT_VERSION = "v1.13.2";

export function qdrantDownloadUrl(version: string, arch: "aarch64"): string {
  return `https://github.com/qdrant/qdrant/releases/download/${version}/qdrant-${arch}-apple-darwin.tar.gz`;
}

export function renderQdrantConfig(p: NativePaths): string {
  return `storage:
  storage_path: ${p.qdrantStorage}
service:
  host: 127.0.0.1
  http_port: 6333
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/native/qdrant-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/native/qdrant-config.ts src/cli/native/qdrant-config.test.ts
git commit -m "feat(native): qdrant config + pinned aarch64 download url"
```

---

## Task 4: mem0 env-file render from `.env` secrets

Reproduces the compose `mem0` env block for native uvicorn, swapping `host.docker.internal`/`qdrant` → `127.0.0.1` and resolving the Kùzu path absolute.

**Files:**
- Create: `src/cli/native/mem0-env.ts`
- Test: `src/cli/native/mem0-env.test.ts`

**Interfaces:**
- Consumes: `NativePaths` from Task 1.
- Produces: `renderMem0Env(p: NativePaths, secrets: { internalToken: string; llmApiKey: string }): string` (returns dotenv-format text, one `KEY=value` per line).

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/native/mem0-env.test.ts
import { test, expect } from "bun:test";
import { renderMem0Env } from "./mem0-env.ts";
import { nativePaths } from "./paths.ts";

const env = renderMem0Env(nativePaths("/Users/test"), {
  internalToken: "tok-123",
  llmApiKey: "sk-llm",
});
const map = Object.fromEntries(
  env.trim().split("\n").map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);

test("points qdrant + ollama at loopback", () => {
  expect(map.QDRANT_HOST).toBe("127.0.0.1");
  expect(map.QDRANT_PORT).toBe("6333");
  expect(map.MEM0_OLLAMA_URL).toBe("http://127.0.0.1:11434");
});

test("resolves kuzu graph db to an absolute native path", () => {
  expect(map.MEM0_GRAPH_PROVIDER).toBe("kuzu");
  expect(map.MEM0_GRAPH_DB).toBe("/Users/test/.opencrow/mem0/kuzu");
});

test("injects secrets and keeps hosted-DeepSeek extraction config", () => {
  expect(map.MEM0_API_TOKEN).toBe("tok-123");
  expect(map.MEM0_LLM_API_KEY).toBe("sk-llm");
  expect(map.OPENAI_API_KEY).toBe("sk-llm");
  expect(map.MEM0_LLM_MODEL).toBe("deepseek-v4-flash");
  expect(map.MEM0_LLM_DISABLE_THINKING).toBe("true");
  expect(map.MEM0_EMBED_MODEL).toBe("nomic-embed-text:latest");
  expect(map.MEM0_EMBED_DIMS).toBe("768");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/native/mem0-env.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mem0-env.ts`**

```typescript
// src/cli/native/mem0-env.ts
import type { NativePaths } from "./paths.ts";

const LLM_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

export function renderMem0Env(
  p: NativePaths,
  secrets: { readonly internalToken: string; readonly llmApiKey: string },
): string {
  const vars: Readonly<Record<string, string>> = {
    QDRANT_HOST: "127.0.0.1",
    QDRANT_PORT: "6333",
    MEM0_API_TOKEN: secrets.internalToken,
    MEM0_GRAPH_PROVIDER: "kuzu",
    MEM0_GRAPH_DB: p.mem0Kuzu,
    MEM0_LLM_PROVIDER: "openai",
    MEM0_LLM_MODEL: "deepseek-v4-flash",
    MEM0_LLM_BASE_URL: LLM_BASE_URL,
    MEM0_LLM_API_KEY: secrets.llmApiKey,
    MEM0_LLM_DISABLE_THINKING: "true",
    OPENAI_API_KEY: secrets.llmApiKey,
    OPENAI_BASE_URL: LLM_BASE_URL,
    OPENAI_API_BASE: LLM_BASE_URL,
    MEM0_OLLAMA_URL: "http://127.0.0.1:11434",
    MEM0_EMBED_MODEL: "nomic-embed-text:latest",
    MEM0_EMBED_DIMS: "768",
    MEM0_COLLECTION: "sige_mem0",
  };
  return `${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/native/mem0-env.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/native/mem0-env.ts src/cli/native/mem0-env.test.ts
git commit -m "feat(native): mem0 env-file render from .env secrets"
```

---

## Task 5: Homebrew helper — detect formulae + keg-only PATH

**Files:**
- Create: `src/cli/native/brew.ts`
- Test: `src/cli/native/brew.test.ts`

**Interfaces:**
- Produces: `parseBrewList(output: string): readonly string[]` (formula names from `brew list --formula`); `pgBinDir(brewPrefix: string): string` → `<prefix>/opt/postgresql@17/bin`.
- Note: actual `brew install` is a side-effecting step run by Task 9's provisioner; only the pure parsers are unit-tested here.

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/native/brew.test.ts
import { test, expect } from "bun:test";
import { parseBrewList, pgBinDir } from "./brew.ts";

test("parseBrewList splits formula names", () => {
  expect(parseBrewList("postgresql@17\npython@3.11\n")).toEqual([
    "postgresql@17",
    "python@3.11",
  ]);
});

test("pgBinDir builds the keg-only bin path", () => {
  expect(pgBinDir("/opt/homebrew")).toBe("/opt/homebrew/opt/postgresql@17/bin");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/native/brew.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `brew.ts`**

```typescript
// src/cli/native/brew.ts
import path from "node:path";

export const REQUIRED_FORMULAE = ["postgresql@17", "python@3.11"] as const;

export function parseBrewList(output: string): readonly string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function pgBinDir(brewPrefix: string): string {
  return path.join(brewPrefix, "opt", "postgresql@17", "bin");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/cli/native/brew.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/native/brew.ts src/cli/native/brew.test.ts
git commit -m "feat(native): homebrew formula list parsing + keg bin path"
```

---

## Task 6: Postgres role/db ensure (idempotent)

**Files:**
- Create: `src/cli/native/postgres.ts`
- Test: `src/cli/native/postgres.integration.test.ts`

**Interfaces:**
- Produces: `ensureOpencrowDb(adminUrl: string): Promise<void>` — connects to a running native Postgres as the bootstrap superuser and creates role `opencrow` (password `opencrow`, LOGIN, CREATEDB) and database `opencrow` owned by it, both idempotently.

- [ ] **Step 1: Write the failing integration test**

```typescript
// src/cli/native/postgres.integration.test.ts
import { test, expect } from "bun:test";
import { SQL } from "bun";
import { ensureOpencrowDb } from "./postgres.ts";

// Requires a running native Postgres 17 (brew services start postgresql@17).
// Admin URL connects to the default superuser db (current OS user).
const ADMIN_URL = process.env.PG_ADMIN_URL ?? `postgres://${process.env.USER}@127.0.0.1:5432/postgres`;

test("ensureOpencrowDb creates role + db idempotently", async () => {
  await ensureOpencrowDb(ADMIN_URL);
  await ensureOpencrowDb(ADMIN_URL); // second call must not throw

  const db = new SQL({ url: "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow", max: 1 });
  const rows = await db`SELECT 1 as ok`;
  expect(rows[0].ok).toBe(1);
  await db.close();
});
```

- [ ] **Step 2: Start native Postgres and run the test to verify it fails**

```bash
brew install postgresql@17
brew services start postgresql@17
# wait for readiness
/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 5432
bun test src/cli/native/postgres.integration.test.ts
```

Expected: FAIL — `Cannot find module './postgres.ts'`.

- [ ] **Step 3: Implement `postgres.ts`**

```typescript
// src/cli/native/postgres.ts
import { SQL } from "bun";

export async function ensureOpencrowDb(adminUrl: string): Promise<void> {
  const db = new SQL({ url: adminUrl, max: 1 });
  try {
    const role = await db`SELECT 1 FROM pg_roles WHERE rolname = 'opencrow'`;
    if (role.length === 0) {
      await db.unsafe(
        "CREATE ROLE opencrow LOGIN PASSWORD 'opencrow' CREATEDB",
      );
    }
    const dbExists = await db`SELECT 1 FROM pg_database WHERE datname = 'opencrow'`;
    if (dbExists.length === 0) {
      await db.unsafe("CREATE DATABASE opencrow OWNER opencrow");
    }
  } catch (error) {
    console.error("ensureOpencrowDb failed:", error);
    throw new Error(
      "Failed to provision the native Postgres role/database 'opencrow'",
    );
  } finally {
    await db.close();
  }
}
```

(Note: `CREATE DATABASE` cannot run in a transaction block; `db.unsafe(...)` issues it as a single simple-query statement, which satisfies that. The `console.error` here is in CLI provisioning code paired with a thrown user-facing error — acceptable per the existing `src/cli/` pattern; do not add it to `src/` runtime modules.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/cli/native/postgres.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/native/postgres.ts src/cli/native/postgres.integration.test.ts
git commit -m "feat(native): idempotent postgres role/db provisioning"
```

---

## Task 7: Qdrant provisioner — fetch binary, write config + plist, load

This task's deliverable is verified by a running service, not a unit test (it downloads + launchctl-loads). Pure pieces it uses (`qdrantDownloadUrl`, `renderQdrantConfig`, `buildInfraPlist`) are already covered.

**Files:**
- Create: `src/cli/native/qdrant.ts`

**Interfaces:**
- Consumes: `NativePaths`, `buildInfraPlist`, `qdrantDownloadUrl`, `renderQdrantConfig`, `QDRANT_VERSION`, `QDRANT_LABEL`.
- Produces: `provisionQdrant(p: NativePaths): Promise<void>` — ensures the binary exists (download+extract if missing), writes `config.yaml` and the launchd plist to `~/Library/LaunchAgents/com.opencrow.qdrant.plist`, then `bootstrap`+`kickstart`.

- [ ] **Step 1: Implement `qdrant.ts`**

```typescript
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
```

- [ ] **Step 2: Manually verify provisioning works**

```bash
bun -e 'import { nativePaths } from "./src/cli/native/paths.ts"; import { provisionQdrant } from "./src/cli/native/qdrant.ts"; import os from "node:os"; await provisionQdrant(nativePaths(os.homedir()));'
sleep 3
curl -fsS http://127.0.0.1:6333/healthz && echo " qdrant OK"
~/.opencrow/bin/qdrant --version
```

Expected: `qdrant OK`, version `1.13.2`.

- [ ] **Step 3: Run typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add src/cli/native/qdrant.ts
git commit -m "feat(native): qdrant provisioner (download + launchd)"
```

---

## Task 8: mem0 provisioner — venv, pip, env file, plist

**Files:**
- Create: `src/cli/native/mem0.ts`

**Interfaces:**
- Consumes: `NativePaths`, `renderMem0Env`, `buildInfraPlist`, `MEM0_LABEL`, `pgBinDir` (not needed here).
- Produces: `provisionMem0(p: NativePaths, repoDir: string, secrets: { internalToken: string; llmApiKey: string }): Promise<void>` — creates `mem0-server/.venv` (python3.11), installs requirements, writes the `chmod 600` env file + plist running `uvicorn app:app --host 127.0.0.1 --port 8050`, then loads it.

- [ ] **Step 1: Implement `mem0.ts`**

```typescript
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
```

- [ ] **Step 2: Manually verify (requires native Qdrant + Ollama up)**

```bash
TOKEN=$(grep '^OPENCROW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
KEY=$(grep '^MEM0_LLM_API_KEY=' .env | cut -d= -f2-)
bun -e "import { nativePaths } from './src/cli/native/paths.ts'; import { provisionMem0 } from './src/cli/native/mem0.ts'; import os from 'node:os'; await provisionMem0(nativePaths(os.homedir()), process.cwd(), { internalToken: process.env.T, llmApiKey: process.env.K });" 
# env passthrough:
T="$TOKEN" K="$KEY" bun -e "import { nativePaths } from './src/cli/native/paths.ts'; import { provisionMem0 } from './src/cli/native/mem0.ts'; import os from 'node:os'; await provisionMem0(nativePaths(os.homedir()), process.cwd(), { internalToken: process.env.T, llmApiKey: process.env.K });"
sleep 8
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8050/healthz || curl -fsS http://127.0.0.1:8050/docs >/dev/null && echo " mem0 OK"
```

Expected: mem0 responds on `:8050` (health or `/docs`).

- [ ] **Step 3: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add src/cli/native/mem0.ts
git commit -m "feat(native): mem0 provisioner (venv + uvicorn launchd)"
```

---

## Task 9: `opencrow native up` command wiring

**Files:**
- Create: `src/cli/native/provision.ts`
- Modify: `src/cli.ts` (add `native` case + help line)

**Interfaces:**
- Consumes: `provisionQdrant`, `provisionMem0`, `ensureOpencrowDb`, `nativePaths`, `REQUIRED_FORMULAE`, `pgBinDir`.
- Produces: `runNativeUp(): Promise<void>` — full provisioner: verify brew formulae present (instruct if missing), start Postgres via `brew services`, ensure db, provision Qdrant + mem0, print next steps.

- [ ] **Step 1: Implement `provision.ts`**

```typescript
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
  const internalToken = env.OPENCROW_INTERNAL_TOKEN ?? "";
  const llmApiKey = env.MEM0_LLM_API_KEY ?? "";
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
```

- [ ] **Step 2: Wire into `src/cli.ts`**

Add after the `doctor` case (around `src/cli.ts:40`):

```typescript
    case "native": {
      const sub = rest[0];
      if (sub !== "up") {
        process.stderr.write("Usage: opencrow native up\n");
        process.exit(1);
      }
      const { runNativeUp } = await import("./cli/native/provision.ts");
      await runNativeUp();
      break;
    }
```

And add to `printHelp()` after the `update` line:

```typescript
  w.write("  native up                       Provision + start the native macOS stack\n");
```

- [ ] **Step 3: End-to-end verify**

```bash
bun run typecheck && bun run lint
bun run src/cli.ts native up
curl -fsS http://127.0.0.1:6333/healthz && echo " qdrant"
curl -fsS http://127.0.0.1:8050/docs >/dev/null && echo " mem0"
/opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 5432
```

Expected: all three respond.

- [ ] **Step 4: Commit**

```bash
git add src/cli/native/provision.ts src/cli.ts
git commit -m "feat(native): `opencrow native up` provisioning command"
```

---

## Task 10: Extend `opencrow doctor` with Qdrant + mem0 checks

**Files:**
- Modify: `src/cli/doctor.ts` (add `checkQdrant`, `checkMem0`; register them in the checks array)
- Test: `src/cli/doctor-native.test.ts`

**Interfaces:**
- Consumes: the existing `CheckResult` type in `doctor.ts`.
- Produces: exported pure helper `classifyHttpCheck(name: string, ok: boolean, url: string): CheckResult` (so it's unit-testable without a live server); `checkQdrant`/`checkMem0` call it after a `fetch`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/doctor-native.test.ts
import { test, expect } from "bun:test";
import { classifyHttpCheck } from "./doctor.ts";

test("classifyHttpCheck passes when reachable", () => {
  const r = classifyHttpCheck("Qdrant", true, "http://127.0.0.1:6333");
  expect(r.status).toBe("pass");
});

test("classifyHttpCheck fails with a repair hint when unreachable", () => {
  const r = classifyHttpCheck("mem0", false, "http://127.0.0.1:8050");
  expect(r.status).toBe("fail");
  expect(r.repair).toContain("opencrow native up");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/cli/doctor-native.test.ts`
Expected: FAIL — `classifyHttpCheck` not exported.

- [ ] **Step 3: Add to `doctor.ts`**

Export the helper and two checks; register `checkQdrant` and `checkMem0` in the array passed to the runner (mirroring `checkPostgres`):

```typescript
export function classifyHttpCheck(
  name: string,
  ok: boolean,
  url: string,
): CheckResult {
  if (ok) return { name, status: "pass", message: `Reachable at ${url}` };
  return {
    name,
    status: "fail",
    message: `Not reachable at ${url}`,
    repair: "opencrow native up",
  };
}

async function checkQdrant(): Promise<CheckResult> {
  try {
    const res = await fetch("http://127.0.0.1:6333/healthz");
    return classifyHttpCheck("Qdrant", res.ok, "http://127.0.0.1:6333");
  } catch {
    return classifyHttpCheck("Qdrant", false, "http://127.0.0.1:6333");
  }
}

async function checkMem0(): Promise<CheckResult> {
  try {
    const res = await fetch("http://127.0.0.1:8050/docs");
    return classifyHttpCheck("mem0", res.ok, "http://127.0.0.1:8050");
  } catch {
    return classifyHttpCheck("mem0", false, "http://127.0.0.1:8050");
  }
}
```

Find the array of checks in `runDoctor` (the list that already includes `checkBun`, `checkPostgres`, …) and add `checkQdrant` and `checkMem0` to it.

- [ ] **Step 4: Run test + the real doctor**

```bash
bun test src/cli/doctor-native.test.ts
bun run src/cli.ts doctor
```

Expected: test PASS; `doctor` shows PostgreSQL, Qdrant, mem0 all green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor-native.test.ts
git commit -m "feat(native): doctor checks for qdrant + mem0"
```

---

## Task 11: Data migration script (Docker volumes → native)

**Files:**
- Create: `scripts/migrate-to-native.sh`

**Interfaces:**
- Standalone bash; reads from the live `opencrow-*` containers and writes into native PG + `~/.opencrow`. Run once, before Colima teardown.

- [ ] **Step 1: Write `scripts/migrate-to-native.sh`**

```bash
#!/usr/bin/env bash
# Migrate OpenCrow data from the Colima/Docker stack into the native macOS stack.
# Prereqs: native Postgres + Qdrant + mem0 provisioned (opencrow native up) and
# the OLD Docker stack still running as the data source.
set -euo pipefail

PGBIN="$(brew --prefix)/opt/postgresql@17/bin"
NATIVE="${HOME}/.opencrow"

echo "==> 1/3 Postgres: dump from container, restore into native"
docker exec opencrow-postgres-1 pg_dump -U opencrow -d opencrow --no-owner --no-privileges \
  | "${PGBIN}/psql" "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow"

echo "==> 2/3 Qdrant: stop native, copy storage, restart"
launchctl kill SIGTERM "gui/$(id -u)/com.opencrow.qdrant" 2>/dev/null || true
sleep 2
rm -rf "${NATIVE}/qdrant/storage"
mkdir -p "${NATIVE}/qdrant/storage"
docker cp opencrow-qdrant-1:/qdrant/storage/. "${NATIVE}/qdrant/storage/"
launchctl kickstart -k "gui/$(id -u)/com.opencrow.qdrant"

echo "==> 3/3 mem0: stop native, copy /data (kuzu + vectors), restart"
launchctl kill SIGTERM "gui/$(id -u)/com.opencrow.mem0" 2>/dev/null || true
sleep 2
mkdir -p "${NATIVE}/mem0"
docker cp opencrow-mem0-1:/data/. "${NATIVE}/mem0/"
launchctl kickstart -k "gui/$(id -u)/com.opencrow.mem0"

echo "==> Migration complete. Verify before deleting Colima."
```

- [ ] **Step 2: Make executable + run + verify parity**

```bash
chmod +x scripts/migrate-to-native.sh
./scripts/migrate-to-native.sh

# Row-count parity on a representative table:
docker exec opencrow-postgres-1 psql -U opencrow -d opencrow -tAc "SELECT count(*) FROM ideas"
/opt/homebrew/opt/postgresql@17/bin/psql "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow" -tAc "SELECT count(*) FROM ideas"

# Qdrant collection parity:
curl -fsS http://127.0.0.1:6333/collections | python3 -m json.tool
```

Expected: native row count equals container row count; collections present.

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-to-native.sh
git commit -m "feat(native): data migration script (docker volumes -> native)"
```

---

## Task 12: Verify cutover + docs + tear down Colima

**Files:**
- Modify: `CLAUDE.md` (native default; relabel Docker as server path; update `test:integration` note)
- Modify: `README.md` if it documents `docker compose up` for local dev (grep first)

**Interfaces:** none (docs + manual cutover).

- [ ] **Step 1: Run the app natively against the migrated data**

```bash
bun run dev &
sleep 10
curl -fsS http://127.0.0.1:48081/internal/health && echo " app healthy"
```

Expected: app health ok; logs show connections to `127.0.0.1` Postgres/Qdrant/mem0.

- [ ] **Step 2: Run the integration lane against native Postgres**

```bash
bun run test:integration
```

Expected: PASS (no `docker compose up` needed — native PG on `:5432`).

- [ ] **Step 3: mem0 read/write smoke test**

```bash
TOKEN=$(grep '^OPENCROW_INTERNAL_TOKEN=' .env | cut -d= -f2-)
curl -fsS -X POST http://127.0.0.1:8050/v1/memories/ \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"native smoke test marker"}],"user_id":"native-check"}'
curl -fsS "http://127.0.0.1:8050/v1/memories/?user_id=native-check" -H "Authorization: Bearer $TOKEN"
```

Expected: write returns 200; search returns the marker.

- [ ] **Step 4: Update `CLAUDE.md`**

Add a "Native macOS stack (default local)" section documenting `brew install postgresql@17 python@3.11`, `opencrow native up`, `opencrow doctor`, and the launchd labels. Relabel the existing Docker/compose deploy guidance as "Linux server deploy (future)". Update the testing section: integration lane now uses native Postgres locally; `docker compose up -d postgres` only applies to the server/CI path.

- [ ] **Step 5: Commit docs**

```bash
git add CLAUDE.md README.md docs/superpowers
git commit -m "docs(native): make native macOS stack the default local path"
```

- [ ] **Step 6: Security review + PR (do NOT delete Colima yet)**

Dispatch `security-reviewer` on the diff (focus: secrets in the mem0 env file/wrapper are `chmod 600`, all binds are loopback, plist contains no plaintext keys). Fix CRITICAL/HIGH. Then:

```bash
git push -u origin feat/native-macos-stack
gh pr create --base master --title "feat: native macOS stack (de-Colima)" --body "See docs/superpowers/plans/2026-06-20-native-macos-stack.md"
```

- [ ] **Step 7: Tear down Colima (ONLY after PR merged + native verified for a full run cycle)**

```bash
colima stop
colima delete   # reclaims ~13GB RAM + ~38GB disk
```

Keep `docker-compose.yml` + Dockerfiles in the repo for the future Linux server.

---

## Self-Review

**Spec coverage:**
- Native Postgres → Tasks 6, 9. Qdrant → Tasks 3, 7. mem0 → Tasks 4, 8. App unchanged → Task 12 (verify only). Automation/CLI → Tasks 9, 10. Migration → Task 11. Cutover order (Colima last) → Task 12 steps 6–7. Docs → Task 12. Durable Postgres (no fsync=off) → covered by using brew defaults (no tuning flags written). Qdrant `~/.opencrow/bin` → Task 1 paths + Task 7. Secrets from `.env`, chmod 600, no plist plaintext → Tasks 4, 8, 12 step 6. Keep compose/Dockerfiles → Task 12 step 7. CI untouched → no CI files modified. ✅ no gaps.

**Placeholder scan:** every code step contains real code/commands; no TBD/TODO/"handle errors" placeholders. ✅

**Type consistency:** `NativePaths` shape identical across Tasks 1/3/4/7/8; `buildInfraPlist`/`InfraPlistOptions` consistent (Task 2 ↔ 7/8); `CheckResult` reused from `doctor.ts` (Task 10); `provisionQdrant(p)`, `provisionMem0(p, repoDir, secrets)`, `ensureOpencrowDb(adminUrl)`, `renderMem0Env(p, secrets)` signatures match their call sites in Task 9. ✅
