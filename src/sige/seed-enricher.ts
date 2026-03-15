/**
 * Enriches a SIGE session seed input with relevant data from the project's
 * existing knowledge: past ideas from the ideas pipeline.
 *
 * If any enrichment step fails the original seed is returned unchanged so the
 * pipeline is never blocked by an enrichment error.
 */
import { getDb } from "../store/db";
import { createLogger } from "../logger";

const log = createLogger("sige:seed-enricher");

const MAX_IDEAS = 10;

interface IdeaRow {
  readonly title: string;
  readonly summary: string;
  readonly category: string;
}

async function fetchRelatedIdeas(topic: string): Promise<readonly IdeaRow[]> {
  const db = getDb();

  // Use PostgreSQL full-text search with a simple plainto_tsquery so we do not
  // need pgvector or any external service.  Falls back to the most-recent ideas
  // when the FTS index finds nothing.
  const keyword = topic.slice(0, 200); // guard against enormous inputs

  const ftsRows = (await db`
    SELECT title, summary, category
    FROM generated_ideas
    WHERE to_tsvector('english', title || ' ' || summary) @@ plainto_tsquery('english', ${keyword})
    ORDER BY created_at DESC
    LIMIT ${MAX_IDEAS}
  `) as IdeaRow[];

  if (ftsRows.length > 0) return ftsRows;

  // Fallback: return the most recent ideas regardless of topic
  return (await db`
    SELECT title, summary, category
    FROM generated_ideas
    ORDER BY created_at DESC
    LIMIT ${MAX_IDEAS}
  `) as IdeaRow[];
}

function buildEnrichedSeed(
  originalSeed: string,
  ideas: readonly IdeaRow[],
): string {
  const parts: string[] = [`## User Query\n${originalSeed}`];

  if (ideas.length > 0) {
    const ideaLines = ideas
      .map((i) => `- **${i.title}** (${i.category}): ${i.summary}`)
      .join("\n");
    parts.push(`## Related Ideas from Past Sessions\n${ideaLines}`);
  }

  return parts.join("\n\n");
}

/**
 * Returns an enriched version of `seedInput` that includes related ideas from
 * the project database.  Never throws — returns the original seed on failure.
 */
export async function enrichSeedWithProjectData(
  seedInput: string,
): Promise<string> {
  try {
    const ideas = await fetchRelatedIdeas(seedInput);

    if (ideas.length === 0) {
      log.debug("No related ideas found, using original seed");
      return seedInput;
    }

    const enriched = buildEnrichedSeed(seedInput, ideas);

    log.info("Seed enriched with project data", {
      ideaCount: ideas.length,
    });

    return enriched;
  } catch (err) {
    log.warn("Seed enrichment failed, falling back to original seed", { err });
    return seedInput;
  }
}
