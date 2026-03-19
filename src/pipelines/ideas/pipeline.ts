/**
 * Trend-Intersection Idea Pipeline.
 *
 * Steps:
 * 1. trends — Detect what's moving in app store rankings
 * 2. pain_points — Cluster complaints in trending categories
 * 3. capabilities — Scan PH/HN/GitHub/News/Reddit/X for new capabilities
 * 4. deep_search — Qdrant semantic search for supporting evidence
 * 5. synthesis — AI finds intersections: trend + pain + capability = idea
 * 6. validate — Semantic dedup via Qdrant
 * 7. store — Save ideas
 */

import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import type { MemoryManager } from "../../memory/types";
import { insertIdea } from "../../sources/ideas/store";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import {
  updatePipelineRun,
  createPipelineStep,
  updatePipelineStep,
} from "../store";
import { analyzeAppLandscape, clusterReviews, scanCapabilities } from "./collectors";
import { synthesizeFromTrends, deepSearch } from "./synthesizer";
import type { GeneratedIdeaCandidate } from "./types";

const log = createLogger("pipeline:ideas");

const AGENT_ID = "idea-pipeline";

function nowMs(): number {
  return Date.now();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/postgresql:\/\/[^\s]+/gi, "[redacted]")
    .replace(/\/Users\/[^\s]+/g, "[redacted]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[redacted]")
    .slice(0, 500);
}

export interface PipelineRunResult {
  readonly runId: string;
  readonly summary: PipelineResultSummary;
}

async function runStep<T>(
  runId: string,
  stepName: string,
  work: () => Promise<T>,
  formatOutput: (result: T) => string,
): Promise<T> {
  const step = await createPipelineStep({ runId, stepName });
  const start = nowMs();
  try {
    const result = await work();
    await updatePipelineStep(step.id, {
      status: "completed",
      outputSummary: formatOutput(result),
      durationMs: nowMs() - start,
    });
    return result;
  } catch (err) {
    await updatePipelineStep(step.id, {
      status: "failed",
      error: sanitizeError(err),
      durationMs: nowMs() - start,
    });
    throw err;
  }
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "are", "was",
  "be", "has", "had", "have", "will", "can", "do", "does", "your", "you",
  "app", "tool", "platform", "system", "based", "using", "new", "smart",
]);

function tokenize(title: string): readonly string[] {
  return title.toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, "")).filter((w) => w.length >= 3);
}

function extractThemesByNgrams(titles: readonly string[]): readonly string[] {
  const bigramCounts = new Map<string, string[]>();
  const trigramCounts = new Map<string, string[]>();

  for (const title of titles) {
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

  const allNgrams: Array<{ readonly phrase: string; readonly hits: readonly string[] }> = [];

  for (const [phrase, hits] of trigramCounts) {
    const unique = [...new Set(hits)];
    if (unique.length >= 3) allNgrams.push({ phrase, hits: unique });
  }

  for (const [phrase, hits] of bigramCounts) {
    const unique = [...new Set(hits)];
    if (unique.length >= 3) allNgrams.push({ phrase, hits: unique });
  }

  allNgrams.sort((a, b) => b.hits.length - a.hits.length);

  const lines: string[] = [];
  for (const { phrase, hits } of allNgrams) {
    lines.push(`- "${phrase}" theme (${hits.length} ideas): ${hits.slice(0, 3).join(", ")}`);
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
      const results = await memoryManager.search(
        "shared",
        `${row.title}: ${row.summary}`,
        { limit: 3, minScore: 0.7, kinds: ["idea"] },
      );
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

async function buildSaturatedThemes(memoryManager?: MemoryManager | null): Promise<string> {
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
    const themeLines = extractThemesByNgrams(rows.map((r) => r.title));

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

async function semanticDedup(
  candidates: readonly GeneratedIdeaCandidate[],
  memoryManager: MemoryManager,
): Promise<{
  readonly kept: readonly GeneratedIdeaCandidate[];
  readonly rejected: readonly string[];
}> {
  const kept: GeneratedIdeaCandidate[] = [];
  const rejected: string[] = [];

  for (const candidate of candidates) {
    try {
      const results = await memoryManager.search(
        "shared",
        `${candidate.title}: ${candidate.summary}`,
        { limit: 1, minScore: 0.75, kinds: ["idea"] },
      );

      if (results.length > 0 && results[0]!.score > 0.75) {
        const existing = results[0]!.source.metadata.title ?? "unknown";
        rejected.push(`${candidate.title} (similar to "${existing}", ${results[0]!.score.toFixed(2)})`);
        continue;
      }
    } catch {
      // keep on search failure
    }
    kept.push(candidate);
  }

  return { kept, rejected };
}

export async function runIdeasPipeline(
  _pipelineId: string,
  config: PipelineConfig,
  runId: string,
  memoryManager?: MemoryManager | null,
): Promise<PipelineRunResult> {
  const startTime = nowMs();

  await updatePipelineRun(runId, {
    status: "running",
    category: config.category,
    config,
    startedAt: now(),
  });

  try {
    const model = config.model ?? "claude-sonnet-4-6";

    // ── Steps 1-3: Run collectors in parallel (no inter-dependencies) ───
    // clusterReviews accepts an optional focusCategories filter derived from
    // landscape results, but its undefined fallback is fully functional — the
    // reviews and capabilities collectors have zero dependency on each other
    // or on the landscape step, so all three can run concurrently.
    const [trends, pains, capabilities] = await Promise.all([
      runStep(
        runId,
        "landscape",
        () => analyzeAppLandscape(model),
        (t) => `${t.trendingCategories.length} underserved categories identified from ${t.summary.split("\n").length} data points${t.insights ? " (with LLM insights)" : ""}`,
      ),
      runStep(
        runId,
        "reviews",
        () => clusterReviews(undefined, model),
        (p) => `${p.clusters.length} review clusters across ${[...new Set(p.clusters.map((c) => c.category))].length} categories (complaints + praises)${p.insights ? " (with LLM insights)" : ""}`,
      ),
      runStep(
        runId,
        "capabilities",
        () => scanCapabilities(model),
        (c) => `${c.capabilities.length} capabilities from PH, HN, GitHub, Reddit, News, X${c.insights ? " (with LLM insights)" : ""}`,
      ),
    ]);

    // ── Step 4+5: Deep search + saturated themes in parallel ──────────
    const deepSearchPromise =
      memoryManager && trends.trendingCategories.length > 0
        ? runStep(
            runId,
            "deep_search",
            () =>
              deepSearch(
                trends.trendingCategories.slice(0, 6).map((c) => `${c.category} mobile app opportunity`),
                memoryManager,
              ),
            (ctx) => {
              const count = (ctx.match(/\[.*?\]/g) ?? []).length;
              return `Found ${count} supporting results for ${trends.trendingCategories.length} themes`;
            },
          )
        : Promise.resolve("");

    const [deepSearchContext, saturatedThemes] = await Promise.all([
      deepSearchPromise,
      buildSaturatedThemes(memoryManager),
    ]);

    const synthesis = await runStep(
      runId,
      "synthesis",
      () =>
        synthesizeFromTrends({
          trends,
          pains,
          capabilities,
          deepSearchContext,
          saturatedThemes,
          category: config.category,
          maxIdeas: config.maxIdeas,
          model,
        }),
      (s) => `Generated ${s.totalGenerated} idea candidates from trend intersections`,
    );

    // ── Step 6: Validate (semantic dedup) ─────────────────────────────
    let kept = synthesis.candidates;
    let semanticRejected: readonly string[] = [];

    if (memoryManager && kept.length > 0) {
      const dedupResult = await semanticDedup(kept, memoryManager);
      kept = dedupResult.kept;
      semanticRejected = dedupResult.rejected;
    }

    const qualityFiltered = kept.filter(
      (c) => c.qualityScore >= config.minQualityScore,
    );

    await runStep(
      runId,
      "validate",
      async () => ({
        kept: qualityFiltered.length,
        semanticDupes: semanticRejected.length,
        belowThreshold: kept.length - qualityFiltered.length,
      }),
      (r) => `${r.kept} kept, ${r.semanticDupes} semantic duplicates, ${r.belowThreshold} below threshold`,
    );

    // ── Step 7: Store ideas ───────────────────────────────────────────
    const ideaIds = await runStep(
      runId,
      "store",
      async () => {
        const ids: string[] = [];
        for (const candidate of qualityFiltered) {
          try {
            const sourceLinksText =
              candidate.sourceLinks?.length > 0
                ? candidate.sourceLinks
                    .map((l) => `- [${l.title}](${l.url}) (${l.source})`)
                    .join("\n")
                : "";

            const reasoning = [
              "## Trend Intersection",
              candidate.trendIntersection || "",
              "",
              "## Analysis",
              candidate.reasoning,
              "",
              "## Design & UX",
              candidate.designDescription || "Not specified.",
              "",
              "## Monetization",
              candidate.monetizationDetail || candidate.revenueModel,
              "",
              "## Details",
              `**Target Audience:** ${candidate.targetAudience}`,
              `**Key Features:** ${candidate.keyFeatures.join(", ")}`,
              ...(sourceLinksText ? ["", "## Sources", sourceLinksText] : []),
            ].join("\n");

            const idea = await insertIdea({
              agent_id: AGENT_ID,
              title: candidate.title,
              summary: candidate.summary,
              reasoning,
              sources_used: candidate.sourcesUsed,
              category: candidate.category || config.category,
              quality_score: Math.min(Math.max(candidate.qualityScore, 1), 5),
              pipeline_run_id: runId,
            });

            if (memoryManager) {
              try {
                await memoryManager.indexIdea(AGENT_ID, {
                  id: idea.id,
                  title: candidate.title,
                  summary: candidate.summary,
                  category: candidate.category || config.category,
                  reasoning: candidate.reasoning,
                });
              } catch {
                // non-fatal
              }
            }

            ids.push(idea.id);
          } catch (err) {
            log.warn("Failed to save idea", { title: candidate.title, err });
          }
        }
        return ids;
      },
      (ids) => `Stored ${ids.length} ideas`,
    );

    // ── Finalize ──────────────────────────────────────────────────────
    const summary: PipelineResultSummary = {
      totalSourcesQueried: 8,
      totalSignalsFound: trends.risingApps.length + pains.clusters.length + capabilities.capabilities.length,
      totalIdeasGenerated: synthesis.totalGenerated,
      totalIdeasKept: ideaIds.length,
      totalIdeasDuplicate: semanticRejected.length,
      topThemes: trends.trendingCategories.slice(0, 10).map((c) => c.category),
      ideaIds,
      durationMs: nowMs() - startTime,
    };

    await updatePipelineRun(runId, {
      status: "completed",
      resultSummary: summary,
      finishedAt: now(),
    });

    log.info("Pipeline run complete", {
      runId,
      ideasGenerated: synthesis.totalGenerated,
      ideasKept: ideaIds.length,
      durationMs: summary.durationMs,
    });

    return { runId, summary };
  } catch (err) {
    log.error("Pipeline run failed", { runId, error: err });
    await updatePipelineRun(runId, {
      status: "failed",
      error: sanitizeError(err),
      finishedAt: now(),
    });
    throw err;
  }
}
