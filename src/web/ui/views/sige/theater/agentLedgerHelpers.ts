/**
 * Parsing helpers for AgentLedger — kept separate so the component stays <400 lines.
 */
import type { RoundArtifacts } from "../types";

// ─── Action content parsing ────────────────────────────────────────────────────

export interface ParsedIdea {
  readonly title: string;
  readonly description?: string;
}

export interface ParsedContent {
  readonly ideas: readonly ParsedIdea[];
  readonly raw: string;
  readonly parseError: boolean;
}

export function parseActionContent(content: string): ParsedContent {
  try {
    const obj = JSON.parse(content) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      "ideas" in obj &&
      Array.isArray((obj as Record<string, unknown>).ideas)
    ) {
      const rawIdeas = (obj as { ideas: unknown[] }).ideas;
      const ideas = rawIdeas.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as Record<string, unknown>;
        const title = typeof record["title"] === "string" ? record["title"] : null;
        if (!title) return [];
        const description =
          typeof record["description"] === "string" ? record["description"] : undefined;
        return [{ title, description }];
      });
      return { ideas, raw: content, parseError: false };
    }
    return { ideas: [], raw: content, parseError: false };
  } catch {
    return { ideas: [], raw: content, parseError: true };
  }
}

// ─── Taste filter verdict parsing ─────────────────────────────────────────────

export type TasteVerdict = {
  readonly ideaId?: string;
  readonly title?: string;
  readonly verdict?: string;
};

function toVerdict(v: unknown, verdict: string): TasteVerdict[] {
  if (typeof v === "object" && v !== null) return [{ ...(v as object), verdict } as TasteVerdict];
  if (typeof v === "string") return [{ title: v, verdict }];
  return [];
}

export function extractTasteVerdicts(tasteFilter: unknown): readonly TasteVerdict[] {
  if (Array.isArray(tasteFilter)) {
    return (tasteFilter as unknown[]).flatMap((v) =>
      typeof v === "object" && v !== null ? [v as TasteVerdict] : [],
    );
  }
  if (typeof tasteFilter !== "object" || tasteFilter === null) return [];
  const obj = tasteFilter as Record<string, unknown>;
  const rawPassed = obj["passed"];
  const rawEliminated = obj["eliminated"];
  if (!Array.isArray(rawPassed)) return [];
  return [
    ...(rawPassed as unknown[]).flatMap((v) => toVerdict(v, "pass")),
    ...(Array.isArray(rawEliminated)
      ? (rawEliminated as unknown[]).flatMap((v) => toVerdict(v, "eliminate"))
      : []),
  ];
}

// ─── Artifacts aggregation ─────────────────────────────────────────────────────

export function mergeArtifacts(
  artifacts: readonly (RoundArtifacts | null)[],
): RoundArtifacts | null {
  return artifacts.reduce((acc: RoundArtifacts | null, a) => {
    if (a == null) return acc;
    return {
      equilibria: a.equilibria ?? acc?.equilibria,
      coalitions: a.coalitions ?? acc?.coalitions,
      selectedIdeasCount: a.selectedIdeasCount ?? acc?.selectedIdeasCount,
      eliminatedIdeasCount: a.eliminatedIdeasCount ?? acc?.eliminatedIdeasCount,
      metagameHealth: a.metagameHealth ?? acc?.metagameHealth,
      tasteFilter: a.tasteFilter ?? acc?.tasteFilter,
    };
  }, null);
}
