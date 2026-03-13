/**
 * Mobile App Ideas Pipeline - the main orchestrator.
 *
 * Steps:
 * 1. Collect data from all sources in parallel
 * 2. AI-powered signal extraction & cross-reference analysis
 * 3. Idea generation from opportunity clusters
 * 4. Validation & deduplication against existing ideas
 * 5. Storage & indexing
 */

import { createLogger } from "../../logger";
import { insertIdea, getRecentIdeaTitles } from "../../sources/ideas/store";
import type { PipelineConfig, PipelineResultSummary } from "../types";
import {
  updatePipelineRun,
  createPipelineStep,
  updatePipelineStep,
} from "../store";
import { collectAll } from "./collectors";
import { synthesize } from "./synthesizer";
import type { GeneratedIdeaCandidate } from "./types";

const log = createLogger("pipeline:ideas");

const AGENT_ID = "idea-pipeline";

function nowMs(): number {
  return Date.now();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Sanitize error messages before storing in DB to prevent leaking internals. */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip connection strings, file paths, and API keys
  return raw
    .replace(/postgresql:\/\/[^\s]+/gi, "[redacted-connection-string]")
    .replace(/\/Users\/[^\s]+/g, "[redacted-path]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[redacted-key]")
    .replace(/Bearer [a-zA-Z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 500);
}

/**
 * Deduplicate candidates against existing idea titles using simple string similarity.
 */
function deduplicateCandidates(
  candidates: readonly GeneratedIdeaCandidate[],
  existingTitles: readonly string[],
): {
  readonly kept: readonly GeneratedIdeaCandidate[];
  readonly duplicateTitles: readonly string[];
} {
  const existingLower = new Set(existingTitles.map((t) => t.toLowerCase()));
  const kept: GeneratedIdeaCandidate[] = [];
  const duplicateTitles: string[] = [];
  const seenInBatch = new Set<string>();

  for (const candidate of candidates) {
    const titleLower = candidate.title.toLowerCase();

    if (existingLower.has(titleLower) || seenInBatch.has(titleLower)) {
      duplicateTitles.push(candidate.title);
      continue;
    }

    const isDuplicate = [...existingLower].some((existing) => {
      const shorter =
        titleLower.length < existing.length ? titleLower : existing;
      const longer =
        titleLower.length < existing.length ? existing : titleLower;
      return longer.includes(shorter) && shorter.length / longer.length > 0.7;
    });

    if (isDuplicate) {
      duplicateTitles.push(candidate.title);
      continue;
    }

    seenInBatch.add(titleLower);
    kept.push(candidate);
  }

  return { kept, duplicateTitles };
}

export interface PipelineRunResult {
  readonly runId: string;
  readonly summary: PipelineResultSummary;
}

/**
 * Execute the full idea generation pipeline.
 * @param runId - Pre-created run ID from the atomic lock
 */
export async function runIdeasPipeline(
  _pipelineId: string,
  config: PipelineConfig,
  runId: string,
): Promise<PipelineRunResult> {
  const startTime = nowMs();

  // Update the pre-created run with actual config
  await updatePipelineRun(runId, {
    status: "running",
    category: config.category,
    config,
    startedAt: now(),
  });

  try {
    // ── Step 1: Collect data ──────────────────────────────────────────
    const collectStep = await createPipelineStep({
      runId,
      stepName: "collect",
    });
    const collectStart = nowMs();

    const collectionResult = await collectAll(config.sourcesToInclude);

    const activeSourceNames = collectionResult.sources
      .filter((s) => s.itemCount > 0)
      .map((s) => `${s.source}: ${s.itemCount} items`);

    await updatePipelineStep(collectStep.id, {
      status: "completed",
      outputSummary: `Collected from ${activeSourceNames.length} sources: ${activeSourceNames.join(", ")}`,
      durationMs: nowMs() - collectStart,
    });

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

    // ── Step 2: AI Synthesis (signal extraction + analysis + generation)
    const synthesizeStep = await createPipelineStep({
      runId,
      stepName: "synthesize",
    });
    const synthesizeStart = nowMs();

    const existingIdeas = await getRecentIdeaTitles(AGENT_ID, 100);
    const existingTitles = existingIdeas.map((i) => i.title);

    const model = config.model ?? "claude-sonnet-4-5";
    const synthOutput = await synthesize({
      aggregatedContext: collectionResult.aggregatedContext,
      category: config.category,
      maxIdeas: config.maxIdeas,
      existingTitles,
      model,
    });

    await updatePipelineStep(synthesizeStep.id, {
      status: "completed",
      outputSummary: `${synthOutput.signalCount} signals, ${synthOutput.themeCount} themes, ${synthOutput.synthesis.totalGenerated} ideas generated`,
      durationMs: nowMs() - synthesizeStart,
    });

    // ── Step 3: Validate & Deduplicate ────────────────────────────────
    const validateStep = await createPipelineStep({
      runId,
      stepName: "validate",
    });
    const validateStart = nowMs();

    const { kept, duplicateTitles } = deduplicateCandidates(
      synthOutput.synthesis.candidates,
      existingTitles,
    );

    const qualityFiltered = kept.filter(
      (c) => c.qualityScore >= config.minQualityScore,
    );

    await updatePipelineStep(validateStep.id, {
      status: "completed",
      outputSummary: `${qualityFiltered.length} kept, ${duplicateTitles.length} duplicates removed, ${kept.length - qualityFiltered.length} below quality threshold`,
      durationMs: nowMs() - validateStart,
    });

    // ── Step 4: Store ideas ───────────────────────────────────────────
    const storeStep = await createPipelineStep({
      runId,
      stepName: "store",
    });
    const storeStart = nowMs();
    const ideaIds: string[] = [];

    for (const candidate of qualityFiltered) {
      try {
        // Format source links as markdown
        const sourceLinksText =
          candidate.sourceLinks?.length > 0
            ? candidate.sourceLinks
                .map(
                  (link) =>
                    `- [${link.title}](${link.url}) (${link.source})`,
                )
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
          ...(sourceLinksText
            ? ["", "## Sources", sourceLinksText]
            : []),
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

        ideaIds.push(idea.id);
      } catch (err) {
        log.warn("Failed to save idea", {
          title: candidate.title,
          err,
        });
      }
    }

    await updatePipelineStep(storeStep.id, {
      status: "completed",
      outputSummary: `Stored ${ideaIds.length} ideas`,
      durationMs: nowMs() - storeStart,
    });

    // ── Finalize ──────────────────────────────────────────────────────
    const summary: PipelineResultSummary = {
      totalSourcesQueried: config.sourcesToInclude.length,
      totalSignalsFound: synthOutput.signalCount,
      totalIdeasGenerated: synthOutput.synthesis.totalGenerated,
      totalIdeasKept: ideaIds.length,
      totalIdeasDuplicate: duplicateTitles.length,
      topThemes: synthOutput.analysis.themes.slice(0, 10),
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
      ideasGenerated: synthOutput.synthesis.totalGenerated,
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
