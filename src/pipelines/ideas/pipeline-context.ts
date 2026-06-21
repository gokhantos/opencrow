/**
 * Context-building helpers for the ideas pipeline.
 *
 * Handles data loading and prompt-context assembly:
 *   - Theme extraction (ngram + semantic)
 *   - Saturated-themes block builder
 *   - Validated exemplar fetcher
 *   - Scored-idea row loader for the taste loop
 *   - Taste blocks builder (golden + anti exemplars)
 *   - Deep-search options builder
 *   - Source-credibility posterior loader
 * Extracted from pipeline.ts to keep that file under the 800-line ceiling.
 */

import { createLogger } from "../../logger";
import type { MemoryManager } from "../../memory/types";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import type { SmartIdeasConfig, TasteConfig } from "../../config/schema";
import type { SigeConfig } from "../../config/schema";
import { getIdeasByStage } from "../../sources/ideas/store";
import { getDb } from "../../store/db";
import type { ModelProvider } from "../../store/model-routing";
import { credibilityKey, getSourceCredibility } from "./credibility";
import type { DeepSearchOptions, ValidatedExemplar } from "./synthesizer";
import { buildValidatedExemplars } from "./synthesizer";
import {
  renderAntiBlock,
  renderGoldenBlock,
  type ScoredIdeaRow,
  selectAntiExemplars,
  selectGoldenExemplars,
} from "./taste";
import { parseGiantScores } from "./feedback-bootstrap";

const log = createLogger("pipeline:ideas");

// ─────────────────────────────────────────────────────────────────────────────
// Theme extraction
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "it",
  "that",
  "this",
  "are",
  "was",
  "be",
  "has",
  "had",
  "have",
  "will",
  "can",
  "do",
  "does",
  "your",
  "you",
  "app",
  "tool",
  "platform",
  "system",
  "based",
  "using",
  "new",
  "smart",
]);

function tokenize(title: string): readonly string[] {
  return title
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length >= 3);
}

/**
 * Bigram/trigram theme extraction over idea rows (fast, no LLM). Exported so the
 * autonomous-SIGE frontier discovery stage (`frontier-discovery.ts`) reuses the
 * SAME n-gram logic for saturation overlap instead of drifting a parallel copy.
 * PURE.
 */
export function extractThemesByNgrams(
  rows: ReadonlyArray<{ readonly title: string; readonly summary: string }>,
): readonly string[] {
  const bigramCounts = new Map<string, string[]>();
  const trigramCounts = new Map<string, string[]>();

  for (const { title } of rows) {
    const tokens = tokenize(title);
    const seen = new Set<string>();

    for (let i = 0; i < tokens.length - 1; i++) {
      const w1 = tokens[i]!;
      const w2 = tokens[i + 1]!;
      if (STOP_WORDS.has(w1) && STOP_WORDS.has(w2)) continue;
      const bigram = `${w1} ${w2}`;
      if (!seen.has(bigram)) {
        seen.add(bigram);
        const list = bigramCounts.get(bigram) ?? [];
        list.push(title);
        bigramCounts.set(bigram, list);
      }
    }

    for (let i = 0; i < tokens.length - 2; i++) {
      const w1 = tokens[i]!;
      const w2 = tokens[i + 1]!;
      const w3 = tokens[i + 2]!;
      if (STOP_WORDS.has(w1) && STOP_WORDS.has(w2) && STOP_WORDS.has(w3)) continue;
      const trigram = `${w1} ${w2} ${w3}`;
      if (!seen.has(trigram)) {
        seen.add(trigram);
        const list = trigramCounts.get(trigram) ?? [];
        list.push(title);
        trigramCounts.set(trigram, list);
      }
    }
  }

  // Build a title → summary lookup for enriched output
  const summaryByTitle = new Map<string, string>();
  for (const { title, summary } of rows) {
    summaryByTitle.set(title, summary);
  }

  const allNgrams: Array<{ readonly phrase: string; readonly hits: readonly string[] }> = [];

  for (const [phrase, hits] of trigramCounts) {
    const unique = [...new Set(hits)];
    if (unique.length >= 2) allNgrams.push({ phrase, hits: unique });
  }

  for (const [phrase, hits] of bigramCounts) {
    const unique = [...new Set(hits)];
    if (unique.length >= 3) allNgrams.push({ phrase, hits: unique });
  }

  allNgrams.sort((a, b) => b.hits.length - a.hits.length);

  const lines: string[] = [];
  for (const { phrase, hits } of allNgrams) {
    const exampleTitle = hits[0] ?? "";
    const exampleSummary = summaryByTitle.get(exampleTitle);
    const note = exampleSummary
      ? ` — e.g. "${exampleTitle}" (${exampleSummary.slice(0, 80).trim()}…)`
      : ` — e.g. ${hits.slice(0, 2).join(", ")}`;
    lines.push(`- "${phrase}" theme (${hits.length} ideas)${note}`);
    if (lines.length >= 15) break;
  }

  return lines;
}

async function extractSemanticThemes(
  rows: ReadonlyArray<{ readonly title: string; readonly summary: string }>,
  memoryManager: MemoryManager,
): Promise<readonly string[]> {
  const lines: string[] = [];

  for (const row of rows) {
    if (lines.length >= 5) break;
    try {
      const results = await memoryManager.search("shared", `${row.title}: ${row.summary}`, {
        limit: 3,
        minScore: 0.7,
        kinds: ["idea"],
      });
      const matches = results.filter((r) => r.score >= 0.7);
      if (matches.length >= 2) {
        lines.push(`- Theme around "${row.title}" (similar to ${matches.length} existing ideas)`);
      }
    } catch {
      // non-fatal: semantic search failure skips this row
    }
  }

  return lines;
}

export async function buildSaturatedThemes(memoryManager?: MemoryManager | null): Promise<string> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT title, summary FROM generated_ideas
      WHERE pipeline_run_id IS NOT NULL
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
      ORDER BY created_at DESC
      LIMIT 500
    `) as Array<{ title: string; summary: string }>;

    if (rows.length === 0) return "";

    // Level 1: bigram/trigram theme detection (fast, no LLM)
    const themeLines = extractThemesByNgrams(rows);

    // Level 2: semantic clustering via memory search (optional)
    const semanticLines = memoryManager
      ? await extractSemanticThemes(rows.slice(0, 50), memoryManager)
      : [];

    const combined = [...themeLines, ...semanticLines];
    if (combined.length === 0) return "";

    return combined.join("\n");
  } catch {
    return "";
  }
}

/**
 * Seed-diversity lever 1 helper: the distinct categories that RECENT generated
 * ideas have anchored on. selectFocusCategories de-prioritizes these in its
 * rotated tail so consecutive runs don't keep re-anchoring on the same corners
 * of the category distribution. COMPLEMENTS buildSaturatedThemes() (which mines
 * saturated THEME phrases, not store categories).
 *
 * Pure read-only; degrades to [] on any error so the caller's rotation falls
 * back to the un-penalized seeded order.
 */
export async function loadRecentlyAnchoredCategories(limit = 40): Promise<readonly string[]> {
  if (limit <= 0) return [];
  try {
    const db = getDb();
    const rows = (await db`
      SELECT DISTINCT category
      FROM generated_ideas
      WHERE pipeline_run_id IS NOT NULL
        AND category IS NOT NULL AND category != ''
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
      ORDER BY category
      LIMIT ${limit}
    `) as Array<{ category: string }>;
    return rows.map((r) => r.category).filter((c): c is string => Boolean(c));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exemplar fetchers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #5 — Fetch human-validated ideas to use as positive few-shot exemplars.
 * Degrades to [] on any error; the caller passes the rendered block
 * unconditionally (synthesizeFromTrends re-gates it via smart.validatedExemplars).
 */
export async function fetchValidatedExemplars(limit = 12): Promise<readonly ValidatedExemplar[]> {
  try {
    const validated = await getIdeasByStage("validated", limit);
    return validated.map((i) => ({
      title: i.title,
      summary: i.summary,
      category: i.category,
    }));
  } catch (err) {
    log.warn("Failed to fetch validated exemplars", { err });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Taste loop
// ─────────────────────────────────────────────────────────────────────────────

/** A subset of generated_ideas columns the taste loop reads back. */
interface ScoredIdeaDbRow {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string | null;
  readonly segment: string | null;
  readonly giant_composite: number | null;
  readonly giant_scores_json: unknown;
  readonly archetype: string | null;
  readonly demand_score: number | null;
  readonly whitespace: number | null;
  readonly pipeline_stage: string | null;
}

/**
 * PHASE 4 — Map a raw generated_ideas row onto the PURE {@link ScoredIdeaRow} the
 * taste selectors consume. The GIANT scorecard is unwrapped via parseGiantScores
 * (handles flat {axis:n} AND the nested {scores:{axis:n}} blob stampIdeaAllMeta
 * writes). `whitespace` (a REAL 0..1 in the DB) is projected to the boolean flag
 * the row carries. All scoring fields stay optional so partial rows degrade. PURE.
 */
export function toScoredIdeaRow(row: ScoredIdeaDbRow): ScoredIdeaRow {
  const giantScores = parseGiantScores(row.giant_scores_json);
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    category: row.category,
    segment: row.segment,
    giantComposite: row.giant_composite,
    giantScores: Object.keys(giantScores).length > 0 ? giantScores : null,
    archetype: row.archetype,
    demandScore: row.demand_score,
    whitespace: typeof row.whitespace === "number" ? row.whitespace > 0 : null,
    pipelineStage: row.pipeline_stage,
  };
}

/**
 * PHASE 4 — Load the scored-idea pool the taste selectors derive exemplars from:
 * ALL human-validated rows (precedence) plus the most-recent non-archived scored
 * rows (the synthetic-bootstrap pool). selectGoldenExemplars / selectAntiExemplars
 * filter by stage internally. Fully GRACEFUL — returns [] on any failure so the
 * optional taste path always falls back to empty blocks (mirrors
 * fetchValidatedExemplars / loadCredibilityPosteriors). Pipeline phase owns it.
 */
export async function fetchScoredIdeaRows(recentLimit = 400): Promise<readonly ScoredIdeaRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      (
        SELECT id, title, summary, category, segment, giant_composite,
               giant_scores_json, archetype, demand_score, whitespace, pipeline_stage
        FROM generated_ideas
        WHERE pipeline_stage = 'validated'
      )
      UNION
      (
        SELECT id, title, summary, category, segment, giant_composite,
               giant_scores_json, archetype, demand_score, whitespace, pipeline_stage
        FROM generated_ideas
        WHERE COALESCE(pipeline_stage, 'idea') NOT IN ('archived', 'validated')
        ORDER BY created_at DESC
        LIMIT ${recentLimit}
      )
    `) as ScoredIdeaDbRow[];
    return rows.map(toScoredIdeaRow);
  } catch (err) {
    log.warn("Failed to load scored idea rows for taste loop", { err });
    return [];
  }
}

/** The rendered taste prompt blocks plus counts for instrumentation (PURE). */
export interface TasteBlocks {
  /** Positive "produce MORE like these" block (golden), or "" when empty/off. */
  readonly goldenBlock: string;
  /** Negative "AVOID these generic archetypes" block, or "" when empty/off. */
  readonly antiBlock: string;
  readonly goldenCount: number;
  readonly antiCount: number;
  /** How many golden picks are still synthetic (vs human-validated). */
  readonly syntheticGoldenCount: number;
}

/**
 * PHASE 4 — Build the golden + anti exemplar prompt blocks from the loaded scored
 * pool, gated per-lever under smart.taste. Golden picks are SEGMENT-DIVERSE,
 * rotated by the per-run seed, and capped LOW (exemplarCount). Real human-
 * validated picks take precedence and replace synthetic ones above
 * goldenMinHumanLabels. PURE — no IO; takes the already-loaded rows + flags.
 */
export function buildTasteBlocks(
  scoredRows: readonly ScoredIdeaRow[],
  taste: TasteConfig,
  rotationSeed: number,
): TasteBlocks {
  const goldenExemplars = taste.syntheticGolden
    ? selectGoldenExemplars(scoredRows, {
        exemplarCount: taste.exemplarCount,
        goldenMinHumanLabels: taste.goldenMinHumanLabels,
        rotationSeed,
      })
    : [];

  const antiExemplars = taste.antiExemplars
    ? selectAntiExemplars(scoredRows, {
        exemplarCount: taste.exemplarCount,
        rotationSeed,
      })
    : [];

  return {
    goldenBlock: renderGoldenBlock(goldenExemplars),
    antiBlock: renderAntiBlock(antiExemplars),
    goldenCount: goldenExemplars.length,
    antiCount: antiExemplars.length,
    syntheticGoldenCount: goldenExemplars.filter((g) => g.synthetic).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep-search options
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #13 — Assemble the optional deepSearch dependencies. The reranker `model` is
 * always supplied (deepSearch falls back to LLM-listwise rerank when no embedder
 * is present and the flag is on). The Mem0 client + userId are only built when
 * smart.knowledgeGraphRetrieval is on (now the default) so graph FACTS can be
 * injected into synthesis; if the client build throws we drop back to the
 * model-only branch. deepSearch itself gates each enrichment on the smart flags
 * it reads directly, and degrades to no graph context on any mem0 failure.
 */
export function buildDeepSearchOptions(
  model: string,
  smart: SmartIdeasConfig,
  sigeConfig: SigeConfig | undefined,
  // REQUIRED routed provider (no Claude default) — threaded into the rerank call.
  provider: ModelProvider,
): DeepSearchOptions {
  if (!smart.knowledgeGraphRetrieval) {
    return { model, provider };
  }

  const baseUrl = sigeConfig?.mem0.baseUrl ?? "http://127.0.0.1:8050";
  const userId = sigeConfig?.mem0.userId ?? "sige-global";
  const apiToken = sigeConfig?.mem0.apiToken;

  try {
    return { model, provider, mem0: new Mem0Client({ baseUrl, apiToken }), userId };
  } catch (err) {
    log.warn("Failed to build Mem0 client for graph retrieval — skipping graph branch", { err });
    return { model, provider };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source-credibility posteriors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * #4 part2 — Load Beta-Bernoulli source-credibility posteriors keyed by
 * credibilityKey(source_table, signal_type, category). Fully graceful: returns
 * an empty map when no feedback exists yet. The map is informational for the
 * collector ordering (collectors already rank by per-row credibility); folding
 * the posterior into selection requires a CollectorContext field — see the
 * notesForNextPhase seam.
 */
export async function loadCredibilityPosteriors(): Promise<ReadonlyMap<string, number>> {
  try {
    const creds = await getSourceCredibility();
    const map = new Map<string, number>();
    for (const c of creds) {
      map.set(credibilityKey(c.source_table, c.signal_type, c.category), c.mean);
    }
    return map;
  } catch (err) {
    log.warn("Failed to load source-credibility posteriors", { err });
    return new Map();
  }
}

// Re-export buildValidatedExemplars so pipeline.ts can continue to use it
// through the context module without importing from synthesizer directly.
export { buildValidatedExemplars };
