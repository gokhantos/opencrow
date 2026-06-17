import { test, expect, describe } from "bun:test"
import {
  extractDivergentCandidates,
  extractSignalIds,
} from "./expert-game"
import type { AgentAction } from "../types"
import type { StrategicAgentRole } from "../types"

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeAction(params: {
  readonly content: string
  readonly agentId?: string
  readonly role?: StrategicAgentRole
}): AgentAction {
  return {
    agentId: params.agentId ?? "explorer:session-1",
    role: params.role ?? "explorer",
    round: 1,
    actionType: "divergent_generation",
    content: params.content,
    confidence: 0.6,
    targetIdeas: [],
    reasoning: "",
  }
}

function round1Content(ideas: readonly Record<string, unknown>[]): string {
  return JSON.stringify({ ideas, reasoning: "chain" })
}

// ── extractDivergentCandidates ───────────────────────────────────────────────

describe("extractDivergentCandidates", () => {
  test("maps title + description to the simple candidate shape with proposedBy", () => {
    const action = makeAction({
      agentId: "contrarian_investor:abc",
      role: "contrarian_investor",
      content: round1Content([
        { title: "Billing Copilot", description: "Automates SaaS billing.", confidence: 0.7 },
      ]),
    })

    const result = extractDivergentCandidates([action])

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      title: "Billing Copilot",
      summary: "Automates SaaS billing.",
      proposedBy: "contrarian_investor:abc",
    })
  })

  test("trims the title and drops blank-titled ideas", () => {
    const action = makeAction({
      content: round1Content([
        { title: "  Spaced Title  ", description: "d1" },
        { title: "   ", description: "blank — dropped" },
        { title: "", description: "empty — dropped" },
        { description: "no title — dropped" },
      ]),
    })

    const result = extractDivergentCandidates([action])

    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe("Spaced Title")
  })

  test("falls back to oneLiner when description is absent/blank", () => {
    const action = makeAction({
      content: round1Content([
        { title: "A", oneLiner: "It's like X but Y" },
        { title: "B", description: "   ", oneLiner: "fallback pitch" },
      ]),
    })

    const result = extractDivergentCandidates([action])

    expect(result.map((c) => c.summary)).toEqual([
      "It's like X but Y",
      "fallback pitch",
    ])
  })

  test("summary is empty string when neither description nor oneLiner present", () => {
    const action = makeAction({
      content: round1Content([{ title: "Bare" }]),
    })

    const result = extractDivergentCandidates([action])

    expect(result[0]!.summary).toBe("")
  })

  test("aggregates ideas across multiple agent actions, preserving proposedBy per action", () => {
    const a1 = makeAction({
      agentId: "explorer:s",
      role: "explorer",
      content: round1Content([{ title: "E1", description: "x" }]),
    })
    const a2 = makeAction({
      agentId: "founder:s",
      role: "founder",
      content: round1Content([
        { title: "F1", description: "y" },
        { title: "F2", description: "z" },
      ]),
    })

    const result = extractDivergentCandidates([a1, a2])

    expect(result).toHaveLength(3)
    expect(result.find((c) => c.title === "E1")!.proposedBy).toBe("explorer:s")
    expect(result.find((c) => c.title === "F2")!.proposedBy).toBe("founder:s")
  })

  test("skips actions with invalid JSON content without throwing", () => {
    const bad = makeAction({ content: "not json {" })
    const good = makeAction({ content: round1Content([{ title: "Good", description: "d" }]) })

    const result = extractDivergentCandidates([bad, good])

    expect(result).toHaveLength(1)
    expect(result[0]!.title).toBe("Good")
  })

  test("skips content whose JSON is not an object or lacks an ideas array", () => {
    const arr = makeAction({ content: JSON.stringify([1, 2, 3]) })
    const noIdeas = makeAction({ content: JSON.stringify({ reasoning: "x" }) })
    const nullJson = makeAction({ content: "null" })

    const result = extractDivergentCandidates([arr, noIdeas, nullJson])

    expect(result).toHaveLength(0)
  })

  test("returns empty for empty action list", () => {
    expect(extractDivergentCandidates([])).toEqual([])
  })

  test("lifts supportingSignalIds onto the candidate when present", () => {
    const action = makeAction({
      content: round1Content([
        { title: "Grounded", description: "d", supportingSignalIds: ["sig-1", "sig-2"] },
      ]),
    })

    const result = extractDivergentCandidates([action])

    expect(result[0]!.supportingSignalIds).toEqual(["sig-1", "sig-2"])
  })

  test("omits supportingSignalIds key entirely when no signal ids are present", () => {
    const action = makeAction({
      content: round1Content([{ title: "Plain", description: "d" }]),
    })

    const result = extractDivergentCandidates([action])

    expect("supportingSignalIds" in result[0]!).toBe(false)
  })
})

// ── extractSignalIds ─────────────────────────────────────────────────────────

describe("extractSignalIds", () => {
  test("reads supportingSignalIds array", () => {
    expect(extractSignalIds({ supportingSignalIds: ["a", "b"] })).toEqual(["a", "b"])
  })

  test("reads signalIds as an alias", () => {
    expect(extractSignalIds({ signalIds: ["x"] })).toEqual(["x"])
  })

  test("prefers supportingSignalIds over signalIds when both present", () => {
    expect(
      extractSignalIds({ supportingSignalIds: ["primary"], signalIds: ["alt"] }),
    ).toEqual(["primary"])
  })

  test("trims and drops blank / non-string entries", () => {
    expect(
      extractSignalIds({ supportingSignalIds: [" a ", "", "  ", 42, null, "b"] }),
    ).toEqual(["a", "b"])
  })

  test("returns undefined when the field is absent", () => {
    expect(extractSignalIds({ title: "x" })).toBeUndefined()
  })

  test("returns undefined when the field is not an array", () => {
    expect(extractSignalIds({ supportingSignalIds: "sig-1" })).toBeUndefined()
  })

  test("returns undefined when the array is empty or all-blank", () => {
    expect(extractSignalIds({ signalIds: [] })).toBeUndefined()
    expect(extractSignalIds({ signalIds: ["", "   "] })).toBeUndefined()
  })
})
