import { describe, expect, it } from "bun:test"
import { mapCandidatesToScoredIdeas, type CandidateIdea } from "./expert-game"

describe("mapCandidatesToScoredIdeas", () => {
  it("maps title and summary to ScoredIdea fields", () => {
    const candidates: CandidateIdea[] = [
      { title: "Idea A", summary: "Summary A" },
    ]
    const [idea] = mapCandidatesToScoredIdeas(candidates)
    expect(idea?.title).toBe("Idea A")
    expect(idea?.description).toBe("Summary A")
    expect(idea?.proposedBy).toBe("external:candidate")
    expect(idea?.round).toBe(1)
  })

  it("falls back to description when summary is absent", () => {
    const [idea] = mapCandidatesToScoredIdeas([
      { title: "X", description: "desc only" },
    ])
    expect(idea?.description).toBe("desc only")
  })

  it("defaults expertScore to 0.5 when absent", () => {
    const [idea] = mapCandidatesToScoredIdeas([{ title: "X" }])
    expect(idea?.expertScore).toBe(0.5)
  })

  it("clamps expertScore into [0,1]", () => {
    const out = mapCandidatesToScoredIdeas([
      { title: "low", expertScore: -2 },
      { title: "high", expertScore: 5 },
    ])
    expect(out[0]?.expertScore).toBe(0)
    expect(out[1]?.expertScore).toBe(1)
  })

  it("drops candidates with blank or whitespace-only titles", () => {
    const out = mapCandidatesToScoredIdeas([
      { title: "  " },
      { title: "" },
      { title: "kept" },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe("kept")
  })

  it("trims titles", () => {
    const [idea] = mapCandidatesToScoredIdeas([{ title: "  spaced  " }])
    expect(idea?.title).toBe("spaced")
  })

  it("preserves a supplied id and mints one otherwise", () => {
    const out = mapCandidatesToScoredIdeas([
      { title: "with-id", id: "stable-123" },
      { title: "no-id" },
    ])
    expect(out[0]?.id).toBe("stable-123")
    expect(out[1]?.id).toBeTruthy()
    expect(out[1]?.id).not.toBe("stable-123")
  })

  it("initializes neutral incentive and strategic metadata", () => {
    const [idea] = mapCandidatesToScoredIdeas([{ title: "X" }])
    expect(idea?.incentiveBreakdown.diversityBonus).toBe(0)
    expect(idea?.strategicMetadata.paretoOptimal).toBe(false)
    expect(idea?.strategicMetadata.nashEquilibrium).toBe(false)
  })

  it("returns empty for empty input", () => {
    expect(mapCandidatesToScoredIdeas([])).toHaveLength(0)
  })
})
