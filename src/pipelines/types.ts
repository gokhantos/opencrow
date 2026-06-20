/**
 * Core pipeline types for the idea generation system.
 * Pipelines are multi-step processes that collect data, analyze it,
 * and produce structured output (e.g. ideas).
 */

import type { ModelProvider } from "../store/model-routing";

export type PipelineStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "interrupted";

export type IdeaCategory =
  | "mobile_app"
  | "crypto_project"
  | "ai_app"
  | "open_source"
  | "general";

export interface PipelineConfig {
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly minQualityScore: number;
  readonly sourcesToInclude: readonly string[];
  /**
   * Optional operator override for the generator MODEL. Only honored when
   * `provider` is ALSO set (the two must travel together — a model is only valid
   * for its own provider). When either is absent the `pipeline.generator` route
   * supplies BOTH. Left unset by default so the dashboard route is authoritative.
   */
  readonly model?: string;
  /**
   * Optional operator override for the generator PROVIDER. Only honored when
   * `model` is ALSO set; otherwise the route's provider (and model) are used.
   */
  readonly provider?: ModelProvider;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  category: "mobile_app",
  maxIdeas: 5,
  minQualityScore: 2.5,
  sourcesToInclude: [
    "appstore",
    "playstore",
    "producthunt",
    "hackernews",
    "reddit",
    "github",
    "news",
    "x",
  ],
  // No hardcoded model/provider: the `pipeline.generator` model route
  // (dashboard-controlled) is the source of truth. Setting only `model` here
  // would mismatch the route's provider and break non-Anthropic routes.
};

export interface PipelineRun {
  readonly id: string;
  readonly pipelineId: string;
  readonly status: PipelineStatus;
  readonly category: IdeaCategory;
  readonly config: PipelineConfig;
  readonly resultSummary: PipelineResultSummary | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
}

export interface PipelineStep {
  readonly id: string;
  readonly runId: string;
  readonly stepName: string;
  readonly status: StepStatus;
  readonly inputSummary: string | null;
  readonly outputSummary: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Last liveness tick (epoch seconds) while the step is 'running'; null once finished. */
  readonly lastHeartbeat: number | null;
}

export interface PipelineResultSummary {
  readonly totalSourcesQueried: number;
  readonly totalSignalsFound: number;
  readonly totalIdeasGenerated: number;
  readonly totalIdeasKept: number;
  readonly totalIdeasDuplicate: number;
  readonly topThemes: readonly string[];
  readonly ideaIds: readonly string[];
  readonly durationMs: number;
  // ── Within-run diversity (optional; populated when the diversity guard runs).
  // Backward-compatible JSONB additions — querying monoculture per run. ─────────
  /** Largest archetype bucket in the kept set. */
  readonly dominantArchetype?: string;
  /** Fraction (0..1) of kept ideas in the dominant archetype. */
  readonly dominantArchetypeShare?: number;
  /** Shannon entropy (BITS) over the kept set's archetype distribution. */
  readonly archetypeEntropy?: number;
}

export interface PipelineDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: IdeaCategory;
  readonly defaultConfig: PipelineConfig;
}

export const PIPELINE_DEFINITIONS: readonly PipelineDefinition[] = [
  {
    id: "mobile-app-ideas",
    name: "Mobile App Ideas",
    description:
      "Analyzes App Store/Play Store complaints, Product Hunt launches, HN discussions, Reddit posts, GitHub trends, news, and X/Twitter to generate mobile app ideas.",
    category: "mobile_app",
    defaultConfig: DEFAULT_PIPELINE_CONFIG,
  },
  {
    id: "ai-app-ideas",
    name: "AI App Ideas",
    description:
      "Focuses on AI/ML trends from GitHub, HN, Product Hunt, and news to generate AI application ideas.",
    category: "ai_app",
    defaultConfig: {
      ...DEFAULT_PIPELINE_CONFIG,
      category: "ai_app",
    },
  },
  {
    id: "crypto-project-ideas",
    name: "Crypto Project Ideas",
    description:
      "Analyzes crypto news, market data, GitHub trends, and X/Twitter for blockchain/crypto project ideas.",
    category: "crypto_project",
    defaultConfig: {
      ...DEFAULT_PIPELINE_CONFIG,
      category: "crypto_project",
    },
  },
  {
    id: "open-source-ideas",
    name: "Open Source Ideas",
    description:
      "Analyzes GitHub trends, HN discussions, and Reddit for open source project ideas.",
    category: "open_source",
    defaultConfig: {
      ...DEFAULT_PIPELINE_CONFIG,
      category: "open_source",
    },
  },
];
