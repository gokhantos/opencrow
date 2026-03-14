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

async function buildSaturatedThemes(): Promise<string> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT title FROM generated_ideas
      WHERE pipeline_run_id IS NOT NULL
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
      ORDER BY created_at DESC
      LIMIT 500
    `) as Array<{ title: string }>;

    if (rows.length === 0) return "";

    const keywords: Record<string, string[]> = {};
    for (const row of rows) {
      const words = row.title.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length < 4) continue;
        if (["mobile", "open", "source", "protocol", "smart", "data", "apps"].includes(word)) continue;
        const list = keywords[word] ?? [];
        list.push(row.title);
        keywords[word] = list;
      }
    }

    const saturated: string[] = [];
    const sorted = Object.entries(keywords)
      .filter(([, titles]) => [...new Set(titles)].length >= 3)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [keyword, titles] of sorted) {
      const unique = [...new Set(titles)];
      saturated.push(`- "${keyword}" (${unique.length} ideas): ${unique.slice(0, 3).join(", ")}`);
      if (saturated.length >= 10) break;
    }

    return saturated.join("\n");
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
    const model = config.model ?? "claude-sonnet-4-5";

    // ── Step 1: Analyze app landscape ───────────────────────────────────
    const trends = await runStep(
      runId,
      "landscape",
      () => analyzeAppLandscape(),
      (t) => `${t.trendingCategories.length} underserved categories identified from ${t.summary.split("\n").length} data points`,
    );

    // ── Step 2: Cluster reviews (complaints + praises) ────────────────
    const focusCategories = trends.trendingCategories.length > 0
      ? trends.trendingCategories.map((c) => c.category)
      : undefined;

    const pains = await runStep(
      runId,
      "reviews",
      () => clusterReviews(focusCategories),
      (p) => `${p.clusters.length} review clusters across ${[...new Set(p.clusters.map((c) => c.category))].length} categories (complaints + praises)`,
    );

    // ── Step 3: Scan capabilities ─────────────────────────────────────
    const capabilities = await runStep(
      runId,
      "capabilities",
      () => scanCapabilities(),
      (c) => `${c.capabilities.length} capabilities from PH, HN, GitHub, Reddit, News, X`,
    );

    // ── Step 4: Deep search (optional) ────────────────────────────────
    let deepSearchContext = "";
    if (memoryManager && trends.trendingCategories.length > 0) {
      const searchThemes = trends.trendingCategories
        .slice(0, 6)
        .map((c) => `${c.category} mobile app opportunity`);

      deepSearchContext = await runStep(
        runId,
        "deep_search",
        () => deepSearch(searchThemes, memoryManager),
        (ctx) => {
          const count = (ctx.match(/\[.*?\]/g) ?? []).length;
          return `Found ${count} supporting results for ${searchThemes.length} themes`;
        },
      );
    }

    // ── Step 5: Synthesize ideas at trend intersections ───────────────
    const saturatedThemes = await buildSaturatedThemes();

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
