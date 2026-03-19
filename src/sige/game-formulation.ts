import { chat } from "../agent/chat";
import type { ConversationMessage } from "../agent/types";
import { createLogger } from "../logger";
import type { GraphView } from "./knowledge/graph-query";
import type {
  Constraint,
  GameFormulation,
  GameType,
  InformationStructure,
  PayoffEntry,
  Player,
  SignalSpace,
} from "./types";

const log = createLogger("sige:game-formulation");

// ─── Raw LLM Response Shapes ──────────────────────────────────────────────────

interface RawPlayer {
  id?: unknown;
  name?: unknown;
  strategySpace?: unknown;
  payoffFunction?: unknown;
  informationSet?: unknown;
  privateType?: unknown;
}

interface RawInformationStructure {
  visibility?: unknown;
  asymmetries?: unknown;
  commonKnowledge?: unknown;
}

interface RawConstraint {
  type?: unknown;
  description?: unknown;
  affectedPlayers?: unknown;
}

interface RawSignalSpace {
  senderId?: unknown;
  receiverIds?: unknown;
  signalTypes?: unknown;
}

interface RawPayoffEntry {
  players?: unknown;
  payoffs?: unknown;
}

interface RawGameFormulation {
  gameType?: unknown;
  players?: unknown;
  strategies?: unknown;
  payoffMatrix?: unknown;
  informationStructure?: unknown;
  moveSequence?: unknown;
  constraints?: unknown;
  signalSpaces?: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VALID_GAME_TYPES = new Set<GameType>([
  "simultaneous",
  "sequential",
  "repeated",
  "bayesian",
  "cooperative",
  "evolutionary",
  "stackelberg",
  "signaling",
  "mechanism_design",
]);

const VALID_MOVE_SEQUENCES = new Set(["simultaneous", "sequential", "repeated"]);

const VALID_CONSTRAINT_TYPES = new Set(["budget", "legal", "resource", "temporal", "custom"]);

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a game theory expert. Analyze strategic situations and formulate them as formal games. Return only valid JSON — no markdown, no explanation.";

function buildUserPrompt(seedInput: string, graphContext: string): string {
  return `You are a game theory expert. Analyze the following strategic situation and formulate it as a formal game.

## Seed Question/Context
${seedInput}

${graphContext}

## Task
Identify the game structure:

1. **Players**: Which entities are strategic actors who can take actions? List each with their objectives.
2. **Strategies**: For each player, what are 3-5 possible strategic actions they could take?
3. **Payoffs**: What does each player value? How do different strategy combinations affect their payoffs?
4. **Information**: Who knows what? What information is private vs. public?
5. **Sequence**: Do players act simultaneously, take turns, or interact repeatedly?
6. **Constraints**: What rules, regulations, budgets, or limits constrain the players?
7. **Signals**: Can players send observable messages to each other? What channels exist?
8. **Game Type**: Which game type best models this situation?
   Options: simultaneous, sequential, repeated, bayesian, cooperative, evolutionary, stackelberg, signaling, mechanism_design

Return ONLY valid JSON:
{
  "gameType": "...",
  "players": [
    { "id": "player_1", "name": "...", "strategySpace": ["...", "..."], "payoffFunction": "description of what they optimize for", "informationSet": ["what they know"], "privateType": "hidden trait or null" }
  ],
  "strategies": { "player_1": ["strategy_a", "strategy_b"] },
  "payoffMatrix": [
    { "players": { "player_1": "strategy_a", "player_2": "strategy_x" }, "payoffs": { "player_1": 3, "player_2": 2 } }
  ],
  "informationStructure": {
    "visibility": { "player_1": ["what player 1 can observe"] },
    "asymmetries": ["descriptions of information gaps"],
    "commonKnowledge": ["what everyone knows"]
  },
  "moveSequence": "simultaneous | sequential | repeated",
  "constraints": [
    { "type": "budget | legal | resource | temporal | custom", "description": "...", "affectedPlayers": ["player_1"] }
  ],
  "signalSpaces": [
    { "senderId": "player_1", "receiverIds": ["player_2"], "signalTypes": ["announcement", "threat"] }
  ]
}

Return the JSON game formulation:`;
}

// ─── Graph Context Builder ────────────────────────────────────────────────────

function buildGraphContext(graphView: GraphView): string {
  if (graphView.nodes.length === 0) {
    return "## Knowledge Graph\n\nNo knowledge graph data available.";
  }

  const entityLines = graphView.nodes
    .map((n) => {
      const summary = n.summary ? `: ${n.summary}` : "";
      return `- ${n.name} (${n.entityType})${summary}`;
    })
    .join("\n");

  const nodeNameByUuid = new Map<string, string>(
    graphView.nodes.map((n) => [n.uuid, n.name]),
  );

  const relationshipLines = graphView.edges
    .map((e) => {
      const source = nodeNameByUuid.get(e.sourceNodeUuid) ?? e.sourceNodeUuid;
      const target = nodeNameByUuid.get(e.targetNodeUuid) ?? e.targetNodeUuid;
      const weight = e.weight !== undefined ? ` (weight: ${e.weight})` : "";
      return `- ${source} → ${e.relationType} → ${target}: ${e.fact}${weight}`;
    })
    .join("\n");

  const sections: string[] = [
    "## Knowledge Graph",
    "",
    `### Entities (${graphView.nodes.length})`,
    entityLines,
  ];

  if (graphView.edges.length > 0) {
    sections.push("", `### Relationships (${graphView.edges.length})`, relationshipLines);
  }

  sections.push("", "### Summary", graphView.summary);

  return sections.join("\n");
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJson(text: string): RawGameFormulation {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as RawGameFormulation;
  } catch {
    // fall through
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim()) as RawGameFormulation;
    } catch {
      // fall through
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as RawGameFormulation;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Unable to extract JSON from LLM response. Preview: ${trimmed.slice(0, 300)}`,
  );
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

function toStringArray(value: unknown, _fieldName: string): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toStringRecord(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = typeof v === "string" ? v : String(v);
  }
  return result;
}

function toNumberRecord(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "number") {
      result[k] = v;
    } else if (typeof v === "string") {
      const parsed = parseFloat(v);
      if (!isNaN(parsed)) result[k] = parsed;
    }
  }
  return result;
}

function validatePlayer(raw: unknown, index: number): Player {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`players[${index}] must be an object`);
  }
  const obj = raw as RawPlayer;

  const id =
    typeof obj.id === "string" && obj.id.trim()
      ? obj.id.trim()
      : `player_${index + 1}`;

  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : id;

  const payoffFunction =
    typeof obj.payoffFunction === "string" ? obj.payoffFunction : "";

  const strategySpace = toStringArray(obj.strategySpace, `players[${index}].strategySpace`);
  const informationSet = toStringArray(obj.informationSet, `players[${index}].informationSet`);

  const privateType =
    typeof obj.privateType === "string" && obj.privateType.toLowerCase() !== "null"
      ? obj.privateType
      : undefined;

  return { id, name, strategySpace, payoffFunction, informationSet, privateType };
}

function validateInformationStructure(raw: unknown): InformationStructure {
  if (typeof raw !== "object" || raw === null) {
    return { visibility: {}, asymmetries: [], commonKnowledge: [] };
  }
  const obj = raw as RawInformationStructure;

  const visibilityRaw =
    typeof obj.visibility === "object" && obj.visibility !== null && !Array.isArray(obj.visibility)
      ? (obj.visibility as Record<string, unknown>)
      : {};

  const visibility: Record<string, readonly string[]> = {};
  for (const [playerId, observed] of Object.entries(visibilityRaw)) {
    visibility[playerId] = toStringArray(observed, `visibility.${playerId}`);
  }

  return {
    visibility,
    asymmetries: toStringArray(obj.asymmetries, "informationStructure.asymmetries"),
    commonKnowledge: toStringArray(obj.commonKnowledge, "informationStructure.commonKnowledge"),
  };
}

function validateConstraint(raw: unknown, index: number): Constraint {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`constraints[${index}] must be an object`);
  }
  const obj = raw as RawConstraint;

  const rawType = typeof obj.type === "string" ? obj.type : "custom";
  const type = VALID_CONSTRAINT_TYPES.has(rawType)
    ? (rawType as Constraint["type"])
    : "custom";

  const description = typeof obj.description === "string" ? obj.description : "";
  const affectedPlayers = toStringArray(obj.affectedPlayers, `constraints[${index}].affectedPlayers`);

  return { type, description, affectedPlayers };
}

function validateSignalSpace(raw: unknown, index: number): SignalSpace {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`signalSpaces[${index}] must be an object`);
  }
  const obj = raw as RawSignalSpace;

  const senderId = typeof obj.senderId === "string" ? obj.senderId : `sender_${index}`;
  const receiverIds = toStringArray(obj.receiverIds, `signalSpaces[${index}].receiverIds`);
  const signalTypes = toStringArray(obj.signalTypes, `signalSpaces[${index}].signalTypes`);

  return { senderId, receiverIds, signalTypes };
}

function validatePayoffEntry(raw: unknown, index: number): PayoffEntry {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`payoffMatrix[${index}] must be an object`);
  }
  const obj = raw as RawPayoffEntry;

  return {
    players: toStringRecord(obj.players),
    payoffs: toNumberRecord(obj.payoffs),
  };
}

// ─── Public: validateGameFormulation ─────────────────────────────────────────

export function validateGameFormulation(raw: unknown): GameFormulation {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Game formulation must be an object");
  }
  const obj = raw as RawGameFormulation;

  // Players — fallback to generic players if LLM didn't extract enough
  let players: Player[];
  if (!Array.isArray(obj.players) || obj.players.length < 2) {
    log.warn("Game formulation has fewer than 2 players, generating fallback players");
    players = [
      { id: "innovator", name: "Innovator", strategySpace: ["build_mvp", "pivot", "scale", "partner"], payoffFunction: "market share and user growth", informationSet: ["market data", "user feedback"], privateType: "risk_tolerance" },
      { id: "incumbent", name: "Incumbent", strategySpace: ["defend", "acquire", "copy", "ignore"], payoffFunction: "revenue retention and market dominance", informationSet: ["market data", "competitive intelligence"], privateType: "resource_level" },
      { id: "consumer", name: "Consumer Segment", strategySpace: ["adopt_early", "wait_and_see", "resist", "switch"], payoffFunction: "value for money and convenience", informationSet: ["public reviews", "price signals"] },
    ];
  } else {
    players = (obj.players as unknown[]).map(validatePlayer);
  }

  // Validate each player has at least 1 strategy
  for (const player of players) {
    if (player.strategySpace.length === 0) {
      throw new Error(`Player "${player.id}" must have at least 1 strategy in strategySpace`);
    }
  }

  // Game type
  const rawGameType = typeof obj.gameType === "string" ? obj.gameType : "";
  const gameType: GameType = VALID_GAME_TYPES.has(rawGameType as GameType)
    ? (rawGameType as GameType)
    : "simultaneous";

  // Strategies map
  const rawStrategies =
    typeof obj.strategies === "object" && obj.strategies !== null && !Array.isArray(obj.strategies)
      ? (obj.strategies as Record<string, unknown>)
      : {};

  const strategies: Record<string, readonly string[]> = {};
  for (const player of players) {
    strategies[player.id] =
      toStringArray(rawStrategies[player.id], `strategies.${player.id}`).length > 0
        ? toStringArray(rawStrategies[player.id], `strategies.${player.id}`)
        : player.strategySpace;
  }

  // Payoff matrix (optional)
  const payoffMatrix = Array.isArray(obj.payoffMatrix)
    ? (obj.payoffMatrix as unknown[]).map(validatePayoffEntry)
    : undefined;

  // Information structure
  const informationStructure = validateInformationStructure(obj.informationStructure);

  // Move sequence
  const rawMoveSeq = typeof obj.moveSequence === "string" ? obj.moveSequence : "simultaneous";
  const moveSequence = VALID_MOVE_SEQUENCES.has(rawMoveSeq)
    ? (rawMoveSeq as GameFormulation["moveSequence"])
    : "simultaneous";

  // Constraints
  const constraints = Array.isArray(obj.constraints)
    ? (obj.constraints as unknown[]).map(validateConstraint)
    : [];

  // Signal spaces
  const signalSpaces = Array.isArray(obj.signalSpaces)
    ? (obj.signalSpaces as unknown[]).map(validateSignalSpace)
    : [];

  return {
    id: crypto.randomUUID(),
    sessionId: "",
    gameType,
    players,
    strategies,
    payoffMatrix,
    informationStructure,
    moveSequence,
    constraints,
    signalSpaces,
  };
}

// ─── Public: detectGameType ───────────────────────────────────────────────────

export function detectGameType(
  formulation: Omit<GameFormulation, "gameType">,
): GameType {
  const { players, informationStructure, moveSequence, signalSpaces } = formulation;

  // Mechanism designer present — a player who sets the rules for others
  const hasMechanismDesigner = players.some(
    (p) =>
      p.payoffFunction.toLowerCase().includes("design") ||
      p.payoffFunction.toLowerCase().includes("mechanism") ||
      p.payoffFunction.toLowerCase().includes("rule"),
  );
  if (hasMechanismDesigner) return "mechanism_design";

  // Signaling — signal spaces exist and information is asymmetric
  const hasSignals = (signalSpaces?.length ?? 0) > 0;
  const hasAsymmetry = informationStructure.asymmetries.length > 0;
  if (hasSignals && hasAsymmetry) return "signaling";

  // Private types present → Bayesian game
  const hasPrivateTypes = players.some((p) => p.privateType !== undefined);
  if (hasPrivateTypes && hasAsymmetry) return "bayesian";

  // All players share objectives (cooperative framing)
  const cooperativeKeywords = ["jointly", "shared", "mutual", "cooperat", "team", "coalition"];
  const allCooperative = players.every((p) =>
    cooperativeKeywords.some((kw) => p.payoffFunction.toLowerCase().includes(kw)),
  );
  if (allCooperative) return "cooperative";

  // Repeated interaction
  if (moveSequence === "repeated") return "repeated";

  // Sequential — check for a clear first-mover / leader
  if (moveSequence === "sequential") {
    const hasLeader = players.some(
      (p) =>
        p.payoffFunction.toLowerCase().includes("leader") ||
        p.payoffFunction.toLowerCase().includes("first-mover") ||
        p.payoffFunction.toLowerCase().includes("anticipat"),
    );
    return hasLeader ? "stackelberg" : "sequential";
  }

  // Population-level dynamics keyword check
  const hasEvolutionaryKeyword = players.some(
    (p) =>
      p.payoffFunction.toLowerCase().includes("fitness") ||
      p.payoffFunction.toLowerCase().includes("population") ||
      p.payoffFunction.toLowerCase().includes("evolut"),
  );
  if (hasEvolutionaryKeyword) return "evolutionary";

  return "simultaneous";
}

// ─── Public: summarizeGame ────────────────────────────────────────────────────

export function summarizeGame(formulation: GameFormulation): string {
  const { gameType, players, informationStructure, moveSequence, constraints } = formulation;

  const playerNames = players.map((p) => p.name).join(", ");
  const constraintCount = constraints.length;
  const asymmetryCount = informationStructure.asymmetries.length;

  const lines: string[] = [
    `Game Type: ${gameType}`,
    `Players (${players.length}): ${playerNames}`,
    `Move Sequence: ${moveSequence}`,
  ];

  if (asymmetryCount > 0) {
    lines.push(
      `Information Asymmetries (${asymmetryCount}): ${informationStructure.asymmetries.slice(0, 2).join("; ")}${asymmetryCount > 2 ? "; ..." : ""}`,
    );
  } else {
    lines.push("Information: symmetric (common knowledge)");
  }

  if (constraintCount > 0) {
    const constraintTypes = [...new Set(constraints.map((c) => c.type))].join(", ");
    lines.push(`Constraints (${constraintCount}): ${constraintTypes}`);
  }

  for (const player of players) {
    const strategies = formulation.strategies[player.id] ?? player.strategySpace;
    lines.push(
      `  ${player.name}: optimizes "${player.payoffFunction}" | strategies: ${strategies.slice(0, 3).join(", ")}${strategies.length > 3 ? ", ..." : ""}`,
    );
  }

  return lines.join("\n");
}

// ─── Public: formulateGame ────────────────────────────────────────────────────

export async function formulateGame(
  graphView: GraphView,
  seedInput: string,
  options: {
    readonly model: string;
    readonly provider?: "openrouter" | "agent-sdk" | "alibaba" | "anthropic";
    readonly sessionId: string;
    readonly preferredGameType?: GameType;
  },
): Promise<GameFormulation> {
  const graphContext = buildGraphContext(graphView);
  const userContent = buildUserPrompt(seedInput, graphContext);

  const messages: readonly ConversationMessage[] = [
    {
      role: "user",
      content: userContent,
      timestamp: Date.now(),
    },
  ];

  log.info("Formulating game from knowledge graph", {
    model: options.model,
    sessionId: options.sessionId,
    nodeCount: graphView.nodes.length,
    edgeCount: graphView.edges.length,
    preferredGameType: options.preferredGameType,
  });

  let responseText: string;

  try {
    const response = await chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      model: options.model,
      provider: options.provider ?? "anthropic",
      rawSystemPrompt: true,
    });
    responseText = response.text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("LLM call failed during game formulation", { err, sessionId: options.sessionId });
    throw new Error(`Game formulation LLM call failed: ${msg}`);
  }

  if (!responseText.trim()) {
    throw new Error("Game formulation returned an empty response from the LLM");
  }

  let raw: RawGameFormulation;
  try {
    raw = extractJson(responseText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Failed to parse game formulation JSON", {
      err,
      sessionId: options.sessionId,
      responsePreview: responseText.slice(0, 300),
    });
    throw new Error(`Failed to parse game formulation JSON from LLM response: ${msg}`);
  }

  let formulation: GameFormulation;
  try {
    formulation = validateGameFormulation(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Game formulation validation failed", { err, sessionId: options.sessionId });
    throw new Error(`Game formulation structure validation failed: ${msg}`);
  }

  // Stamp session ID
  formulation = { ...formulation, sessionId: options.sessionId };

  // Game type selection: user override > auto-correction
  let finalGameType: GameType;
  if (options.preferredGameType) {
    finalGameType = options.preferredGameType;
    log.debug("Using preferred game type override", {
      preferred: options.preferredGameType,
      llmSuggested: formulation.gameType,
    });
  } else {
    const detected = detectGameType(formulation);
    if (detected !== formulation.gameType) {
      log.debug("Auto-correcting game type", {
        llmSuggested: formulation.gameType,
        detected,
      });
    }
    finalGameType = detected;
  }

  const result: GameFormulation = { ...formulation, gameType: finalGameType };

  log.info("Game formulation complete", {
    sessionId: options.sessionId,
    gameType: result.gameType,
    playerCount: result.players.length,
    constraintCount: result.constraints.length,
  });

  return result;
}
