/**
 * SIGE → generated_ideas cross-write (#11 part2).
 *
 * When a SIGE session finishes scoring its ideas, this module optionally
 * promotes the top scored ideas into the shared `generated_ideas` table so they
 * surface alongside the trend-intersection pipeline's output. The write is
 * routed through the SAME 3-layer dedup (`checkForDuplicates`) the ideas
 * pipeline uses, so SIGE never floods the table with near-duplicates of ideas
 * that already exist.
 *
 * This whole path is GATED, default OFF: callers only invoke it when
 * `smart.sigeValuation` is on AND `config.sige.enabled` is on. When off, SIGE
 * behavior is completely unchanged.
 *
 * It degrades gracefully: any failure (dedup search, DB insert) is caught and
 * logged — a cross-write failure must NEVER break the SIGE session pipeline.
 *
 * Mapping (columns already exist in 004_sige.sql):
 *   ScoredIdea.title              → generated_ideas.title
 *   ScoredIdea.description         → generated_ideas.summary
 *   ScoredIdea.fusedScore          → generated_ideas.game_theoretic_score
 *   sessionId                      → generated_ideas.sige_session_id
 *   ScoredIdea.strategicMetadata   → generated_ideas.strategic_metadata_json
 *   provenance source='sige'       → generated_ideas.source_ids_json
 */

import { getDb } from "../store/db";
import { createLogger } from "../logger";
import { checkForDuplicates } from "../pipelines/ideas/validate";
import type { GeneratedIdeaCandidate } from "../pipelines/ideas/types";
import type { MemoryManager } from "../memory/types";
import type { ScoredIdea } from "./types";

const log = createLogger("sige:cross-write");

/** agent_id stamped on generated_ideas rows sourced from a SIGE session. */
export const SIGE_AGENT_ID = "sige";

/** Default cap on how many top ideas a session promotes into generated_ideas. */
export const DEFAULT_SIGE_CROSS_WRITE_LIMIT = 5;

/**
 * Map a SIGE ScoredIdea into the GeneratedIdeaCandidate shape the shared
 * dedup understands. Pure. Only title + summary participate in dedup; the
 * remaining fields are neutral placeholders so the candidate is a valid object.
 */
export function scoredIdeaToCandidate(
  idea: ScoredIdea,
): GeneratedIdeaCandidate {
  return {
    title: idea.title,
    summary: idea.description,
    reasoning: idea.description,
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "sige",
    category: "sige",
    // fusedScore is in [0,1]; map to the 1–5 quality scale used by the table.
    qualityScore: Math.min(Math.max((idea.fusedScore ?? idea.expertScore) * 4 + 1, 1), 5),
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
  };
}

/** A {table, id} provenance entry for a SIGE-sourced idea. */
interface SigeProvenanceEntry {
  readonly table: "sige_idea_scores";
  readonly id: string;
}

export interface SigeCrossWriteResult {
  /** Number of ideas inserted into generated_ideas. */
  readonly inserted: number;
  /** Titles rejected by the 3-layer dedup. */
  readonly rejected: readonly string[];
}

/**
 * Insert a single SIGE-sourced idea into generated_ideas with the SIGE linkage
 * columns populated. Best-effort — caller wraps the batch in try/catch too.
 */
async function insertSigeIdea(
  idea: ScoredIdea,
  sessionId: string,
): Promise<void> {
  const db = getDb();
  const id = crypto.randomUUID();

  const provenance: readonly SigeProvenanceEntry[] = [
    { table: "sige_idea_scores", id: idea.id },
  ];

  const qualityScore = Math.min(
    Math.max((idea.fusedScore ?? idea.expertScore) * 4 + 1, 1),
    5,
  );

  await db`
    INSERT INTO generated_ideas
      (id, agent_id, title, summary, reasoning, sources_used, category,
       quality_score, source_ids_json,
       sige_session_id, game_theoretic_score, strategic_metadata_json)
    VALUES
      (${id}, ${SIGE_AGENT_ID}, ${idea.title}, ${idea.description}, ${idea.description},
       ${"sige"}, ${"sige"}, ${qualityScore}, ${JSON.stringify(provenance)},
       ${sessionId}, ${idea.fusedScore ?? null}, ${JSON.stringify(idea.strategicMetadata)})
  `;
}

/**
 * Promote the top SIGE-scored ideas into generated_ideas, routed through the
 * shared 3-layer dedup. Never throws — returns a result summary and logs on
 * failure so a cross-write problem can't fail the SIGE session.
 *
 * @param rankedIdeas  Session ideas (already enriched with fusedScore).
 * @param sessionId    SIGE session id (written to sige_session_id).
 * @param memoryManager Optional — enables the semantic dedup layer.
 * @param limit        Max ideas to promote (default 5, top-N by fusedScore).
 */
export async function crossWriteSigeIdeas(
  rankedIdeas: readonly ScoredIdea[],
  sessionId: string,
  memoryManager: MemoryManager | null | undefined,
  limit: number = DEFAULT_SIGE_CROSS_WRITE_LIMIT,
): Promise<SigeCrossWriteResult> {
  try {
    if (rankedIdeas.length === 0) {
      return { inserted: 0, rejected: [] };
    }

    // Top-N by fusedScore (falling back to expertScore), highest first.
    const topIdeas = [...rankedIdeas]
      .sort(
        (a, b) =>
          (b.fusedScore ?? b.expertScore) - (a.fusedScore ?? a.expertScore),
      )
      .slice(0, Math.max(0, limit));

    const candidates = topIdeas.map(scoredIdeaToCandidate);

    // Route through the SAME 3-layer dedup the ideas pipeline uses.
    const { kept, rejected } = await checkForDuplicates(
      candidates,
      memoryManager,
    );

    const keptTitles = new Set(kept.map((c) => c.title));
    const ideasToWrite = topIdeas.filter((idea) => keptTitles.has(idea.title));

    let inserted = 0;
    for (const idea of ideasToWrite) {
      try {
        await insertSigeIdea(idea, sessionId);
        inserted += 1;
      } catch (err) {
        log.warn("Failed to cross-write a SIGE idea (non-fatal)", {
          sessionId,
          ideaId: idea.id,
          title: idea.title,
          err,
        });
      }
    }

    log.info("SIGE → generated_ideas cross-write complete", {
      sessionId,
      candidates: candidates.length,
      inserted,
      rejected: rejected.length,
    });

    return { inserted, rejected };
  } catch (err) {
    log.error(
      "SIGE cross-write failed (non-fatal — session continues)",
      { sessionId, err },
    );
    return { inserted: 0, rejected: [] };
  }
}
