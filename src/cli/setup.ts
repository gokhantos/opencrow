import * as p from "@clack/prompts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { LOGO, getVersion, getAppDir } from "./prompts.ts";

const APP_DIR = getAppDir();
const ENV_PATH = path.join(APP_DIR, ".env");
const DOCKER_COMPOSE_PATH = path.join(APP_DIR, "docker-compose.yml");

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCmd(
  cmd: string,
  args: string[],
  cwd?: string,
): { ok: boolean; output: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  const output =
    (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
  return { ok: result.status === 0, output: output.trim() };
}

function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_PATH)) return {};
  const lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return env;
}

function writeEnvFile(env: Record<string, string>): void {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

function cancelled(): never {
  p.cancel("Setup cancelled.");
  process.exit(1);
}

export async function runSetup(): Promise<void> {
  // Step 1: Welcome
  console.log(LOGO);
  p.intro(`OpenCrow v${getVersion()} — Setup Wizard`);

  const bunVersion = runCmd("bun", ["--version"]);
  const hasDocker = hasCommand("docker");
  const hasDockerCompose =
    hasDocker &&
    (runCmd("docker", ["compose", "version"]).ok ||
      hasCommand("docker-compose"));

  p.log.info(`Platform: ${process.platform} (${process.arch})`);
  p.log.info(`Bun: ${bunVersion.ok ? bunVersion.output : "not found"}`);
  p.log.info(`Docker: ${hasDocker ? "available" : "not found"}`);
  p.log.info(`Docker Compose: ${hasDockerCompose ? "available" : "not found"}`);

  // Step 2: Database Setup
  const existingEnv = readEnvFile();
  let databaseUrl = existingEnv.DATABASE_URL ?? "";
  let qdrantUrl = existingEnv.QDRANT_URL ?? "";

  if (hasDockerCompose) {
    const useDocker = await p.confirm({
      message: "Use Docker for PostgreSQL and Qdrant?",
      initialValue: true,
    });
    if (p.isCancel(useDocker)) cancelled();

    if (useDocker) {
      const s = p.spinner();
      s.start("Starting PostgreSQL and Qdrant containers...");

      const composeCmd = runCmd("docker", ["compose", "version"]).ok
        ? ["docker", "compose"]
        : ["docker-compose"];

      const up = runCmd(composeCmd[0]!, [
        ...(composeCmd.length > 1 ? [composeCmd[1]!] : []),
        "-f",
        DOCKER_COMPOSE_PATH,
        "up",
        "-d",
        "--wait",
      ]);

      if (!up.ok) {
        s.stop("Docker containers failed to start");
        p.log.error(up.output);
        p.log.warn("You can start them manually: docker compose up -d");
      } else {
        s.stop("Docker containers running");
      }

      databaseUrl = "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow";
      qdrantUrl = "http://127.0.0.1:6333";
    }
  }

  if (!databaseUrl) {
    const dbInput = await p.text({
      message: "PostgreSQL connection URL:",
      placeholder: "postgres://user:password@host:5432/dbname",
      validate: (v) => {
        if (!v?.startsWith("postgres://") && !v?.startsWith("postgresql://")) {
          return "Must start with postgres:// or postgresql://";
        }
      },
    });
    if (p.isCancel(dbInput)) cancelled();
    databaseUrl = dbInput;
  }

  if (!qdrantUrl) {
    const qdInput = await p.text({
      message: "Qdrant URL (leave empty to skip vector search):",
      placeholder: "http://127.0.0.1:6333",
      defaultValue: "",
    });
    if (p.isCancel(qdInput)) cancelled();
    qdrantUrl = qdInput;
  }

  // Step 3: Environment Config
  const webToken =
    existingEnv.OPENCROW_WEB_TOKEN ?? crypto.randomBytes(24).toString("hex");

  const openrouterKey = await p.text({
    message: "OpenRouter API key (for embeddings, optional):",
    placeholder: "sk-or-v1-...",
    defaultValue: existingEnv.OPENROUTER_API_KEY ?? "",
  });
  if (p.isCancel(openrouterKey)) cancelled();

  // Step 5: Telegram Setup
  let telegramToken = existingEnv.TELEGRAM_BOT_TOKEN ?? "";

  const setupTelegram = await p.confirm({
    message: "Set up Telegram bot?",
    initialValue: !telegramToken,
  });
  if (p.isCancel(setupTelegram)) cancelled();

  if (setupTelegram) {
    p.log.step("1. Open Telegram and message @BotFather");
    p.log.step("2. Send /newbot and follow the prompts");
    p.log.step("3. Copy the bot token");

    const tokenInput = await p.text({
      message: "Telegram bot token:",
      placeholder: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ",
      defaultValue: telegramToken,
      validate: (v) => {
        if (v && !v.includes(":")) return "Token should contain a colon";
      },
    });
    if (p.isCancel(tokenInput)) cancelled();
    telegramToken = tokenInput;
  }

  // Step 6: WhatsApp Setup
  const setupWhatsapp = await p.confirm({
    message:
      "Set up WhatsApp? (QR code will appear in web UI when service starts)",
    initialValue: false,
  });
  if (p.isCancel(setupWhatsapp)) cancelled();

  if (setupWhatsapp) {
    p.log.info("WhatsApp will be configured automatically.");
    p.log.info(
      "After the service starts, open the web UI to scan the QR code.",
    );
  }

  // Write .env
  const envVars: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    OPENCROW_WEB_TOKEN: webToken,
  };

  if (qdrantUrl) envVars.QDRANT_URL = qdrantUrl;
  if (openrouterKey) envVars.OPENROUTER_API_KEY = openrouterKey;
  if (telegramToken) envVars.TELEGRAM_BOT_TOKEN = telegramToken;

  // Preserve any existing env vars not covered above
  const preserved = { ...existingEnv, ...envVars };
  writeEnvFile(preserved);
  p.log.success(`Environment written to ${ENV_PATH}`);

  // Step 4: Database Migration
  const s = p.spinner();
  s.start("Running database migrations...");

  const migrationResult = runCmd(
    "bun",
    ["run", path.join(APP_DIR, "src", "store", "migrate.ts")],
    APP_DIR,
  );
  if (!migrationResult.ok) {
    // Try importing initDb directly as a fallback
    try {
      process.env.DATABASE_URL = databaseUrl;
      const { initDb, closeDb } = await import("../store/db.ts");
      await initDb(databaseUrl, { max: 2 });
      await closeDb();
      s.stop("Database migrations complete");
    } catch (dbErr) {
      s.stop("Migration warning");
      p.log.warn(
        `Could not run migrations: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
      );
      p.log.warn("Migrations will run automatically when the service starts.");
    }
  } else {
    s.stop("Database migrations complete");
  }

  // Step 7: Web UI
  p.log.info(`Web UI password: ${webToken}`);
  p.log.info("Web UI URL: http://localhost:48080");

  // Step 8: Daemon Installation
  const installDaemon = await p.confirm({
    message: "Install as a system service (auto-start on boot)?",
    initialValue: true,
  });
  if (p.isCancel(installDaemon)) cancelled();

  if (installDaemon) {
    try {
      const { runServiceCommand } = await import("./service.ts");
      await runServiceCommand("install", "core");
      await runServiceCommand("install", "web");
      p.log.success("Services installed and started (core + web)");
    } catch (svcErr) {
      p.log.warn(
        `Service install failed: ${svcErr instanceof Error ? svcErr.message : String(svcErr)}`,
      );
      p.log.info("You can start manually: opencrow start");
    }
  }

  // Step 9: Success
  p.outro("Setup complete!");

  console.log("");
  console.log("  Next steps:");
  console.log(`    Open http://localhost:48080 to access the web UI`);
  console.log(`    Use password: ${webToken.slice(0, 8)}... to log in`);
  if (telegramToken) {
    console.log("    Send a message to your Telegram bot to test");
  }
  if (setupWhatsapp) {
    console.log("    Open web UI to scan the WhatsApp QR code");
  }
  console.log("");
  console.log("  Commands:");
  console.log("    opencrow doctor   Check system health");
  console.log("    opencrow update   Update to latest version");
  console.log("    opencrow status   Show running processes");
  console.log("");
}
