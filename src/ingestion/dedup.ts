/**
 * Exact-duplicate detection for ingested content.
 *
 * Backed by the `sige_ingest_dedup` Postgres table (SHA-256 of normalised text).
 *
 * NOTE: the table name `sige_ingest_dedup` is a LEGACY persisted identifier kept
 * AS-IS for compatibility. Renaming it would require a migration; it is decoupled
 * from the `sige` domain in every other respect.
 */

import { createHash } from "node:crypto";

import { getDb } from "../store/db";

/**
 * Normalise content for dedup hashing:
 * lowercase → collapse non-alphanumeric runs → trim.
 * This makes minor whitespace and punctuation variants collide to the same hash.
 */
export function normaliseForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Compute a stable SHA-256 hex hash of normalised content.
 */
export function contentHash(text: string): string {
  return createHash("sha256").update(normaliseForHash(text)).digest("hex");
}

/**
 * Check whether a content hash already exists in sige_ingest_dedup.
 * Returns true if this is a duplicate (should be dropped).
 */
export async function isDuplicate(hash: string): Promise<boolean> {
  const db = getDb();
  const rows = await db`
    SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${hash} LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Record a content hash in sige_ingest_dedup.
 * ON CONFLICT DO NOTHING — safe to call even if somehow inserted twice.
 */
export async function recordHash(hash: string, source: string): Promise<void> {
  const db = getDb();
  await db`
    INSERT INTO sige_ingest_dedup (content_hash, source)
    VALUES (${hash}, ${source})
    ON CONFLICT (content_hash) DO NOTHING
  `;
}
