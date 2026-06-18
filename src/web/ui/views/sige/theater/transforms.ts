/**
 * Pure data transforms for the SIGE Process Theater.
 *
 * All functions tolerate null/undefined/empty input and return empty results
 * rather than throwing. No React or DOM dependencies — unit-testable in Node.
 */
import type { Node, Edge } from "@xyflow/react";
import type {
  ExpertGameResult,
  SimulationRound,
  ScoredIdea,
  Coalition,
  Equilibrium,
  SocialSimResult,
  FusedScore,
  CitizenActionType,
} from "../types";
import type { GraphView, GraphNode, GraphEdge } from "../../../../../sige/knowledge/graph-query";

// ─── React Flow Node data shapes ──────────────────────────────────────────────

export interface KgNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly entityType: string;
  readonly summary: string | undefined;
}

export interface KgEdgeData extends Record<string, unknown> {
  readonly label: string;
  readonly fact: string;
}

// ─── graphViewToFlow ──────────────────────────────────────────────────────────

/**
 * Converts a GraphView into React Flow Node[] and Edge[].
 *
 * Layout: simple grid — nodes are placed in rows of up to COLUMNS per row,
 * evenly spaced. React Flow auto-layout libraries (dagre, elk) are not bundled
 * here to keep the dependency surface small; the KnowledgeGraphStage component
 * can call fitView() to reposition once mounted.
 *
 * Tolerates empty/null input: returns { nodes: [], edges: [] }.
 */
export function graphViewToFlow(
  view: GraphView | null | undefined,
): { readonly nodes: Node<KgNodeData>[]; readonly edges: Edge<KgEdgeData>[] } {
  if (!view || view.nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const COLUMNS = 5;
  const H_SPACING = 200;
  const V_SPACING = 120;

  const nodes: Node<KgNodeData>[] = view.nodes.map((gn: GraphNode, i: number) => {
    const col = i % COLUMNS;
    const row = Math.floor(i / COLUMNS);
    return {
      id: gn.uuid,
      type: "default",
      position: { x: col * H_SPACING, y: row * V_SPACING },
      data: {
        label: gn.name,
        entityType: gn.entityType,
        summary: gn.summary,
      },
    };
  });

  const nodeIds = new Set(view.nodes.map((n: GraphNode) => n.uuid));

  const edges: Edge<KgEdgeData>[] = view.edges
    .filter(
      (ge: GraphEdge) =>
        nodeIds.has(ge.sourceNodeUuid) && nodeIds.has(ge.targetNodeUuid),
    )
    .map((ge: GraphEdge) => ({
      id: ge.uuid,
      source: ge.sourceNodeUuid,
      target: ge.targetNodeUuid,
      label: ge.relationType,
      data: {
        label: ge.relationType,
        fact: ge.fact,
      },
    }));

  return { nodes, edges };
}

// ─── expertResultToFrames ─────────────────────────────────────────────────────

export interface RoundFrame {
  readonly roundNumber: number;
  readonly roundType: string;
  readonly selectedIdeas: readonly ScoredIdea[];
  readonly eliminatedIdeas: readonly string[];
  readonly coalitions: readonly Coalition[];
  readonly equilibria: readonly Equilibrium[];
  /** IDs of ideas that are selected in this round (for highlight logic). */
  readonly selectedIdeaIds: ReadonlySet<string>;
  /** IDs of ideas that are eliminated in this round (for fade-out logic). */
  readonly eliminatedIdeaIds: ReadonlySet<string>;
}

/**
 * Converts ExpertGameResult into an ordered list of round frames for the
 * client-side replay scrubber.
 *
 * Tolerates null/undefined/empty input: returns [].
 */
export function expertResultToFrames(
  result: ExpertGameResult | null | undefined,
): readonly RoundFrame[] {
  if (!result || !result.rounds || result.rounds.length === 0) return [];

  return [...result.rounds]
    .sort((a: SimulationRound, b: SimulationRound) => a.roundNumber - b.roundNumber)
    .map((round: SimulationRound): RoundFrame => {
      const selectedIdeas = round.outcomes.selectedIdeas ?? [];
      const eliminatedIdeas = round.outcomes.eliminatedIdeas ?? [];
      const coalitions = round.outcomes.coalitions ?? [];
      const equilibria = round.outcomes.equilibria ?? [];

      return {
        roundNumber: round.roundNumber,
        roundType: round.roundType,
        selectedIdeas,
        eliminatedIdeas,
        coalitions,
        equilibria,
        selectedIdeaIds: new Set(selectedIdeas.map((idea: ScoredIdea) => idea.id)),
        eliminatedIdeaIds: new Set(eliminatedIdeas),
      };
    });
}

// ─── socialResultToGrid ───────────────────────────────────────────────────────

export interface CitizenCell {
  readonly citizenId: string;
  readonly actionType: CitizenActionType;
  readonly targetIdeaId: string;
  readonly sentiment: number;
}

export interface AdoptionSeries {
  readonly ideaId: string;
  readonly rate: number;
}

export interface SentimentSeries {
  readonly label: string;
  readonly value: number;
}

export interface SocialGrid {
  /** All citizen actions bucketed by actionType for coloring. */
  readonly cells: readonly CitizenCell[];
  /** Per-bucket counts, keyed by actionType. */
  readonly byActionType: Readonly<Record<string, readonly CitizenCell[]>>;
  /** Adoption rate per idea, sorted descending. */
  readonly adoptionSeries: readonly AdoptionSeries[];
  /** Sentiment distribution as name/value pairs. */
  readonly sentimentSeries: readonly SentimentSeries[];
}

const ACTION_TYPES: readonly CitizenActionType[] = [
  "adopt",
  "resist",
  "remix",
  "combine",
  "oppose",
  "ignore",
];

/**
 * Converts SocialSimResult into a grid/series shape for the SocialSimStage.
 * Tolerates null/undefined/empty input: returns empty grid.
 */
export function socialResultToGrid(
  result: SocialSimResult | null | undefined,
): SocialGrid {
  if (!result) {
    return {
      cells: [],
      byActionType: {},
      adoptionSeries: [],
      sentimentSeries: [],
    };
  }

  const cells: CitizenCell[] = result.citizenActions.map((a) => ({
    citizenId: a.citizenId,
    actionType: a.actionType,
    targetIdeaId: a.targetIdeaId,
    sentiment: a.sentiment,
  }));

  const byActionType: Record<string, CitizenCell[]> = {};
  for (const type of ACTION_TYPES) {
    byActionType[type] = [];
  }
  for (const cell of cells) {
    const bucket = byActionType[cell.actionType];
    if (bucket) {
      bucket.push(cell);
    }
  }

  const adoptionSeries: AdoptionSeries[] = Object.entries(result.adoptionRates)
    .map(([ideaId, rate]) => ({ ideaId, rate }))
    .sort((a, b) => b.rate - a.rate);

  const sentimentSeries: SentimentSeries[] = Object.entries(
    result.sentimentDistribution,
  ).map(([label, value]) => ({ label, value }));

  return { cells, byActionType, adoptionSeries, sentimentSeries };
}

// ─── fusedScoresToChart ───────────────────────────────────────────────────────

export interface ChartIdea {
  readonly ideaId: string;
  readonly label: string;
  readonly expertScore: number;
  readonly socialScore: number;
  readonly fusedScore: number;
}

export interface DivergingChartData {
  /** Ideas sorted by fusedScore descending (capped at TOP_N). */
  readonly ideas: readonly ChartIdea[];
  /** Expert scores series (positive axis). */
  readonly expertSeries: readonly number[];
  /** Social scores series (positive axis). */
  readonly socialSeries: readonly number[];
  /** Fused scores for ranking reference. */
  readonly fusedSeries: readonly number[];
  /** Y-axis labels. */
  readonly labels: readonly string[];
}

const TOP_N = 20;

/**
 * Converts FusedScore[] into diverging bar chart data for ScoredIdeasStage.
 * Sorted by fusedScore desc, capped at TOP_N. Tolerates empty input.
 */
export function fusedScoresToChart(
  scores: readonly FusedScore[] | null | undefined,
): DivergingChartData {
  if (!scores || scores.length === 0) {
    return {
      ideas: [],
      expertSeries: [],
      socialSeries: [],
      fusedSeries: [],
      labels: [],
    };
  }

  const sorted = [...scores]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, TOP_N);

  const ideas: ChartIdea[] = sorted.map((s) => ({
    ideaId: s.ideaId,
    label: s.ideaId.slice(0, 8),
    expertScore: s.expertScore,
    socialScore: s.socialScore,
    fusedScore: s.fusedScore,
  }));

  return {
    ideas,
    expertSeries: ideas.map((i) => i.expertScore),
    socialSeries: ideas.map((i) => i.socialScore),
    fusedSeries: ideas.map((i) => i.fusedScore),
    labels: ideas.map((i) => i.label),
  };
}
