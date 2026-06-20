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
