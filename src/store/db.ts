import { SQL } from "bun";
import { MIGRATIONS } from "./migrations/index";
import { createLogger } from "../logger";
import { getErrorMessage } from "../lib/error-serialization";

const logger = createLogger("db");

let db: InstanceType<typeof SQL> | null = null;

export function getDb(): InstanceType<typeof SQL> {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

/**
 * Fallback pool ceiling, applied only when a caller omits { max }. Every
 * spawned process passes its own `dbPoolSize` explicitly (see bootstrap.ts:
 * cron 10, web/agent/sige 5, scraper 2, core 3), so this governs only the
 * stragglers: CLI setup, the secrets lazy fallback, and tests. Kept small so
 * those paths don't add idle connections to pg_stat_activity.
 */
const DEFAULT_POOL_MAX = 3;

/**
 * How long (in seconds) an idle connection is kept open before being closed.
 * 0 = no timeout (Bun default, leads to connection sprawl in a multi-process
 * setup). 30 s gives idle backends time to close on their own so Postgres sees
 * fewer connections at rest.
 */
const DEFAULT_IDLE_TIMEOUT_SEC = 30;

export async function initDb(
  url?: string,
  opts?: { max?: number; idleTimeout?: number },
): Promise<InstanceType<typeof SQL>> {
  const connUrl = url ?? process.env.DATABASE_URL;
  if (!connUrl) {
    throw new Error(
      "DATABASE_URL not set. Provide a url or set the DATABASE_URL env var.",
    );
  }

  db = new SQL({
    url: connUrl,
    max: opts?.max ?? DEFAULT_POOL_MAX,
    idleTimeout: opts?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT_SEC,
  });
  await runMigrations(db);
  return db;
}

async function runMigrations(
  database: InstanceType<typeof SQL>,
): Promise<void> {
  const failures: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < MIGRATIONS.length; i++) {
    try {
      await database.unsafe(MIGRATIONS[i]!);
    } catch (err) {
      const msg = getErrorMessage(err);
      failures.push({ index: i, error: msg });
      logger.warn("Migration failed (non-fatal)", { migration: i, error: msg });
    }
  }

  if (failures.length > 0) {
    logger.warn(
      "Migration(s) failed (non-fatal), service continuing",
      { failures: failures.length },
    );
  }
}

export async function closeDb(): Promise<void> {
  if (db) {
    const closeTimeout = new Promise<void>((resolve) =>
      setTimeout(resolve, 2000),
    );
    await Promise.race([db.close(), closeTimeout]);
    db = null;
  }
}

