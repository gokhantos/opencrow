/**
 * Types for the trend-intersection idea pipeline.
 */

// ── Trend Detection ─────────────────────────────────────────────────────

export interface TrendingApp {
  readonly name: string;
  readonly category: string;
  readonly rank: number;
  readonly rankChange: number; // positive = moved up
  readonly listType: string;
  readonly store: "appstore" | "playstore";
}

export interface CategoryTrend {
  readonly category: string;
  readonly store: "appstore" | "playstore";
  readonly newEntrants: number; // apps that entered top charts recently
  readonly avgRankChange: number; // positive = category moving up
  readonly topApps: readonly string[];
}

// ── Landscape Insights ──────────────────────────────────────────────────

export interface UnderservedSegment {
  readonly category: string;
  readonly gap: string;
  readonly evidence: string;
}

export interface WorkingPattern {
  readonly pattern: string;
  readonly evidence: string;
  readonly categories: readonly string[];
}

export interface WhiteSpace {
  readonly description: string;
  readonly adjacentCategories: readonly string[];
  readonly reason: string;
}

export interface LandscapeInsight {
  readonly underservedSegments: readonly UnderservedSegment[];
  readonly workingPatterns: readonly WorkingPattern[];
  readonly whiteSpaces: readonly WhiteSpace[];
}

export interface TrendData {
  readonly risingApps: readonly TrendingApp[];
  readonly trendingCategories: readonly CategoryTrend[];
  readonly summary: string;
  readonly insights?: LandscapeInsight;
}

// ── Pain Point Clustering ───────────────────────────────────────────────

export interface PainCluster {
  readonly category: string;
  readonly theme: string;
  readonly complaintCount: number;
  readonly sampleComplaints: readonly string[];
  readonly affectedApps: readonly string[];
}

// ── Review Insights ─────────────────────────────────────────────────────

export interface PainTheme {
  readonly name: string;
  readonly description: string;
  readonly frequency: "very_common" | "common" | "emerging";
  readonly affectedApps: readonly string[];
  readonly sampleQuotes: readonly string[];
}

export interface WorkaroundSignal {
  readonly description: string;
  readonly currentSolution: string;
  readonly evidence: string;
}

export interface LoveSignal {
  readonly feature: string;
  readonly whyUsersLoveIt: string;
  readonly category: string;
}

export interface ReviewInsight {
  readonly painThemes: readonly PainTheme[];
  readonly workaroundSignals: readonly WorkaroundSignal[];
  readonly loveSignals: readonly LoveSignal[];
}

export interface ClusteredPains {
  readonly clusters: readonly PainCluster[];
  readonly summary: string;
  readonly insights?: ReviewInsight;
}

// ── Capability Scan ─────────────────────────────────────────────────────

export interface Capability {
  readonly title: string;
  readonly source: string; // hackernews, producthunt, github, news
  readonly url: string;
  readonly description: string;
  readonly type: "new_tech" | "funding" | "regulation" | "behavior_shift" | "open_source";
}

// ── Capability Insights ─────────────────────────────────────────────────

export interface ClassifiedCapability {
  readonly title: string;
  readonly source: string;
  readonly classification: "breakthrough" | "enabler" | "incremental";
  readonly whyNew: string;
}

export interface TechnologyWave {
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly implication: string;
}

export interface PainCapabilityLink {
  readonly painTheme: string;
  readonly capability: string;
  readonly connectionReason: string;
}

export interface CapabilityInsight {
  readonly genuinelyNew: readonly ClassifiedCapability[];
  readonly technologyWaves: readonly TechnologyWave[];
  readonly painCapabilityLinks: readonly PainCapabilityLink[];
}

export interface CapabilityScan {
  readonly capabilities: readonly Capability[];
  readonly summary: string;
  readonly insights?: CapabilityInsight;
}

// ── Intersection Hypothesis ─────────────────────────────────────────────

export interface IntersectionHypothesis {
  readonly title: string;
  readonly painSignal: string;
  readonly capabilitySignal: string;
  readonly marketSignal: string;
  readonly hypothesis: string;
  readonly signalStrength: number;
}

// ── Idea Generation ─────────────────────────────────────────────────────

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
  readonly trendIntersection: string; // the trend + pain + capability intersection
}

export interface SynthesisResult {
  readonly candidates: readonly GeneratedIdeaCandidate[];
  readonly totalGenerated: number;
}
