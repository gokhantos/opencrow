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
 * 0 = no idle-close (Bun's own default).
 *
 * Disabled by default. A 30 s idle-close was briefly used to shed idle
 * connections that were costing CPU under the x86 Colima/QEMU emulation — but
 * the stack now runs native arm64 where idle connections are essentially free,
 * and `DEFAULT_POOL_MAX` already caps each process to a few connections. The
 * idle-close, meanwhile, is a footgun in Bun 1.3.x: when the timer reaps a
 * pooled connection, the *next* query throws "Idle timeout reached after 30s"
 * instead of transparently reconnecting. Any process that legitimately sits
 * idle past the timeout between writes (SIGE games during long LLM phases, a
 * scraper polling every 30 min, batch ingestion) then fails its next write.
 * Keeping connections open avoids the footgun for all processes; callers that
 * truly want idle-close can still pass `idleTimeout` explicitly.
 */
const DEFAULT_IDLE_TIMEOUT_SEC = 0;

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

