import { chat } from "../agent/chat";
import type { ConversationMessage } from "../agent/types";
import { createLogger } from "../logger";

const log = createLogger("sige:signal-synthesis");

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface PainCluster {
  readonly name: string;
  readonly description: string;
  readonly sources: readonly string[];
  readonly severity: "critical" | "high" | "medium";
  readonly affectedUserSegment: string;
}

export interface EmergingPattern {
  readonly name: string;
  readonly description: string;
  readonly evidence: readonly string[];
  readonly momentum: "accelerating" | "steady" | "emerging";
  readonly timeHorizon: string;
}

export interface GapSignal {
  readonly category: string;
  readonly description: string;
  readonly currentState: string;
  readonly opportunity: string;
  readonly demandEvidence: string;
}

export interface CollisionPoint {
  readonly trend1: string;
  readonly trend2: string;
  readonly intersection: string;
  readonly noveltyReason: string;
}

export interface SynthesizedSignals {
  readonly painClusters: readonly PainCluster[];
  readonly emergingPatterns: readonly EmergingPattern[];
  readonly gapSignals: readonly GapSignal[];
  readonly collisionPoints: readonly CollisionPoint[];
  readonly rawSignalCount: number;
}

// ─── Raw LLM Response Shapes ──────────────────────────────────────────────────

interface RawPainCluster {
  name?: unknown;
  description?: unknown;
  sources?: unknown;
  severity?: unknown;
  affectedUserSegment?: unknown;
}

interface RawEmergingPattern {
  name?: unknown;
  description?: unknown;
  evidence?: unknown;
  momentum?: unknown;
  timeHorizon?: unknown;
}

interface RawGapSignal {
  category?: unknown;
  description?: unknown;
  currentState?: unknown;
  opportunity?: unknown;
  demandEvidence?: unknown;
}

interface RawCollisionPoint {
  trend1?: unknown;
  trend2?: unknown;
  intersection?: unknown;
  noveltyReason?: unknown;
}

interface RawSynthesizedSignals {
  painClusters?: unknown;
  emergingPatterns?: unknown;
  gapSignals?: unknown;
  collisionPoints?: unknown;
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Signal Intelligence Analyst specializing in market opportunity detection.

Your job is NOT to summarize data — it is to find NON-OBVIOUS PATTERNS across multiple data sources.

Rules:
- Cross-reference signals: a pain point mentioned in app reviews AND discussed on HN is a validated signal
- Look for convergence: when multiple unrelated sources point at the same underlying need
- Identify collision points: pairs of trends that, when combined, create non-obvious opportunities
- Rate pain severity by: frequency of mention + emotional intensity + breadth of affected users
- Gap signals must have both a clear "what exists now" AND "what is missing"

Return only valid JSON — no markdown, no explanation.`;

function buildUserPrompt(enrichedSeed: string): string {
  return `Analyze the following multi-source market intelligence data and extract structured insights.

${enrichedSeed}

## Task
Synthesize the above data into structured signals by finding cross-source patterns.

Return ONLY valid JSON:
{
  "painClusters": [
    {
      "name": "short cluster name",
      "description": "what the pain is and why it persists",
      "sources": ["App Store Reviews", "Reddit", "HN"],
      "severity": "critical | high | medium",
      "affectedUserSegment": "who suffers this pain"
    }
  ],
  "emergingPatterns": [
    {
      "name": "pattern name",
      "description": "what is happening and why it matters",
      "evidence": ["specific data point from source A", "specific data point from source B"],
      "momentum": "accelerating | steady | emerging",
      "timeHorizon": "e.g. 3-6 months or 1-2 years"
    }
  ],
  "gapSignals": [
    {
      "category": "product/market category",
      "description": "the gap in one sentence",
      "currentState": "what solutions exist today",
      "opportunity": "what is missing or underserved",
      "demandEvidence": "specific evidence that users want this"
    }
  ],
  "collisionPoints": [
    {
      "trend1": "first trend name",
      "trend2": "second trend name",
      "intersection": "what novel thing emerges when these combine",
      "noveltyReason": "why this combination is non-obvious"
    }
  ]
}

Requirements:
- 5-8 pain clusters
- 3-5 emerging patterns
- 3-5 gap signals
- 2-3 collision points
- Every claim must be traceable to at least one data source above

Return the JSON:`;
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJson(text: string): RawSynthesizedSignals {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as RawSynthesizedSignals;
  } catch {
    // fall through
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as RawSynthesizedSignals;
    } catch {
      // fall through
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as RawSynthesizedSignals;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Unable to extract JSON from signal synthesis response. Preview: ${trimmed.slice(0, 300)}`,
  );
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

const VALID_SEVERITIES = new Set(["critical", "high", "medium"]);
const VALID_MOMENTUMS = new Set(["accelerating", "steady", "emerging"]);

function validatePainCluster(raw: unknown, index: number): PainCluster {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`painClusters[${index}] must be an object`);
  }
  const obj = raw as RawPainCluster;
  const rawSeverity = toString(obj.severity, "medium");
  const severity = VALID_SEVERITIES.has(rawSeverity)
    ? (rawSeverity as PainCluster["severity"])
    : "medium";

  return {
    name: toString(obj.name, `Pain Cluster ${index + 1}`),
    description: toString(obj.description),
    sources: toStringArray(obj.sources),
    severity,
    affectedUserSegment: toString(obj.affectedUserSegment),
  };
}

function validateEmergingPattern(raw: unknown, index: number): EmergingPattern {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`emergingPatterns[${index}] must be an object`);
  }
  const obj = raw as RawEmergingPattern;
  const rawMomentum = toString(obj.momentum, "emerging");
  const momentum = VALID_MOMENTUMS.has(rawMomentum)
    ? (rawMomentum as EmergingPattern["momentum"])
    : "emerging";

  return {
    name: toString(obj.name, `Pattern ${index + 1}`),
    description: toString(obj.description),
    evidence: toStringArray(obj.evidence),
    momentum,
    timeHorizon: toString(obj.timeHorizon, "unknown"),
  };
}

function validateGapSignal(raw: unknown, index: number): GapSignal {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`gapSignals[${index}] must be an object`);
  }
  const obj = raw as RawGapSignal;

  return {
    category: toString(obj.category, `Category ${index + 1}`),
    description: toString(obj.description),
    currentState: toString(obj.currentState),
    opportunity: toString(obj.opportunity),
    demandEvidence: toString(obj.demandEvidence),
  };
}

function validateCollisionPoint(raw: unknown, index: number): CollisionPoint {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`collisionPoints[${index}] must be an object`);
  }
  const obj = raw as RawCollisionPoint;

  return {
    trend1: toString(obj.trend1, `Trend A`),
    trend2: toString(obj.trend2, `Trend B`),
    intersection: toString(obj.intersection),
    noveltyReason: toString(obj.noveltyReason),
  };
}

function validateSynthesizedSignals(raw: RawSynthesizedSignals): SynthesizedSignals {
  const painClusters = Array.isArray(raw.painClusters)
    ? (raw.painClusters as unknown[]).map(validatePainCluster)
    : [];

  const emergingPatterns = Array.isArray(raw.emergingPatterns)
    ? (raw.emergingPatterns as unknown[]).map(validateEmergingPattern)
    : [];

  const gapSignals = Array.isArray(raw.gapSignals)
    ? (raw.gapSignals as unknown[]).map(validateGapSignal)
    : [];

  const collisionPoints = Array.isArray(raw.collisionPoints)
    ? (raw.collisionPoints as unknown[]).map(validateCollisionPoint)
    : [];

  const rawSignalCount =
    painClusters.length + emergingPatterns.length + gapSignals.length + collisionPoints.length;

  return { painClusters, emergingPatterns, gapSignals, collisionPoints, rawSignalCount };
}

// ─── Signal Count Estimator ───────────────────────────────────────────────────

function estimateRawSignalCount(enrichedSeed: string): number {
  const bulletMatches = enrichedSeed.match(/^[-*•]\s/gm);
  return bulletMatches?.length ?? 0;
}

// ─── Public: synthesizeSignals ────────────────────────────────────────────────

export async function synthesizeSignals(
  enrichedSeed: string,
  options: {
    readonly model: string;
    readonly provider?: "openrouter" | "agent-sdk" | "alibaba" | "anthropic";
  },
): Promise<SynthesizedSignals> {
  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: buildUserPrompt(enrichedSeed),
      timestamp: Date.now(),
    },
  ];

  log.info("Synthesizing signals from enriched seed", {
    model: options.model,
    provider: options.provider ?? "anthropic",
    seedLength: enrichedSeed.length,
    estimatedSignals: estimateRawSignalCount(enrichedSeed),
  });

  let responseText: string;

  try {
    const response = await chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      model: options.model,
      provider: options.provider ?? "anthropic",
    });
    responseText = response.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("LLM call failed during signal synthesis", { err });
    throw new Error(`Signal synthesis LLM call failed: ${msg}`);
  }

  if (!responseText.trim()) {
    throw new Error("Signal synthesis returned an empty response from the LLM");
  }

  let raw: RawSynthesizedSignals;
  try {
    raw = extractJson(responseText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to parse signal synthesis JSON", {
      err,
      responsePreview: responseText.slice(0, 300),
    });
    throw new Error(`Failed to parse signal synthesis JSON from LLM response: ${msg}`);
  }

  let signals: SynthesizedSignals;
  try {
    signals = validateSynthesizedSignals(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Signal synthesis validation failed", { err });
    throw new Error(`Signal synthesis structure validation failed: ${msg}`);
  }

  // Inject estimated raw signal count from the seed itself
  signals = { ...signals, rawSignalCount: estimateRawSignalCount(enrichedSeed) };

  log.info("Signal synthesis complete", {
    painClusters: signals.painClusters.length,
    emergingPatterns: signals.emergingPatterns.length,
    gapSignals: signals.gapSignals.length,
    collisionPoints: signals.collisionPoints.length,
    rawSignalCount: signals.rawSignalCount,
  });

  return signals;
}

// ─── Public: signalsToPromptContext ──────────────────────────────────────────

export function signalsToPromptContext(signals: SynthesizedSignals): string {
  const sections: string[] = [
    `## Synthesized Market Intelligence (${signals.rawSignalCount} raw signals)`,
    "",
  ];

  if (signals.painClusters.length > 0) {
    sections.push("### Pain Clusters");
    for (const cluster of signals.painClusters) {
      sections.push(
        `**[${cluster.severity.toUpperCase()}] ${cluster.name}**`,
        `Segment: ${cluster.affectedUserSegment}`,
        `${cluster.description}`,
        `Sources: ${cluster.sources.join(", ")}`,
        "",
      );
    }
  }

  if (signals.emergingPatterns.length > 0) {
    sections.push("### Emerging Patterns");
    for (const pattern of signals.emergingPatterns) {
      sections.push(
        `**${pattern.name}** (${pattern.momentum}, ${pattern.timeHorizon})`,
        `${pattern.description}`,
        `Evidence: ${pattern.evidence.join(" | ")}`,
        "",
      );
    }
  }

  if (signals.gapSignals.length > 0) {
    sections.push("### Gap Signals");
    for (const gap of signals.gapSignals) {
      sections.push(
        `**${gap.category}**: ${gap.description}`,
        `Now: ${gap.currentState}`,
        `Missing: ${gap.opportunity}`,
        `Demand: ${gap.demandEvidence}`,
        "",
      );
    }
  }

  if (signals.collisionPoints.length > 0) {
    sections.push("### Collision Points");
    for (const cp of signals.collisionPoints) {
      sections.push(
        `**${cp.trend1} × ${cp.trend2}**`,
        `${cp.intersection}`,
        `Why non-obvious: ${cp.noveltyReason}`,
        "",
      );
    }
  }

  return sections.join("\n");
}
