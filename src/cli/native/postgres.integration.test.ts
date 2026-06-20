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
