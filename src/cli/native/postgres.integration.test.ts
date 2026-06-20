import { test, expect } from "bun:test";
import { SQL } from "bun";
import { ensureOpencrowDb } from "./postgres.ts";

// Admin/bootstrap connection. CI provides a Postgres container with the opencrow
// superuser; on a native brew Postgres (no opencrow role yet) override with
// PG_ADMIN_URL=postgres://<localuser>@127.0.0.1:5432/postgres (peer/trust auth).
const ADMIN_URL =
  process.env.PG_ADMIN_URL ?? "postgres://opencrow:opencrow@127.0.0.1:5432/postgres";

test("ensureOpencrowDb creates role + db idempotently", async () => {
  await ensureOpencrowDb(ADMIN_URL);
  await ensureOpencrowDb(ADMIN_URL); // second call must not throw

  const db = new SQL({ url: "postgres://opencrow:opencrow@127.0.0.1:5432/opencrow", max: 1 });
  const rows = await db`SELECT 1 as ok`;
  expect(rows[0].ok).toBe(1);
  await db.close();
});
