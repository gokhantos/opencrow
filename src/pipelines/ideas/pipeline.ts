/**
 * Mobile App Ideas Pipeline - the main orchestrator.
 *
 * Steps tracked in UI:
 * 1. collect — Data collection (randomized sampling)
 * 2. signals — AI Pass 1: Extract signals
 * 3. deep_search — Semantic search across Qdrant corpus
 * 4. analysis — AI Pass 2: Cross-reference signals
 * 5. generation — AI Pass 3: Generate ideas (with saturated theme awareness)
 * 6. validate — Semantic dedup via Qdrant + quality filter
 * 7. store — Save ideas to DB
 */

import { createLogger } from "../../logger";
import type { MemoryManager } from "../../memory/types";
import { getDb } from "../../store/db";
import { insertIdea } from "../../sources/ideas/store";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import {
  updatePipelineRun,
  createPipelineStep,
  updatePipelineStep,
} from "../store";
import { collectAll } from "./collectors";
import {
  extractSignals,
  deepSearch,
  analyzeSignals,
  generateIdeas,
} from "./synthesizer";
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
    .replace(/postgresql:\/\/[^\s]+/gi, "[redacted-connection-string]")
    .replace(/\/Users\/[^\s]+/g, "[redacted-path]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[redacted-key]")
    .replace(/Bearer [a-zA-Z0-9._-]+/gi, "Bearer [redacted]")
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

/**
 * Build a compact theme summary from existing ideas.
 * Groups by keyword patterns to produce ~10 lines max.
 */
async function buildSaturatedThemes(): Promise<string> {
  try {
    const db = getDb();
    // Get all existing pipeline idea titles
    const rows = (await db`
      SELECT title, category FROM generated_ideas
      WHERE pipeline_run_id IS NOT NULL
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
      ORDER BY created_at DESC
      LIMIT 500
    `) as Array<{ title: string; category: string }>;

    if (rows.length === 0) return "";

    // Group by common keywords to detect saturated themes
    const keywords: Record<string, string[]> = {};
    for (const row of rows) {
      const words = row.title.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (word.length < 4) continue; // skip short words
        if (!keywords[word]) keywords[word] = [];
        keywords[word]!.push(row.title);
      }
    }

    // Find themes with 3+ ideas
    const saturated: string[] = [];
    const seen = new Set<string>();
    const sorted = Object.entries(keywords)
      .filter(([, titles]) => titles.length >= 3)
      .sort((a, b) => b[1].length - a[1].length);

    for (const [keyword, titles] of sorted) {
      if (seen.has(keyword)) continue;
      // Skip generic words
      if (["mobile", "open", "source", "protocol", "smart", "data", "apps"].includes(keyword)) continue;

      const uniqueTitles = [...new Set(titles)];
      if (uniqueTitles.length >= 3) {
        saturated.push(
          `- "${keyword}" theme (${uniqueTitles.length} ideas): ${uniqueTitles.slice(0, 4).join(", ")}`,
        );
        seen.add(keyword);
      }
      if (saturated.length >= 12) break;
    }

    if (saturated.length === 0) return "";

    return saturated.join("\n");
  } catch (err) {
    log.warn("Failed to build saturated themes", { err });
    return "";
  }
}

/**
 * Semantic dedup: check each candidate against Qdrant.
 * Returns only candidates that are sufficiently novel.
 */
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
      const query = `${candidate.title}: ${candidate.summary}`;
      const results = await memoryManager.search("shared", query, {
        limit: 1,
        minScore: 0.75,
        kinds: ["idea"],
      });

      if (results.length > 0 && results[0]!.score > 0.75) {
        const existingTitle = results[0]!.source.metadata.title ?? "unknown";
        rejected.push(
          `${candidate.title} (too similar to "${existingTitle}", score: ${results[0]!.score.toFixed(2)})`,
        );
        continue;
      }
    } catch {
      // If search fails, keep the candidate
    }

    kept.push(candidate);
  }

  return { kept, rejected };
}

/**
 * Execute the full idea generation pipeline.
 */
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
    // ── Step 1: Collect data (randomized sampling) ────────────────────
    const collectionResult = await runStep(
      runId,
      "collect",
      () => collectAll(config.sourcesToInclude),
      (r) => {
        const active = r.sources
          .filter((s) => s.itemCount > 0)
          .map((s) => `${s.source}: ${s.itemCount}`);
        return `Collected from ${active.length} sources: ${active.join(", ")}`;
      },
    );

    if (collectionResult.totalItems === 0) {
      const summary: PipelineResultSummary = {
        totalSourcesQueried: config.sourcesToInclude.length,
        totalSignalsFound: 0,
        totalIdeasGenerated: 0,
        totalIdeasKept: 0,
        totalIdeasDuplicate: 0,
        topThemes: [],
        ideaIds: [],
        durationMs: nowMs() - startTime,
      };
      await updatePipelineRun(runId, {
        status: "completed",
        resultSummary: summary,
        finishedAt: now(),
      });
      return { runId, summary };
    }

    const model = config.model ?? "claude-sonnet-4-5";

    // ── Step 2: Extract signals (AI Pass 1) ───────────────────────────
    const signals = await runStep(
      runId,
      "signals",
      () => extractSignals(collectionResult.aggregatedContext, config.category, model),
      (s) => `Extracted ${s.length} signals from collected data`,
    );

    // ── Step 3: Deep semantic search ──────────────────────────────────
    let deepSearchContext = "";
    if (memoryManager && signals.length > 0) {
      deepSearchContext = await runStep(
        runId,
        "deep_search",
        () => deepSearch(signals, memoryManager),
        (ctx) => {
          const count = (ctx.match(/\[.*?, relevance:/g) ?? []).length;
          return `Found ${count} results across indexed corpus for ${Math.min(signals.length, 8)} themes`;
        },
      );
    }

    // ── Step 4: Cross-reference analysis (AI Pass 2) ──────────────────
    const analysis = await runStep(
      runId,
      "analysis",
      () => analyzeSignals(signals, config.category, model, deepSearchContext || undefined),
      (a) => `${a.themes?.length ?? 0} themes, ${a.gaps?.length ?? 0} gaps identified`,
    );

    // ── Step 5: Generate ideas (AI Pass 3) ────────────────────────────
    // Build compact saturated theme summary instead of listing all titles
    const saturatedThemes = await buildSaturatedThemes();

    const synthesis = await runStep(
      runId,
      "generation",
      () => generateIdeas(analysis, config.category, config.maxIdeas, saturatedThemes, model),
      (s) => `Generated ${s.totalGenerated} idea candidates`,
    );

    // ── Step 6: Validate (semantic dedup + quality filter) ────────────
    let kept = synthesis.candidates;
    let semanticRejected: readonly string[] = [];

    // Semantic dedup via Qdrant if available
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
        rejected: semanticRejected,
      }),
      (r) =>
        `${r.kept} kept, ${r.semanticDupes} semantic duplicates rejected, ${r.belowThreshold} below quality${r.rejected.length > 0 ? `. Rejected: ${r.rejected.join("; ")}` : ""}`,
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
                    .map((link) => `- [${link.title}](${link.url}) (${link.source})`)
                    .join("\n")
                : "";

            const reasoning = [
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

            // Index in Qdrant for future semantic dedup
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
      totalSourcesQueried: config.sourcesToInclude.length,
      totalSignalsFound: signals.length,
      totalIdeasGenerated: synthesis.totalGenerated,
      totalIdeasKept: ideaIds.length,
      totalIdeasDuplicate: semanticRejected.length,
      topThemes: analysis.themes?.slice(0, 10) ?? [],
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
      semanticDupes: semanticRejected.length,
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
