import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("fts");

export interface FtsResult {
  readonly chunkId: string;
  readonly rank: number;
  readonly content: string;
}

export async function ftsSearch(
  agentId: string,
  ftsQuery: string,
  limit: number,
  opts?: { shared?: boolean },
): Promise<readonly FtsResult[]> {
  if (!ftsQuery.trim()) return [];
  const db = getDb();

  try {
    const rows = opts?.shared
      ? await db`
          SELECT
            c.id                                                                        AS "chunkId",
            ts_rank(c.tsv_content, websearch_to_tsquery('english', ${ftsQuery}))       AS rank,
            c.content
          FROM memory_chunks c
          JOIN memory_sources s ON s.id = c.source_id
          WHERE
            c.tsv_content @@ websearch_to_tsquery('english', ${ftsQuery})
          ORDER BY rank DESC
          LIMIT ${limit}
        `
      : await db`
          SELECT
            c.id                                                                        AS "chunkId",
            ts_rank(c.tsv_content, websearch_to_tsquery('english', ${ftsQuery}))       AS rank,
            c.content
          FROM memory_chunks c
          JOIN memory_sources s ON s.id = c.source_id
          WHERE
            s.agent_id = ${agentId}
            AND c.tsv_content @@ websearch_to_tsquery('english', ${ftsQuery})
          ORDER BY rank DESC
          LIMIT ${limit}
        `;
    return rows as unknown as FtsResult[];
  } catch (err) {
    // FTS column not yet populated or query malformed — return empty
    log.debug("FTS search failed (non-critical)", {
      ftsQuery,
      error: err,
    });
    return [];
  }
}

export async function updateChunkFts(
  chunkId: string,
  content: string,
): Promise<void> {
  const db = getDb();
  try {
    await db`
      UPDATE memory_chunks
      SET tsv_content = to_tsvector('english', ${content})
      WHERE id = ${chunkId}
    `;
  } catch (err) {
    // Non-critical: FTS update failure does not break indexing
    log.debug("FTS index update failed (non-critical)", {
      chunkId,
      error: err,
    });
  }
}
