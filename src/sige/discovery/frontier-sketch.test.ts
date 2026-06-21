import { describe, expect, it } from "bun:test";
import type { DivergentCandidate } from "../simulation/expert-game-scoring";
import type { Frontier } from "./frontier-discovery";
import { frontiersToThemeCandidates } from "./frontier-sketch";

function candidate(overrides: Partial<DivergentCandidate> = {}): DivergentCandidate {
  return {
    title: "Candidate title",
    summary: "Candidate summary",
    proposedBy: "divergent:session",
    ...overrides,
  };
}

function frontier(overrides: Partial<Frontier> = {}): Frontier {
  return {
    id: "frontier-1",
    theme: "Healthcare Scheduling",
    themeKeys: ["healthcare scheduling", "appointment booking"],
    candidates: [candidate()],
    signalStrength: 0.5,
    novelty: 0.5,
    score: 0.25,
    seedText: "Build something for clinics that need better scheduling.",
    ...overrides,
  };
}

describe("frontiersToThemeCandidates", () => {
  it("maps id and title straight through", () => {
    const [out] = frontiersToThemeCandidates([frontier({ id: "f-42", theme: "Pet Health" })]);
    expect(out?.id).toBe("f-42");
    expect(out?.title).toBe("Pet Health");
  });

  it("sets signalStrength from frontier.novelty (NOT pool-share signalStrength)", () => {
    const [out] = frontiersToThemeCandidates([
      frontier({ signalStrength: 0.95, novelty: 0.2 }),
    ]);
    expect(out?.signalStrength).toBe(0.2);
  });

  it("gives a high-pool-share but low-novelty frontier a LOW signalStrength", () => {
    const monoculture = frontier({ id: "big", signalStrength: 0.99, novelty: 0.1 });
    const fresh = frontier({ id: "small", signalStrength: 0.1, novelty: 0.9 });
    const [big, small] = frontiersToThemeCandidates([monoculture, fresh]);
    expect(big?.signalStrength).toBe(0.1);
    expect(small?.signalStrength).toBe(0.9);
    // The pool-share winner must NOT out-rank the fresh frontier on signal.
    expect(big?.signalStrength ?? 0).toBeLessThan(small?.signalStrength ?? 0);
  });

  it("uses themeKeys[0] as the kind diversity bucket", () => {
    const [out] = frontiersToThemeCandidates([
      frontier({ themeKeys: ["primary bucket", "secondary"] }),
    ]);
    expect(out?.kind).toBe("primary bucket");
  });

  it("falls back kind to lowercased theme when themeKeys is empty", () => {
    const [out] = frontiersToThemeCandidates([
      frontier({ theme: "Edge Robotics", themeKeys: [] }),
    ]);
    expect(out?.kind).toBe("edge robotics");
  });

  it("tags source as sige", () => {
    const [out] = frontiersToThemeCandidates([frontier()]);
    expect(out?.source).toBe("sige");
  });

  it("builds context from member titles/summaries plus the seedText", () => {
    const [out] = frontiersToThemeCandidates([
      frontier({
        candidates: [
          candidate({ title: "Clinic Slot Filler", summary: "Auto-fills no-show slots." }),
          candidate({ title: "Triage Bot", summary: "Pre-visit symptom routing." }),
        ],
        seedText: "Reduce wasted clinic capacity.",
      }),
    ]);
    expect(out?.context).toContain("Clinic Slot Filler");
    expect(out?.context).toContain("Auto-fills no-show slots.");
    expect(out?.context).toContain("Triage Bot");
    expect(out?.context).toContain("Reduce wasted clinic capacity.");
  });

  it("caps the member candidates folded into context at ~5", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      candidate({ title: `Member ${i}`, summary: `Summary ${i}` }),
    );
    const [out] = frontiersToThemeCandidates([frontier({ candidates: many })]);
    expect(out?.context).toContain("Member 0");
    expect(out?.context).toContain("Member 4");
    expect(out?.context).not.toContain("Member 5");
    expect(out?.context).not.toContain("Member 11");
  });

  it("collapses whitespace and bounds context length", () => {
    const noisy = candidate({
      title: "Noisy   \n\n  Title",
      summary: "x".repeat(5000),
    });
    const [out] = frontiersToThemeCandidates([frontier({ candidates: [noisy] })]);
    expect(out?.context).not.toMatch(/\s{2,}/);
    expect((out?.context.length ?? 0)).toBeLessThanOrEqual(2000);
  });

  it("does not mutate the input frontiers", () => {
    const input = [frontier()];
    const snapshot = JSON.stringify(input);
    frontiersToThemeCandidates(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("maps every frontier, preserving order", () => {
    const out = frontiersToThemeCandidates([
      frontier({ id: "a", theme: "A" }),
      frontier({ id: "b", theme: "B" }),
      frontier({ id: "c", theme: "C" }),
    ]);
    expect(out.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
