import { SQL } from "bun";
import { MIGRATIONS } from "./migrations/index";
import { createLogger } from "../logger";

const logger = createLogger("db");

let db: InstanceType<typeof SQL> | null = null;

export function getDb(): InstanceType<typeof SQL> {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export async function initDb(
  url?: string,
  opts?: { max?: number },
): Promise<InstanceType<typeof SQL>> {
  const connUrl = url ?? process.env.DATABASE_URL;
  if (!connUrl) {
    throw new Error(
      "DATABASE_URL not set. Provide a url or set the DATABASE_URL env var.",
    );
  }

  db = new SQL({
    url: connUrl,
    max: opts?.max ?? 20,
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
      const msg = err instanceof Error ? err.message : String(err);
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

