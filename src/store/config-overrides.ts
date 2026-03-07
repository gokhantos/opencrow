import { getDb } from "./db";

export interface ConfigOverride {
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: number;
}

export function getOverride(
  namespace: string,
  key: string,
): Promise<unknown | null> {
  return getDb()`
    SELECT value_json FROM config_overrides
    WHERE namespace = ${namespace} AND key = ${key}
  `.then((rows) => {
    const row = rows[0] as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : null;
  });
}

export async function setOverride(
  namespace: string,
  key: string,
  value: unknown,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const json = JSON.stringify(value);
  const db = getDb();
  await db`
    INSERT INTO config_overrides (namespace, key, value_json, updated_at)
    VALUES (${namespace}, ${key}, ${json}, ${now})
    ON CONFLICT (namespace, key)
    DO UPDATE SET value_json = ${json}, updated_at = ${now}
  `;
}

export async function deleteOverride(
  namespace: string,
  key: string,
): Promise<void> {
  const db = getDb();
  await db`
    DELETE FROM config_overrides
    WHERE namespace = ${namespace} AND key = ${key}
  `;
}

export async function getAllOverrides(
  namespace: string,
): Promise<readonly ConfigOverride[]> {
  const db = getDb();
  const rows = await db`
    SELECT namespace, key, value_json, updated_at
    FROM config_overrides
    WHERE namespace = ${namespace}
    ORDER BY key
    LIMIT 500
  `;
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    namespace: row.namespace as string,
    key: row.key as string,
    value: JSON.parse(row.value_json as string),
    updatedAt: row.updated_at as number,
  }));
}
