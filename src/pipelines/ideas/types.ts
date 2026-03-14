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

export interface TrendData {
  readonly risingApps: readonly TrendingApp[];
  readonly trendingCategories: readonly CategoryTrend[];
  readonly summary: string;
}

// ── Pain Point Clustering ───────────────────────────────────────────────

export interface PainCluster {
  readonly category: string;
  readonly theme: string;
  readonly complaintCount: number;
  readonly sampleComplaints: readonly string[];
  readonly affectedApps: readonly string[];
}

export interface ClusteredPains {
  readonly clusters: readonly PainCluster[];
  readonly summary: string;
}

// ── Capability Scan ─────────────────────────────────────────────────────

export interface Capability {
  readonly title: string;
  readonly source: string; // hackernews, producthunt, github, news
  readonly url: string;
  readonly description: string;
  readonly type: "new_tech" | "funding" | "regulation" | "behavior_shift" | "open_source";
}

export interface CapabilityScan {
  readonly capabilities: readonly Capability[];
  readonly summary: string;
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
