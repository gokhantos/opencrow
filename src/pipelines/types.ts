/**
 * Core pipeline types for the idea generation system.
 * Pipelines are multi-step processes that collect data, analyze it,
 * and produce structured output (e.g. ideas).
 */

export type PipelineStatus = "pending" | "running" | "completed" | "failed";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

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
  readonly model?: string;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  category: "mobile_app",
  maxIdeas: 10,
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
  model: "claude-sonnet-4-5",
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
