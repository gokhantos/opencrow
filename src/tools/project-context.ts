/**
 * Auto-detect project technology stack.
 * Exports both the tool factory and the reusable detectProjectContext() function
 * which validate_code and run_tests consume internally.
 */
import { resolve } from "path";
import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { ToolsConfig } from "../config/schema";
import { expandHome, isPathAllowedSync, resolveAllowedDirs } from "./path-utils";

export interface DetectedTool {
  readonly name: string;
  readonly command: string;
}

export interface ProjectContext {
  readonly path: string;
  readonly languages: readonly string[];
  readonly packageManager: string | null;
  readonly framework: string | null;
  readonly testRunner: DetectedTool | null;
  readonly linter: DetectedTool | null;
  readonly formatter: DetectedTool | null;
  readonly typeChecker: DetectedTool | null;
  readonly buildCommand: string | null;
  readonly entryPoint: string | null;
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function readFileQuiet(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.text();
  } catch {
    return null;
  }
}

function parseJsonQuiet(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface PkgJson {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly main?: string;
  readonly module?: string;
}

function hasDep(pkg: PkgJson, name: string): boolean {
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

// --- Detection functions ---

async function detectLanguages(
  dir: string,
  hasPkg: boolean,
): Promise<string[]> {
  const langs: string[] = [];

  if (hasPkg && (await fileExists(`${dir}/tsconfig.json`))) {
    langs.push("TypeScript", "JavaScript");
  } else if (hasPkg) {
    langs.push("JavaScript");
  }

  if (await fileExists(`${dir}/Cargo.toml`)) langs.push("Rust");
  if (await fileExists(`${dir}/go.mod`)) langs.push("Go");

  const pyFiles = [
    `${dir}/pyproject.toml`,
    `${dir}/setup.py`,
    `${dir}/requirements.txt`,
    `${dir}/Pipfile`,
  ];
  for (const f of pyFiles) {
    if (await fileExists(f)) {
      langs.push("Python");
      break;
    }
  }

  if (await fileExists(`${dir}/Gemfile`)) langs.push("Ruby");
  if (
    (await fileExists(`${dir}/build.gradle`)) ||
    (await fileExists(`${dir}/build.gradle.kts`)) ||
    (await fileExists(`${dir}/pom.xml`))
  ) {
    langs.push("Java");
  }

  return langs;
}

async function detectPackageManager(dir: string): Promise<string | null> {
  // Order matters — more specific lockfiles first
  if (
    (await fileExists(`${dir}/bun.lockb`)) ||
    (await fileExists(`${dir}/bun.lock`))
  )
    return "bun";
  if (await fileExists(`${dir}/pnpm-lock.yaml`)) return "pnpm";
  if (await fileExists(`${dir}/yarn.lock`)) return "yarn";
  if (await fileExists(`${dir}/package-lock.json`)) return "npm";
  if (await fileExists(`${dir}/Pipfile.lock`)) return "pipenv";
  if (await fileExists(`${dir}/poetry.lock`)) return "poetry";
  if (await fileExists(`${dir}/Cargo.lock`)) return "cargo";
  if (await fileExists(`${dir}/go.sum`)) return "go";

  // Fallback: check for config files without lockfiles
  if (await fileExists(`${dir}/requirements.txt`)) return "pip";
  if (await fileExists(`${dir}/package.json`)) return "npm";
  return null;
}

const JS_FRAMEWORKS = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["hono", "Hono"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["@nestjs/core", "NestJS"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["astro", "Astro"],
  ["@angular/core", "Angular"],
] as const;

async function detectFramework(
  dir: string,
  pkg: PkgJson | null,
): Promise<string | null> {
  // JS/TS
  if (pkg) {
    for (const [dep, name] of JS_FRAMEWORKS) {
      if (hasDep(pkg, dep)) return name;
    }
  }

  // Python
  const pyproject = await readFileQuiet(`${dir}/pyproject.toml`);
  if (pyproject) {
    if (pyproject.includes("django")) return "Django";
    if (pyproject.includes("fastapi")) return "FastAPI";
    if (pyproject.includes("flask")) return "Flask";
    if (pyproject.includes("starlette")) return "Starlette";
  }
  const reqs = await readFileQuiet(`${dir}/requirements.txt`);
  if (reqs) {
    if (/^django\b/im.test(reqs)) return "Django";
    if (/^fastapi\b/im.test(reqs)) return "FastAPI";
    if (/^flask\b/im.test(reqs)) return "Flask";
  }

  // Rust
  const cargo = await readFileQuiet(`${dir}/Cargo.toml`);
  if (cargo) {
    if (cargo.includes("axum")) return "Axum";
    if (cargo.includes("actix-web")) return "Actix";
    if (cargo.includes("rocket")) return "Rocket";
    if (cargo.includes("warp")) return "Warp";
  }

  // Go
  const gomod = await readFileQuiet(`${dir}/go.mod`);
  if (gomod) {
    if (gomod.includes("gin-gonic/gin")) return "Gin";
    if (gomod.includes("labstack/echo")) return "Echo";
    if (gomod.includes("gofiber/fiber")) return "Fiber";
    if (gomod.includes("gorilla/mux")) return "Gorilla";
  }

  return null;
}

function detectTestRunner(
  _dir: string,
  pkg: PkgJson | null,
  pm: string | null,
  languages: readonly string[],
): DetectedTool | null {
  // Check package.json scripts.test first as explicit override
  if (pkg?.scripts?.test && pkg.scripts.test !== "echo \"Error: no test specified\" && exit 1") {
    const run = pm === "bun" ? "bun run test" : pm === "pnpm" ? "pnpm test" : pm === "yarn" ? "yarn test" : "npm test";
    // Try to identify the runner name from the script
    const script = pkg.scripts.test;
    if (script.includes("vitest")) return { name: "vitest", command: run };
    if (script.includes("jest")) return { name: "jest", command: run };
    if (script.includes("mocha")) return { name: "mocha", command: run };
    if (script.includes("bun test")) return { name: "bun:test", command: "bun test" };
    return { name: "custom", command: run };
  }

  // JS/TS detection from deps
  if (pkg) {
    if (pm === "bun") return { name: "bun:test", command: "bun test" };
    if (hasDep(pkg, "vitest"))
      return { name: "vitest", command: "npx vitest run" };
    if (hasDep(pkg, "jest")) return { name: "jest", command: "npx jest" };
    if (hasDep(pkg, "mocha")) return { name: "mocha", command: "npx mocha" };
  }

  // Language-specific defaults
  if (languages.includes("Rust"))
    return { name: "cargo test", command: "cargo test" };
  if (languages.includes("Go"))
    return { name: "go test", command: "go test ./..." };
  if (languages.includes("Python"))
    return { name: "pytest", command: "pytest" };

  return null;
}

async function detectLinter(
  dir: string,
  pkg: PkgJson | null,
  languages: readonly string[],
): Promise<DetectedTool | null> {
  // JS/TS linters
  const eslintConfigs = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    ".eslintrc",
  ];
  for (const cfg of eslintConfigs) {
    if (await fileExists(`${dir}/${cfg}`))
      return { name: "eslint", command: "npx eslint ." };
  }
  if (
    (await fileExists(`${dir}/biome.json`)) ||
    (await fileExists(`${dir}/biome.jsonc`))
  )
    return { name: "biome", command: "npx @biomejs/biome check ." };

  if (pkg && hasDep(pkg, "eslint"))
    return { name: "eslint", command: "npx eslint ." };

  // Python
  if (languages.includes("Python")) {
    const pyproject = await readFileQuiet(`${dir}/pyproject.toml`);
    if (
      (await fileExists(`${dir}/ruff.toml`)) ||
      pyproject?.includes("[tool.ruff]")
    )
      return { name: "ruff", command: "ruff check ." };
    if (pyproject?.includes("pylint") || pyproject?.includes("flake8"))
      return { name: "flake8", command: "flake8 ." };
  }

  // Go
  if (languages.includes("Go")) {
    if (
      (await fileExists(`${dir}/.golangci.yml`)) ||
      (await fileExists(`${dir}/.golangci.yaml`))
    )
      return { name: "golangci-lint", command: "golangci-lint run" };
  }

  // Rust
  if (languages.includes("Rust"))
    return { name: "clippy", command: "cargo clippy -- -D warnings" };

  return null;
}

async function detectFormatter(
  dir: string,
  pkg: PkgJson | null,
  languages: readonly string[],
): Promise<DetectedTool | null> {
  const prettierConfigs = [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.js",
    ".prettierrc.cjs",
    "prettier.config.js",
    "prettier.config.cjs",
  ];
  for (const cfg of prettierConfigs) {
    if (await fileExists(`${dir}/${cfg}`))
      return { name: "prettier", command: "npx prettier --check ." };
  }
  if (pkg && hasDep(pkg, "prettier"))
    return { name: "prettier", command: "npx prettier --check ." };

  if (languages.includes("Rust"))
    return { name: "rustfmt", command: "cargo fmt --check" };
  if (languages.includes("Go"))
    return { name: "gofmt", command: "gofmt -l ." };
  if (languages.includes("Python")) {
    const pyproject = await readFileQuiet(`${dir}/pyproject.toml`);
    if (pyproject?.includes("[tool.ruff]"))
      return { name: "ruff format", command: "ruff format --check ." };
    if (pyproject?.includes("[tool.black]") || (await fileExists(`${dir}/.black`)))
      return { name: "black", command: "black --check ." };
  }

  return null;
}

async function detectTypeChecker(
  dir: string,
  pkg: PkgJson | null,
  pm: string | null,
  languages: readonly string[],
): Promise<DetectedTool | null> {
  if (await fileExists(`${dir}/tsconfig.json`)) {
    const cmd =
      pm === "bun" ? "bun --bun tsc --noEmit" : "npx tsc --noEmit";
    return { name: "tsc", command: cmd };
  }

  if (languages.includes("Python")) {
    const pyproject = await readFileQuiet(`${dir}/pyproject.toml`);
    if (pkg && hasDep(pkg, "pyright"))
      return { name: "pyright", command: "pyright" };
    if (pyproject?.includes("[tool.mypy]") || (await fileExists(`${dir}/mypy.ini`)))
      return { name: "mypy", command: "mypy ." };
  }

  if (languages.includes("Rust"))
    return { name: "cargo check", command: "cargo check" };
  if (languages.includes("Go"))
    return { name: "go vet", command: "go vet ./..." };

  return null;
}

function detectBuildCommand(
  pkg: PkgJson | null,
  pm: string | null,
  languages: readonly string[],
): string | null {
  if (pkg?.scripts?.build) {
    if (pm === "bun") return "bun run build";
    if (pm === "pnpm") return "pnpm run build";
    if (pm === "yarn") return "yarn build";
    return "npm run build";
  }

  if (languages.includes("Rust")) return "cargo build";
  if (languages.includes("Go")) return "go build ./...";
  return null;
}

function detectEntryPoint(pkg: PkgJson | null): string | null {
  if (pkg?.main) return pkg.main;
  if (pkg?.module) return pkg.module;
  if (pkg?.scripts?.start) return `(scripts.start: ${pkg.scripts.start})`;
  return null;
}

// --- Main detection function (exported for other tools) ---

export async function detectProjectContext(
  projectPath: string,
): Promise<ProjectContext> {
  const dir = resolve(projectPath);

  const pkgText = await readFileQuiet(`${dir}/package.json`);
  const pkg = pkgText ? (parseJsonQuiet(pkgText) as PkgJson | null) : null;
  const hasPkg = pkg !== null;

  const [languages, pm] = await Promise.all([
    detectLanguages(dir, hasPkg),
    detectPackageManager(dir),
  ]);

  const [framework, linter, formatter, typeChecker] = await Promise.all([
    detectFramework(dir, pkg),
    detectLinter(dir, pkg, languages),
    detectFormatter(dir, pkg, languages),
    detectTypeChecker(dir, pkg, pm, languages),
  ]);

  const testRunner = detectTestRunner(dir, pkg, pm, languages);
  const buildCommand = detectBuildCommand(pkg, pm, languages);
  const entryPoint = detectEntryPoint(pkg);

  return {
    path: dir,
    languages,
    packageManager: pm,
    framework,
    testRunner,
    linter,
    formatter,
    typeChecker,
    buildCommand,
    entryPoint,
  };
}

// --- Tool output formatting ---

function formatContext(ctx: ProjectContext): string {
  const lines: string[] = [`Project: ${ctx.path}`];

  lines.push(
    `  Languages: ${ctx.languages.length > 0 ? ctx.languages.join(", ") : "unknown"}`,
  );
  lines.push(`  Package manager: ${ctx.packageManager ?? "none detected"}`);
  lines.push(`  Framework: ${ctx.framework ?? "none detected"}`);
  lines.push(
    `  Test runner: ${ctx.testRunner ? `${ctx.testRunner.name} (${ctx.testRunner.command})` : "none detected"}`,
  );
  lines.push(
    `  Type checker: ${ctx.typeChecker ? `${ctx.typeChecker.name} (${ctx.typeChecker.command})` : "none detected"}`,
  );
  lines.push(
    `  Linter: ${ctx.linter ? `${ctx.linter.name} (${ctx.linter.command})` : "none detected"}`,
  );
  lines.push(
    `  Formatter: ${ctx.formatter ? `${ctx.formatter.name} (${ctx.formatter.command})` : "none detected"}`,
  );
  lines.push(`  Build command: ${ctx.buildCommand ?? "none detected"}`);
  lines.push(`  Entry point: ${ctx.entryPoint ?? "none detected"}`);

  return lines.join("\n");
}

// --- Tool factory ---

export function createProjectContextTool(config: ToolsConfig): ToolDefinition {
  const allowedDirs = resolveAllowedDirs(config.allowedDirectories);

  return {
    name: "project_context",
    description:
      "Auto-detect a project's technology stack: language, framework, package manager, test runner, linter, type checker, and build command. Call this before writing code in an unfamiliar project to understand its conventions. Works with TypeScript, JavaScript, Python, Rust, Go, Ruby, and Java projects.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the project root directory. Defaults to current working directory.",
        },
      },
      required: [],
    },

    categories: ["code"] as readonly ToolCategory[],
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const rawPath = input.path ? String(input.path) : process.cwd();
      const dir = resolve(expandHome(rawPath));

      if (!isPathAllowedSync(dir, allowedDirs)) {
        return { output: `Error: path not allowed: ${dir}`, isError: true };
      }

      try {
        const ctx = await detectProjectContext(dir);
        return { output: formatContext(ctx), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          output: `Error detecting project context: ${msg}`,
          isError: true,
        };
      }
    },
  };
}
