import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { detectProjectContext } from "./project-context";

describe("detectProjectContext", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-ctx-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("empty directory", () => {
    it("should detect no languages for an empty directory", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toEqual([]);
      expect(ctx.packageManager).toBeNull();
      expect(ctx.framework).toBeNull();
      expect(ctx.testRunner).toBeNull();
      expect(ctx.linter).toBeNull();
      expect(ctx.typeChecker).toBeNull();
      expect(ctx.buildCommand).toBeNull();
    });

    it("should return the resolved path", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.path).toBe(tempDir);
    });
  });

  describe("TypeScript/Bun project", () => {
    beforeEach(async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "test-project",
          scripts: { build: "bun build src/index.ts" },
          dependencies: { hono: "^4.0.0" },
          devDependencies: {},
        }),
      );
      await writeFile(join(tempDir, "tsconfig.json"), "{}");
      await writeFile(join(tempDir, "bun.lockb"), "");
    });

    it("should detect TypeScript and JavaScript languages", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("TypeScript");
      expect(ctx.languages).toContain("JavaScript");
    });

    it("should detect bun as package manager", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("bun");
    });

    it("should detect Hono framework", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("Hono");
    });

    it("should detect bun:test as test runner", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.testRunner).not.toBeNull();
      expect(ctx.testRunner!.name).toBe("bun:test");
      expect(ctx.testRunner!.command).toBe("bun test");
    });

    it("should detect tsc as type checker with bun flag", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.typeChecker).not.toBeNull();
      expect(ctx.typeChecker!.name).toBe("tsc");
      expect(ctx.typeChecker!.command).toContain("bun");
    });

    it("should detect build command", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.buildCommand).toBe("bun run build");
    });
  });

  describe("JavaScript/npm project with React", () => {
    beforeEach(async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "react-app",
          dependencies: { react: "^18.0.0" },
          devDependencies: { jest: "^29.0.0", eslint: "^8.0.0" },
          scripts: { build: "react-scripts build" },
        }),
      );
      await writeFile(join(tempDir, "package-lock.json"), "{}");
    });

    it("should detect JavaScript language (no tsconfig)", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("JavaScript");
      expect(ctx.languages).not.toContain("TypeScript");
    });

    it("should detect npm as package manager", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("npm");
    });

    it("should detect React framework", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("React");
    });

    it("should detect jest as test runner", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.testRunner).not.toBeNull();
      expect(ctx.testRunner!.name).toBe("jest");
    });
  });

  describe("Rust project", () => {
    beforeEach(async () => {
      await writeFile(
        join(tempDir, "Cargo.toml"),
        `[package]\nname = "my-crate"\n[dependencies]\naxum = "0.6"`,
      );
      await writeFile(join(tempDir, "Cargo.lock"), "");
    });

    it("should detect Rust language", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("Rust");
    });

    it("should detect cargo as package manager", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("cargo");
    });

    it("should detect Axum framework", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("Axum");
    });

    it("should detect cargo test as test runner", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.testRunner).not.toBeNull();
      expect(ctx.testRunner!.name).toBe("cargo test");
      expect(ctx.testRunner!.command).toBe("cargo test");
    });

    it("should detect clippy as linter", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.linter).not.toBeNull();
      expect(ctx.linter!.name).toBe("clippy");
    });

    it("should detect rustfmt as formatter", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.formatter).not.toBeNull();
      expect(ctx.formatter!.name).toBe("rustfmt");
    });

    it("should detect cargo check as type checker", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.typeChecker).not.toBeNull();
      expect(ctx.typeChecker!.name).toBe("cargo check");
    });

    it("should detect cargo build as build command", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.buildCommand).toBe("cargo build");
    });
  });

  describe("Go project", () => {
    beforeEach(async () => {
      await writeFile(
        join(tempDir, "go.mod"),
        `module example.com/myapp\ngo 1.21\nrequire github.com/gin-gonic/gin v1.9.0`,
      );
      await writeFile(join(tempDir, "go.sum"), "");
    });

    it("should detect Go language", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("Go");
    });

    it("should detect go as package manager", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("go");
    });

    it("should detect Gin framework", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("Gin");
    });

    it("should detect go test as test runner", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.testRunner).not.toBeNull();
      expect(ctx.testRunner!.name).toBe("go test");
    });

    it("should detect gofmt as formatter", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.formatter).not.toBeNull();
      expect(ctx.formatter!.name).toBe("gofmt");
    });

    it("should detect go vet as type checker", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.typeChecker).not.toBeNull();
      expect(ctx.typeChecker!.name).toBe("go vet");
    });
  });

  describe("Python project", () => {
    beforeEach(async () => {
      await writeFile(
        join(tempDir, "pyproject.toml"),
        `[tool.ruff]\nline-length = 88\n[project]\ndependencies = ["fastapi"]`,
      );
      await writeFile(join(tempDir, "requirements.txt"), "fastapi\nuvicorn\n");
    });

    it("should detect Python language", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("Python");
    });

    it("should detect pip as package manager from requirements.txt", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("pip");
    });

    it("should detect FastAPI framework", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("FastAPI");
    });

    it("should detect pytest as test runner", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.testRunner).not.toBeNull();
      expect(ctx.testRunner!.name).toBe("pytest");
    });

    it("should detect ruff as linter from pyproject.toml", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.linter).not.toBeNull();
      expect(ctx.linter!.name).toBe("ruff");
    });

    it("should detect ruff format as formatter", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.formatter).not.toBeNull();
      expect(ctx.formatter!.name).toBe("ruff format");
    });
  });

  describe("Ruby project", () => {
    it("should detect Ruby language from Gemfile", async () => {
      await writeFile(join(tempDir, "Gemfile"), 'gem "rails"');
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("Ruby");
    });
  });

  describe("Java project", () => {
    it("should detect Java language from pom.xml", async () => {
      await writeFile(join(tempDir, "pom.xml"), "<project></project>");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("Java");
    });

    it("should detect Java language from build.gradle", async () => {
      await writeFile(join(tempDir, "build.gradle"), "apply plugin: 'java'");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.languages).toContain("Java");
    });
  });

  describe("package manager detection", () => {
    it("should detect pnpm from pnpm-lock.yaml", async () => {
      await writeFile(join(tempDir, "package.json"), '{"name":"test"}');
      await writeFile(join(tempDir, "pnpm-lock.yaml"), "");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("pnpm");
    });

    it("should detect yarn from yarn.lock", async () => {
      await writeFile(join(tempDir, "package.json"), '{"name":"test"}');
      await writeFile(join(tempDir, "yarn.lock"), "");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("yarn");
    });

    it("should detect pipenv from Pipfile.lock", async () => {
      await writeFile(join(tempDir, "Pipfile"), "");
      await writeFile(join(tempDir, "Pipfile.lock"), "{}");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("pipenv");
    });

    it("should detect poetry from poetry.lock", async () => {
      await writeFile(join(tempDir, "pyproject.toml"), "");
      await writeFile(join(tempDir, "poetry.lock"), "");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.packageManager).toBe("poetry");
    });
  });

  describe("framework detection", () => {
    it("should detect Next.js", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { next: "^14.0.0" } }),
      );
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("Next.js");
    });

    it("should detect Express", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      );
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("Express");
    });

    it("should detect Vue", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { vue: "^3.0.0" } }),
      );
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.framework).toBe("Vue");
    });
  });

  describe("entry point detection", () => {
    it("should detect main entry point", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ main: "src/index.js" }),
      );
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.entryPoint).toBe("src/index.js");
    });

    it("should detect module entry point", async () => {
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ module: "dist/esm/index.js" }),
      );
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.entryPoint).toBe("dist/esm/index.js");
    });

    it("should return null entry point when none exists", async () => {
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.entryPoint).toBeNull();
    });
  });

  describe("linter detection", () => {
    it("should detect eslint from config file", async () => {
      await writeFile(join(tempDir, "package.json"), '{"name":"test"}');
      await writeFile(join(tempDir, "eslint.config.js"), "export default {};");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.linter).not.toBeNull();
      expect(ctx.linter!.name).toBe("eslint");
    });

    it("should detect biome from biome.json", async () => {
      await writeFile(join(tempDir, "package.json"), '{"name":"test"}');
      await writeFile(join(tempDir, "biome.json"), "{}");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.linter).not.toBeNull();
      expect(ctx.linter!.name).toBe("biome");
    });

    it("should detect golangci-lint from config", async () => {
      await writeFile(join(tempDir, "go.mod"), "module test\ngo 1.21\n");
      await writeFile(join(tempDir, ".golangci.yml"), "run:\n  timeout: 5m\n");
      const ctx = await detectProjectContext(tempDir);
      expect(ctx.linter).not.toBeNull();
      expect(ctx.linter!.name).toBe("golangci-lint");
    });
  });
});
