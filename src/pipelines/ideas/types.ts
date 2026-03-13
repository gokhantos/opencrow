/**
 * Types specific to the idea generation pipeline.
 */

export interface CollectedData {
  readonly source: string;
  readonly itemCount: number;
  readonly summary: string;
}

export interface CollectionResult {
  readonly sources: readonly CollectedData[];
  readonly aggregatedContext: string;
  readonly totalItems: number;
}

export interface ExtractedSignal {
  readonly theme: string;
  readonly type: "pain_point" | "trend" | "gap" | "opportunity" | "emerging_tech";
  readonly description: string;
  readonly sources: readonly string[];
  readonly strength: number; // 1-5
}

export interface AnalysisResult {
  readonly signals: readonly ExtractedSignal[];
  readonly themes: readonly string[];
  readonly gaps: readonly string[];
  readonly totalSignals: number;
}

export interface SourceLink {
  readonly title: string;
  readonly url: string;
  readonly source: string;
}

export interface GeneratedIdeaCandidate {
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly designDescription: string;
  readonly monetizationDetail: string;
  readonly sourceLinks: readonly SourceLink[];
  readonly sourcesUsed: string;
  readonly category: string;
  readonly qualityScore: number;
  readonly targetAudience: string;
  readonly keyFeatures: readonly string[];
  readonly revenueModel: string;
}

export interface SynthesisResult {
  readonly candidates: readonly GeneratedIdeaCandidate[];
  readonly totalGenerated: number;
}

export interface ValidationResult {
  readonly kept: readonly GeneratedIdeaCandidate[];
  readonly duplicates: readonly string[];
  readonly totalKept: number;
  readonly totalDuplicate: number;
}
