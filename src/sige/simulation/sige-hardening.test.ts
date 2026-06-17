import { describe, expect, it } from "bun:test"
import {
  computeDissentByTitle,
  synthesizeFallbackSeed,
  buildEvidenceRefByTitle,
  type CandidateIdea,
} from "./expert-game"
import type {
  AgentAction,
  ScoredIdea,
  SimulationRound,
  StrategicAgentRole,
} from "../types"

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeAction(params: {
  readonly role: StrategicAgentRole
  readonly content: string
  readonly round?: number
}): AgentAction {
  return {
    agentId: `${params.role}:session`,
    role: params.role,
    round: params.round ?? 2,
    actionType: "strategic_interaction",
    content: params.content,
    confidence: 0.6,
    targetIdeas: [],
    reasoning: "",
  }
}

function round(actions: readonly AgentAction[]): SimulationRound {
  return {
    roundNumber: 2,
    roundType: "strategic_interaction",
    agentActions: actions,
    outcomes: { selectedIdeas: [], eliminatedIdeas: [] },
  }
}

function evalContent(
  evaluations: readonly { ideaId: string; score: number }[],
): string {
  return JSON.stringify({ evaluations })
}

function makeScoredIdea(title: string, description = ""): ScoredIdea {
  return {
    id: crypto.randomUUID(),
    title,
    description,
    proposedBy: "external:candidate",
    round: 1,
    expertScore: 0.5,
    incentiveBreakdown: {
      diversityBonus: 0,
      buildingBonus: 0,
      surpriseBonus: 0,
      accuracyPenalty: 0,
      memoryReward: 0,
      coalitionStability: 0,
      signalCredibility: 0,
      socialViability: 0,
    },
    strategicMetadata: {
      paretoOptimal: false,
      dominantStrategy: false,
      evolutionarilyStable: false,
      nashEquilibrium: false,
    },
  }
}

// ── computeDissentByTitle ────────────────────────────────────────────────────

describe("computeDissentByTitle", () => {
  it("surfaces red-team / contrarian divergence as first-class dissent", () => {
    // Consensus loves it (0.9); the red team & contrarian hate it (0.1).
    const r = round([
      makeAction({
        role: "rational_player",
        content: evalContent([{ ideaId: "Idea A", score: 0.9 }]),
      }),
      makeAction({
        role: "founder",
        content: evalContent([{ ideaId: "Idea A", score: 0.9 }]),
      }),
      makeAction({
        role: "adversarial",
        content: evalContent([{ ideaId: "Idea A", score: 0.1 }]),
      }),
      makeAction({
        role: "contrarian_investor",
        content: evalContent([{ ideaId: "Idea A", score: 0.1 }]),
      }),
    ])
    const dissent = computeDissentByTitle([r])
    // |mean(dissenters=0.1) - mean(consensus=0.9)| = 0.8
    expect(dissent.get("idea a")).toBeCloseTo(0.8, 5)
  })

  it("returns ~0 when dissenters agree with the consensus", () => {
    const r = round([
      makeAction({
        role: "rational_player",
        content: evalContent([{ ideaId: "Idea B", score: 0.7 }]),
      }),
      makeAction({
        role: "adversarial",
        content: evalContent([{ ideaId: "Idea B", score: 0.7 }]),
      }),
    ])
    const dissent = computeDissentByTitle([r])
    expect(dissent.get("idea b")).toBeCloseTo(0, 5)
  })

  it("falls back to raw spread when only one camp scored the idea", () => {
    // Only consensus voices, no dissenter — use max-min spread (0.6-0.2=0.4).
    const r = round([
      makeAction({
        role: "rational_player",
        content: evalContent([{ ideaId: "Idea C", score: 0.6 }]),
      }),
      makeAction({
        role: "founder",
        content: evalContent([{ ideaId: "Idea C", score: 0.2 }]),
      }),
    ])
    const dissent = computeDissentByTitle([r])
    expect(dissent.get("idea c")).toBeCloseTo(0.4, 5)
  })

  it("normalizes titles (case + whitespace) into one bucket", () => {
    const r = round([
      makeAction({
        role: "rational_player",
        content: evalContent([{ ideaId: "  Idea D  ", score: 0.9 }]),
      }),
      makeAction({
        role: "adversarial",
        content: evalContent([{ ideaId: "idea d", score: 0.1 }]),
      }),
    ])
    const dissent = computeDissentByTitle([r])
    expect(dissent.size).toBe(1)
    expect(dissent.get("idea d")).toBeCloseTo(0.8, 5)
  })

  it("clamps dissent into [0,1] and ignores malformed actions", () => {
    const r = round([
      makeAction({ role: "rational_player", content: "not-json{" }),
      makeAction({
        role: "adversarial",
        content: evalContent([{ ideaId: "Idea E", score: 2 }]), // clamped to 1
      }),
      makeAction({
        role: "founder",
        content: evalContent([{ ideaId: "Idea E", score: -5 }]), // clamped to 0
      }),
    ])
    const dissent = computeDissentByTitle([r])
    const v = dissent.get("idea e")
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(1)
    expect(v).toBeCloseTo(1, 5)
  })

  it("returns an empty map when there are no scores", () => {
    expect(computeDissentByTitle([round([])]).size).toBe(0)
  })

  it("also reads round-4 finalRankings score shape", () => {
    const r4: SimulationRound = {
      roundNumber: 4,
      roundType: "equilibrium_analysis",
      agentActions: [
        {
          agentId: "adversarial:s",
          role: "adversarial",
          round: 4,
          actionType: "equilibrium_analysis",
          content: JSON.stringify({
            finalRankings: [{ ideaId: "Idea F", score: 0.2 }],
          }),
          confidence: 0.5,
          reasoning: "",
        },
        {
          agentId: "rational_player:s",
          role: "rational_player",
          round: 4,
          actionType: "equilibrium_analysis",
          content: JSON.stringify({
            finalRankings: [{ ideaId: "Idea F", score: 0.8 }],
          }),
          confidence: 0.5,
          reasoning: "",
        },
      ],
      outcomes: { selectedIdeas: [], eliminatedIdeas: [] },
    }
    const dissent = computeDissentByTitle([r4])
    expect(dissent.get("idea f")).toBeCloseTo(0.6, 5)
  })
})

// ── synthesizeFallbackSeed ───────────────────────────────────────────────────

describe("synthesizeFallbackSeed", () => {
  it("never returns an empty string (grounding gate must run)", () => {
    expect(synthesizeFallbackSeed([]).length).toBeGreaterThan(0)
  })

  it("includes candidate titles and descriptions", () => {
    const seed = synthesizeFallbackSeed([
      makeScoredIdea("Billing Copilot", "Automates SaaS billing"),
    ])
    expect(seed).toContain("Billing Copilot")
    expect(seed).toContain("Automates SaaS billing")
  })

  it("returns the last-resort sentinel when all titles are empty-ish", () => {
    const seed = synthesizeFallbackSeed([makeScoredIdea("", "")])
    expect(seed).toContain("no descriptions supplied")
  })

  it("bounds the number of ideas it folds in", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      makeScoredIdea(`Idea ${i}`),
    )
    const seed = synthesizeFallbackSeed(many)
    // Cap is 30 bullet lines.
    expect(seed.split("\n").filter((l) => l.startsWith("- ")).length).toBe(30)
  })
})

// ── buildEvidenceRefByTitle ──────────────────────────────────────────────────

describe("buildEvidenceRefByTitle", () => {
  it("maps lowercased titles to their non-empty evidence refs", () => {
    const candidates: CandidateIdea[] = [
      { title: "Idea A", evidenceRef: ["sig-1", "sig-2"] },
    ]
    const map = buildEvidenceRefByTitle(candidates)
    expect(map.get("idea a")).toEqual(["sig-1", "sig-2"])
  })

  it("omits candidates without evidence refs", () => {
    const map = buildEvidenceRefByTitle([
      { title: "No Refs" },
      { title: "Empty Refs", evidenceRef: [] },
      { title: "Blank Refs", evidenceRef: ["", "  "] },
    ])
    expect(map.size).toBe(0)
  })

  it("drops blank entries from an otherwise-valid ref list", () => {
    const map = buildEvidenceRefByTitle([
      { title: "Mixed", evidenceRef: ["sig-1", "", "sig-2"] },
    ])
    expect(map.get("mixed")).toEqual(["sig-1", "sig-2"])
  })

  it("ignores blank-titled candidates", () => {
    const map = buildEvidenceRefByTitle([
      { title: "  ", evidenceRef: ["sig-1"] },
    ])
    expect(map.size).toBe(0)
  })
})
