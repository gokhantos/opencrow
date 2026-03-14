import { createLogger } from "../logger";
import type {
  AgentAction,
  AgentPersona,
  EpistemicModel,
  GameFormulation,
  KnowledgeFilter,
  RoundNumber,
  StrategicAgentRole,
} from "./types";

const log = createLogger("sige:strategic-agents");

// ─── Agent Definition Type ────────────────────────────────────────────────────

export interface StrategicAgentDefinition {
  readonly role: StrategicAgentRole;
  readonly name: string;
  readonly description: string;
  readonly defaultPersona: AgentPersona;
  readonly strategicType: string;
  readonly reasoningPattern: string;
  readonly defaultEpistemicModel: EpistemicModel;
  readonly defaultKnowledgeFilter: KnowledgeFilter;
}

// ─── Action Schema Types ──────────────────────────────────────────────────────

export interface ActionSchema {
  readonly description: string;
  readonly format: string;
}

// ─── Definitions Map ──────────────────────────────────────────────────────────

export const STRATEGIC_AGENT_DEFINITIONS: ReadonlyMap<
  StrategicAgentRole,
  StrategicAgentDefinition
> = new Map([
  [
    "rational_player",
    {
      role: "rational_player",
      name: "Nash Equilibrium Analyst",
      description:
        "Seeks stable, self-consistent strategies by evaluating all outcomes under full rationality.",
      defaultPersona: {
        name: "Nash Equilibrium Analyst",
        background:
          "A formal game theorist trained in classical rationality models, Nash equilibrium computation, and payoff maximization across complete information games.",
        sentimentBias: 0,
        influenceWeight: 1.0,
        interestedTopics: ["equilibrium", "payoff", "dominant strategy", "best response", "utility"],
        cognitiveStyle:
          "Systematic, exhaustive, and formal. Evaluates every outcome before drawing conclusions.",
      },
      strategicType: "Nash equilibrium seeker",
      reasoningPattern:
        "Identify strategy profiles where no player can unilaterally improve their payoff.",
      defaultEpistemicModel: {
        rationalityModel: "full_rationality",
        beliefDistribution: {},
        levelOfReasoning: 10,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["equilibrium", "payoff", "strategy", "utility", "best response"],
        attenuatedEntities: [],
      },
    },
  ],

  [
    "boundedly_rational",
    {
      role: "boundedly_rational",
      name: "Practical Strategist",
      description:
        "Satisfices with level-k reasoning to produce implementable solutions at realistic reasoning depths.",
      defaultPersona: {
        name: "Practical Strategist",
        background:
          "A behavioral economist who understands that real decision-makers have limited computation, use heuristics, and reason only a few steps ahead of opponents.",
        sentimentBias: 0,
        influenceWeight: 0.9,
        interestedTopics: ["heuristic", "satisficing", "level-k", "cognitive limit", "practical"],
        cognitiveStyle:
          "Pragmatic and realistic. Prefers good-enough solutions over theoretically perfect but impractical ones.",
      },
      strategicType: "Level-k reasoner",
      reasoningPattern:
        "Find good-enough strategies considering real-world constraints and bounded cognitive depth.",
      defaultEpistemicModel: {
        rationalityModel: "level_k",
        beliefDistribution: {},
        levelOfReasoning: 2,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["constraint", "heuristic", "practical", "feasible", "simple"],
        attenuatedEntities: ["theoretical", "optimal", "idealized"],
      },
    },
  ],

  [
    "cooperative",
    {
      role: "cooperative",
      name: "Coalition Builder",
      description:
        "Identifies mutual benefit through coalition formation and fair allocation via Shapley value analysis.",
      defaultPersona: {
        name: "Coalition Builder",
        background:
          "A cooperative game theorist specializing in coalition formation, Shapley value computation, and the design of agreements that make all parties better off.",
        sentimentBias: 0.4,
        influenceWeight: 0.9,
        interestedTopics: [
          "coalition",
          "cooperation",
          "shapley value",
          "mutual benefit",
          "agreement",
          "alliance",
        ],
        cognitiveStyle:
          "Collaborative and integrative. Always looks for win-win structures and fair distribution of gains.",
      },
      strategicType: "Coalition and Shapley value analyst",
      reasoningPattern:
        "Form coalitions that create value, distribute gains fairly via Shapley values, and stabilize agreements.",
      defaultEpistemicModel: {
        rationalityModel: "cooperative_rationality",
        beliefDistribution: {},
        levelOfReasoning: 3,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["alliance", "partnership", "collaboration", "coalition", "agreement"],
        attenuatedEntities: ["competition", "threat", "conflict", "rivalry", "dispute"],
      },
    },
  ],

  [
    "adversarial",
    {
      role: "adversarial",
      name: "Red Team Analyst",
      description:
        "Applies minimax reasoning and worst-case analysis to stress-test ideas against adversarial scenarios.",
      defaultPersona: {
        name: "Red Team Analyst",
        background:
          "A security and adversarial game theory expert who thinks like an opponent. Trained to find exploitable weaknesses and identify strategies that survive worst-case attacks.",
        sentimentBias: -0.3,
        influenceWeight: 0.95,
        interestedTopics: [
          "threat",
          "vulnerability",
          "worst case",
          "minimax",
          "attack",
          "failure mode",
        ],
        cognitiveStyle:
          "Skeptical and adversarial. Assumes opponents are rational and will exploit any weakness.",
      },
      strategicType: "Minimax adversary",
      reasoningPattern:
        "Identify worst-case outcomes and strategies that survive adversarial pressure.",
      defaultEpistemicModel: {
        rationalityModel: "minimax",
        beliefDistribution: {},
        levelOfReasoning: 5,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "threat",
          "risk",
          "vulnerability",
          "competition",
          "conflict",
          "rival",
          "weakness",
        ],
        attenuatedEntities: ["cooperation", "partnership", "alliance", "agreement"],
      },
    },
  ],

  [
    "evolutionary",
    {
      role: "evolutionary",
      name: "Market Dynamics Analyst",
      description:
        "Uses replicator dynamics to discover strategies that survive competitive pressure at population scale.",
      defaultPersona: {
        name: "Market Dynamics Analyst",
        background:
          "An evolutionary game theorist and market analyst who models how strategies spread, compete, and stabilize across populations of agents over time.",
        sentimentBias: 0,
        influenceWeight: 0.85,
        interestedTopics: [
          "replicator dynamics",
          "fitness",
          "population",
          "evolution",
          "adoption",
          "market share",
        ],
        cognitiveStyle:
          "Dynamic and population-level. Thinks in terms of fitness landscapes and long-run selection pressure.",
      },
      strategicType: "Replicator dynamics analyst",
      reasoningPattern:
        "Identify which strategies proliferate in a competitive population over time via replicator dynamics.",
      defaultEpistemicModel: {
        rationalityModel: "evolutionary_stability",
        beliefDistribution: {},
        levelOfReasoning: 4,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["trend", "adoption", "market share", "growth", "evolution", "fitness"],
        attenuatedEntities: [],
      },
    },
  ],

  [
    "mechanism_designer",
    {
      role: "mechanism_designer",
      name: "Incentive Architect",
      description:
        "Proposes rule changes and incentive structures so that self-interested agents produce desired collective outcomes.",
      defaultPersona: {
        name: "Incentive Architect",
        background:
          "A mechanism design expert and policy architect who designs rules, incentives, and constraints that align individual self-interest with socially optimal outcomes.",
        sentimentBias: 0.1,
        influenceWeight: 1.0,
        interestedTopics: [
          "incentive",
          "mechanism",
          "rule",
          "policy",
          "governance",
          "alignment",
          "regulation",
        ],
        cognitiveStyle:
          "Structural and top-down. Focuses on designing the game rather than playing within it.",
      },
      strategicType: "Stackelberg leader and incentive designer",
      reasoningPattern:
        "Design rules and incentives so self-interested agents produce desired collective outcomes.",
      defaultEpistemicModel: {
        rationalityModel: "stackelberg_leadership",
        beliefDistribution: {},
        levelOfReasoning: 6,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "constraint",
          "rule",
          "regulation",
          "incentive",
          "policy",
          "mechanism",
          "governance",
        ],
        attenuatedEntities: [],
      },
    },
  ],

  [
    "explorer",
    {
      role: "explorer",
      name: "Innovation Scout",
      description:
        "Searches unexplored regions of strategy space with a novelty-first approach and diversity bonus.",
      defaultPersona: {
        name: "Innovation Scout",
        background:
          "A creative strategist and innovation researcher who specializes in discovering strategies that exist outside the current solution space. Actively seeks the unexplored.",
        sentimentBias: 0.3,
        influenceWeight: 0.8,
        interestedTopics: [
          "novel",
          "emerging",
          "experimental",
          "frontier",
          "innovation",
          "unexplored",
          "creative",
        ],
        cognitiveStyle:
          "Divergent and exploratory. Prizes novelty and orthogonality over incremental refinement.",
      },
      strategicType: "Novelty maximizer with diversity bonus",
      reasoningPattern:
        "Generate strategies that exist in unexplored regions of the strategy space.",
      defaultEpistemicModel: {
        rationalityModel: "novelty_maximization",
        beliefDistribution: {},
        levelOfReasoning: 2,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["novel", "emerging", "experimental", "frontier", "innovation"],
        attenuatedEntities: ["established", "dominant", "incumbent", "legacy", "traditional"],
      },
    },
  ],

  [
    "contrarian",
    {
      role: "contrarian",
      name: "Assumption Challenger",
      description:
        "Inverts dominant assumptions and challenges premises that others take for granted.",
      defaultPersona: {
        name: "Assumption Challenger",
        background:
          "A critical epistemologist and devil's advocate trained to identify hidden assumptions, invert conventional wisdom, and expose the fragility of consensus views.",
        sentimentBias: -0.2,
        influenceWeight: 0.85,
        interestedTopics: [
          "assumption",
          "consensus",
          "conventional wisdom",
          "inversion",
          "contradiction",
          "orthodoxy",
        ],
        cognitiveStyle:
          "Skeptical and inversive. Systematically questions what is taken for granted.",
      },
      strategicType: "Assumption inverter with adversarial epistemic lens",
      reasoningPattern:
        "Invert the dominant assumption — what if the opposite of the consensus view is true?",
      defaultEpistemicModel: {
        rationalityModel: "adversarial_epistemic",
        beliefDistribution: {},
        levelOfReasoning: 3,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "assumption",
          "conventional",
          "mainstream",
          "consensus",
          "dominant",
          "orthodox",
        ],
        attenuatedEntities: [],
      },
    },
  ],

  [
    "signaler",
    {
      role: "signaler",
      name: "Strategic Communicator",
      description:
        "Applies Bayesian persuasion and strategic framing to test whether ideas survive misrepresentation.",
      defaultPersona: {
        name: "Strategic Communicator",
        background:
          "A signaling theorist and communications strategist who understands how information is framed, credibility is established, and persuasion operates in strategic environments.",
        sentimentBias: 0.1,
        influenceWeight: 0.9,
        interestedTopics: [
          "signal",
          "framing",
          "credibility",
          "reputation",
          "communication",
          "persuasion",
          "perception",
        ],
        cognitiveStyle:
          "Rhetorical and multi-perspective. Analyzes how the same idea lands differently depending on who is framing it.",
      },
      strategicType: "Bayesian persuasion and strategic framing analyst",
      reasoningPattern:
        "Analyze how ideas would be framed strategically by supporters and opponents, and test credibility.",
      defaultEpistemicModel: {
        rationalityModel: "bayesian_persuasion",
        beliefDistribution: {},
        levelOfReasoning: 4,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "communication",
          "signal",
          "announcement",
          "reputation",
          "credibility",
          "perception",
        ],
        attenuatedEntities: [],
      },
    },
  ],

  [
    "abductive_reasoner",
    {
      role: "abductive_reasoner",
      name: "Pattern Detective",
      description:
        "Generates causal hypotheses and plausibility tests to explain why strategies succeed or fail.",
      defaultPersona: {
        name: "Pattern Detective",
        background:
          "A philosopher of science and pattern recognition specialist who uses abductive reasoning to construct the most plausible explanations for observed outcomes.",
        sentimentBias: 0,
        influenceWeight: 0.85,
        interestedTopics: [
          "anomaly",
          "hypothesis",
          "causal mechanism",
          "explanation",
          "pattern",
          "paradox",
          "outlier",
        ],
        cognitiveStyle:
          "Inductive and explanatory. Works backwards from observations to underlying causal mechanisms.",
      },
      strategicType: "Hypothesis generator and plausibility tester",
      reasoningPattern:
        "Identify the underlying mechanism that best explains the observed strategic patterns.",
      defaultEpistemicModel: {
        rationalityModel: "abductive_inference",
        beliefDistribution: {},
        levelOfReasoning: 4,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: [
          "anomaly",
          "unexplained",
          "surprising",
          "contradiction",
          "paradox",
          "outlier",
          "exception",
        ],
        attenuatedEntities: [],
      },
    },
  ],
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getAllDefinitions(): readonly StrategicAgentDefinition[] {
  return Array.from(STRATEGIC_AGENT_DEFINITIONS.values());
}

export function getDefinition(role: StrategicAgentRole): StrategicAgentDefinition {
  const def = STRATEGIC_AGENT_DEFINITIONS.get(role);
  if (!def) {
    throw new Error(`No strategic agent definition found for role: ${role}`);
  }
  return def;
}

// ─── Game Formulation Serializer ──────────────────────────────────────────────

function serializeGameFormulation(game: GameFormulation): string {
  const playerLines = game.players
    .map(
      (p) =>
        `  - ${p.name} (id: ${p.id})\n    Strategy space: ${p.strategySpace.join(", ")}\n    Payoff function: ${p.payoffFunction}`,
    )
    .join("\n");

  const constraintLines =
    game.constraints.length > 0
      ? game.constraints.map((c) => `  - [${c.type}] ${c.description}`).join("\n")
      : "  None";

  const sections = [
    `### Game Formulation`,
    ``,
    `**Game Type:** ${game.gameType}`,
    `**Move Sequence:** ${game.moveSequence}`,
    ``,
    `**Players (${game.players.length}):**`,
    playerLines,
    ``,
    `**Constraints:**`,
    constraintLines,
  ];

  if (game.informationStructure.asymmetries.length > 0) {
    sections.push(
      ``,
      `**Information Asymmetries:**`,
      game.informationStructure.asymmetries.map((a) => `  - ${a}`).join("\n"),
    );
  }

  if (game.informationStructure.commonKnowledge.length > 0) {
    sections.push(
      ``,
      `**Common Knowledge:**`,
      game.informationStructure.commonKnowledge.map((k) => `  - ${k}`).join("\n"),
    );
  }

  return sections.join("\n");
}

// ─── Round Instructions ───────────────────────────────────────────────────────

function buildRoundInstructions(
  round: RoundNumber,
  definition: StrategicAgentDefinition,
  roundContext?: string,
): string {
  const schema = buildActionSchema(round);

  const contextBlock =
    roundContext
      ? `\n### Results from Previous Rounds\n\n${roundContext}\n`
      : "";

  const roundDescriptions: Record<RoundNumber, string> = {
    1: `## Round 1 — Divergent Generation

Your task is to **propose 3–5 novel strategic ideas** relevant to this game formulation.

Apply your reasoning pattern: "${definition.reasoningPattern}"

Each idea should:
- Be distinct and non-overlapping
- Be grounded in the game structure and knowledge context
- Reflect your strategic perspective as ${definition.name}
- Push beyond the obvious`,

    2: `## Round 2 — Strategic Interaction

Your task is to **evaluate ideas from Round 1 and propose improvements**.

Apply your reasoning pattern: "${definition.reasoningPattern}"

For each idea:
- Score it 0.0–1.0 from your strategic perspective
- Provide a critique that reflects your role's lens
- Suggest a concrete improvement if warranted

Then propose 1–2 new ideas that build on the best candidates.${contextBlock}`,

    3: `## Round 3 — Evolutionary Tournament

Your task is to **rank competing ideas by fitness and propose mutations/recombinations**.

Apply your reasoning pattern: "${definition.reasoningPattern}"

- Rank all ideas by strategic fitness (0.0–1.0) with explicit reasoning
- Propose 1–2 mutations: take a promising idea and modify one key assumption
- Propose 1 crossover: combine two complementary ideas into a stronger hybrid${contextBlock}`,

    4: `## Round 4 — Equilibrium Analysis

Your task is to **identify strategic equilibria and provide final evaluations**.

Apply your reasoning pattern: "${definition.reasoningPattern}"

- Identify any Nash, Pareto, dominant, or evolutionarily stable strategy configurations
- Produce final scores for all surviving ideas
- Flag unexplored quadrants of strategy space
- Provide meta-observations about the strategic landscape${contextBlock}`,
  };

  return `${roundDescriptions[round]}

## Expected Output Format

${schema.description}

Return valid JSON matching this schema:
\`\`\`
${schema.format}
\`\`\``;
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

export function buildStrategicPrompt(
  definition: StrategicAgentDefinition,
  gameFormulation: GameFormulation,
  graphContext: string,
  round: RoundNumber,
  roundContext?: string,
): string {
  const gameSection = serializeGameFormulation(gameFormulation);
  const roundSection = buildRoundInstructions(round, definition, roundContext);

  return [
    `# Strategic Agent: ${definition.name}`,
    ``,
    `## Your Role`,
    ``,
    `You are the **${definition.name}** — ${definition.description}`,
    ``,
    `**Strategic Type:** ${definition.strategicType}`,
    `**Core Reasoning Pattern:** ${definition.reasoningPattern}`,
    ``,
    `### Your Perspective`,
    ``,
    `${definition.defaultPersona.background}`,
    ``,
    `**Cognitive Style:** ${definition.defaultPersona.cognitiveStyle}`,
    ``,
    `You are operating as part of a multi-agent strategic reasoning system. Other agents hold different roles. Your job is not to be balanced — it is to reason deeply from your specific strategic lens and produce insights that only your role can surface.`,
    ``,
    `---`,
    ``,
    gameSection,
    ``,
    `---`,
    ``,
    graphContext,
    ``,
    `---`,
    ``,
    roundSection,
  ].join("\n");
}

// ─── Action Schema Builder ────────────────────────────────────────────────────

export function buildActionSchema(round: RoundNumber): ActionSchema {
  switch (round) {
    case 1:
      return {
        description:
          "A list of 3–5 strategic ideas, each with a title, description, rationale, and confidence score.",
        format: JSON.stringify(
          {
            ideas: [
              {
                title: "string — concise idea name",
                description: "string — 1–3 sentence explanation",
                rationale: "string — why this idea follows from your strategic reasoning",
                confidence: "number 0.0–1.0",
              },
            ],
            reasoning: "string — overall reasoning chain that led to these ideas",
          },
          null,
          2,
        ),
      };

    case 2:
      return {
        description:
          "Evaluations of existing ideas plus 1–2 new proposals, each grounded in your strategic lens.",
        format: JSON.stringify(
          {
            evaluations: [
              {
                ideaId: "string — title of the idea being evaluated",
                score: "number 0.0–1.0",
                critique: "string — analysis from your strategic perspective",
                improvement: "string or null — concrete suggestion, if any",
              },
            ],
            proposals: [
              {
                title: "string",
                description: "string — 1–3 sentences",
              },
            ],
            reasoning: "string — overall strategic reasoning for your evaluations",
          },
          null,
          2,
        ),
      };

    case 3:
      return {
        description:
          "Fitness rankings of all ideas, plus mutations and crossovers that strengthen the gene pool.",
        format: JSON.stringify(
          {
            rankings: [
              {
                ideaId: "string — title of the idea",
                fitness: "number 0.0–1.0",
                reasoning: "string — why this fitness score",
              },
            ],
            mutations: [
              {
                baseIdeaId: "string — title of the idea being mutated",
                mutatedTitle: "string",
                mutatedDescription: "string — what changed and why it is stronger",
              },
            ],
            crossovers: [
              {
                idea1Id: "string — title of first parent idea",
                idea2Id: "string — title of second parent idea",
                combinedTitle: "string",
                combinedDescription: "string — how the combination produces a stronger hybrid",
              },
            ],
          },
          null,
          2,
        ),
      };

    case 4:
      return {
        description:
          "Equilibrium identification, final rankings, unexplored territory, and meta-observations.",
        format: JSON.stringify(
          {
            equilibria: [
              {
                type: "string — nash | pareto | dominant | evolutionary_stable | signaling_separating | signaling_pooling",
                ideaIds: ["string — titles of ideas in this equilibrium"],
                stability: "number 0.0–1.0",
                description: "string — what this equilibrium means strategically",
              },
            ],
            finalRankings: [
              {
                ideaId: "string — title of the idea",
                score: "number 0.0–1.0",
                strategicProperties: "string — key strategic characteristics",
              },
            ],
            unexploredQuadrants: ["string — description of unexplored strategy space regions"],
            metaObservations: ["string — high-level observations about the strategic landscape"],
          },
          null,
          2,
        ),
      };
  }
}

// ─── JSON Extraction ──────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }

  // Try extracting from a ```json ... ``` code block
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try finding a bare {...} object
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Unable to extract JSON from agent output. Preview: ${trimmed.slice(0, 300)}`,
  );
}

// ─── Round-Specific Parsers ───────────────────────────────────────────────────

function parseRound1(raw: Record<string, unknown>, agentId: string, role: StrategicAgentRole): AgentAction {
  const ideas = Array.isArray(raw.ideas) ? raw.ideas : [];
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

  // Compute average confidence
  let totalConfidence = 0;
  for (const idea of ideas) {
    if (typeof (idea as Record<string, unknown>).confidence === "number") {
      totalConfidence += (idea as Record<string, unknown>).confidence as number;
    }
  }
  const confidence = ideas.length > 0 ? totalConfidence / ideas.length : 0.5;

  const targetIdeas = ideas
    .map((i) => (typeof (i as Record<string, unknown>).title === "string" ? (i as Record<string, unknown>).title as string : ""))
    .filter(Boolean);

  return {
    agentId,
    role,
    round: 1,
    actionType: "divergent_generation",
    content: JSON.stringify(raw),
    confidence,
    targetIdeas,
    reasoning,
  };
}

function parseRound2(raw: Record<string, unknown>, agentId: string, role: StrategicAgentRole): AgentAction {
  const evaluations = Array.isArray(raw.evaluations) ? raw.evaluations : [];
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : "";

  let totalScore = 0;
  for (const ev of evaluations) {
    if (typeof (ev as Record<string, unknown>).score === "number") {
      totalScore += (ev as Record<string, unknown>).score as number;
    }
  }
  const confidence = evaluations.length > 0 ? totalScore / evaluations.length : 0.5;

  const targetIdeas = evaluations
    .map((e) => (typeof (e as Record<string, unknown>).ideaId === "string" ? (e as Record<string, unknown>).ideaId as string : ""))
    .filter(Boolean);

  return {
    agentId,
    role,
    round: 2,
    actionType: "strategic_interaction",
    content: JSON.stringify(raw),
    confidence,
    targetIdeas,
    reasoning,
  };
}

function parseRound3(raw: Record<string, unknown>, agentId: string, role: StrategicAgentRole): AgentAction {
  const rankings = Array.isArray(raw.rankings) ? raw.rankings : [];
  const reasoning =
    rankings.length > 0
      ? rankings
          .map((r) => (typeof (r as Record<string, unknown>).reasoning === "string" ? (r as Record<string, unknown>).reasoning as string : ""))
          .filter(Boolean)
          .join(" | ")
      : "";

  let totalFitness = 0;
  for (const r of rankings) {
    if (typeof (r as Record<string, unknown>).fitness === "number") {
      totalFitness += (r as Record<string, unknown>).fitness as number;
    }
  }
  const confidence = rankings.length > 0 ? totalFitness / rankings.length : 0.5;

  const targetIdeas = rankings
    .map((r) => (typeof (r as Record<string, unknown>).ideaId === "string" ? (r as Record<string, unknown>).ideaId as string : ""))
    .filter(Boolean);

  return {
    agentId,
    role,
    round: 3,
    actionType: "evolutionary_tournament",
    content: JSON.stringify(raw),
    confidence,
    targetIdeas,
    reasoning,
  };
}

function parseRound4(raw: Record<string, unknown>, agentId: string, role: StrategicAgentRole): AgentAction {
  const finalRankings = Array.isArray(raw.finalRankings) ? raw.finalRankings : [];
  const metaObservations = Array.isArray(raw.metaObservations) ? raw.metaObservations : [];

  const reasoning =
    metaObservations.length > 0
      ? metaObservations.filter((o) => typeof o === "string").join(" | ")
      : "";

  let totalScore = 0;
  for (const r of finalRankings) {
    if (typeof (r as Record<string, unknown>).score === "number") {
      totalScore += (r as Record<string, unknown>).score as number;
    }
  }
  const confidence = finalRankings.length > 0 ? totalScore / finalRankings.length : 0.5;

  const targetIdeas = finalRankings
    .map((r) => (typeof (r as Record<string, unknown>).ideaId === "string" ? (r as Record<string, unknown>).ideaId as string : ""))
    .filter(Boolean);

  return {
    agentId,
    role,
    round: 4,
    actionType: "equilibrium_analysis",
    content: JSON.stringify(raw),
    confidence,
    targetIdeas,
    reasoning,
  };
}

// ─── Public Parser ────────────────────────────────────────────────────────────

export function parseAgentAction(
  rawOutput: string,
  round: RoundNumber,
  agentId: string,
  role: StrategicAgentRole,
): AgentAction {
  let parsed: unknown;

  try {
    parsed = extractJson(rawOutput);
  } catch (err) {
    log.warn("parseAgentAction: JSON extraction failed, using fallback", { agentId, role, round, err });

    // Fallback: wrap the raw text as content with minimal metadata
    return {
      agentId,
      role,
      round,
      actionType: roundActionType(round),
      content: rawOutput,
      confidence: 0.3,
      targetIdeas: [],
      reasoning: "Failed to parse structured output — raw text preserved.",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    log.warn("parseAgentAction: parsed value is not an object, using fallback", { agentId, role, round });
    return {
      agentId,
      role,
      round,
      actionType: roundActionType(round),
      content: rawOutput,
      confidence: 0.3,
      targetIdeas: [],
      reasoning: "Parsed value was not an object.",
    };
  }

  const raw = parsed as Record<string, unknown>;

  switch (round) {
    case 1:
      return parseRound1(raw, agentId, role);
    case 2:
      return parseRound2(raw, agentId, role);
    case 3:
      return parseRound3(raw, agentId, role);
    case 4:
      return parseRound4(raw, agentId, role);
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function roundActionType(round: RoundNumber): string {
  const types: Record<RoundNumber, string> = {
    1: "divergent_generation",
    2: "strategic_interaction",
    3: "evolutionary_tournament",
    4: "equilibrium_analysis",
  };
  return types[round];
}
