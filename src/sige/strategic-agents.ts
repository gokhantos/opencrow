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
    "founder",
    {
      role: "founder",
      name: "Serial Founder",
      description:
        "Focuses on distribution channels, MVP scope, first 100 users, and go-to-market wedge. Thinks about what you build first, not what you build eventually.",
      defaultPersona: {
        name: "Serial Founder",
        background:
          "A 3x founder who has built and sold companies. Obsessed with finding the smallest possible wedge into a market and the distribution hack that makes the first 1000 users inevitable. Has seen hundreds of 'great ideas' die because they couldn't find users.",
        sentimentBias: 0.2,
        influenceWeight: 1.0,
        interestedTopics: ["distribution", "mvp", "go-to-market", "users", "growth", "wedge", "traction"],
        cognitiveStyle:
          "Ruthlessly practical. Asks 'who are the first 100 users and how do you reach them?' before anything else. Kills ideas that can't answer this.",
      },
      strategicType: "Distribution-first thinker",
      reasoningPattern:
        "Start from the user and work backward to the product, not the other way around.",
      defaultEpistemicModel: {
        rationalityModel: "level_k",
        beliefDistribution: {},
        levelOfReasoning: 3,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["user", "growth", "distribution", "market", "traction", "acquisition"],
        attenuatedEntities: ["equilibrium", "payoff", "theoretical"],
      },
    },
  ],

  [
    "user_researcher",
    {
      role: "user_researcher",
      name: "User Research Lead",
      description:
        "Grounds every idea in observed user behavior and validated pain points. Rejects ideas based on assumed rather than evidenced needs.",
      defaultPersona: {
        name: "User Research Lead",
        background:
          "A senior UX researcher with 15 years studying how people actually behave vs. how they say they behave. Expert at identifying the gap between what users say they want and what they actually need. Has killed dozens of 'brilliant' product ideas by showing the underlying assumption was wrong.",
        sentimentBias: -0.1,
        influenceWeight: 0.95,
        interestedTopics: ["pain point", "user behavior", "need", "frustration", "workaround", "complaint", "review"],
        cognitiveStyle:
          "Evidence-driven and skeptical. Every claim about users must be backed by observed behavior, not assumptions. Looks for workarounds people already use as signals of real demand.",
      },
      strategicType: "Evidence-based need validator",
      reasoningPattern:
        "Find the workaround people already use, then build something 10x better than that workaround.",
      defaultEpistemicModel: {
        rationalityModel: "bounded_rationality",
        beliefDistribution: {},
        levelOfReasoning: 2,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["user", "pain", "review", "complaint", "behavior", "need", "workaround"],
        attenuatedEntities: ["strategy", "equilibrium", "game"],
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
    "contrarian_investor",
    {
      role: "contrarian_investor",
      name: "Contrarian VC Partner",
      description:
        "Evaluates ideas through market sizing, timing ('why now?'), defensibility, and what the crowd is missing. Looks for ideas that seem wrong but are right.",
      defaultPersona: {
        name: "Contrarian VC Partner",
        background:
          "A venture partner who has evaluated 10,000+ pitches. Knows that the best investments look like bad ideas to most people. Obsessed with timing — why is NOW the right time for this? Looks for structural changes (regulation, technology shifts, demographic changes) that create new opportunities.",
        sentimentBias: -0.2,
        influenceWeight: 1.0,
        interestedTopics: ["market size", "timing", "defensibility", "moat", "contrarian", "why now", "structural change"],
        cognitiveStyle:
          "Contrarian by nature. If everyone thinks an idea is good, it's probably too late. Looks for ideas where the consensus is wrong and asks 'what has changed recently that makes this possible now?'",
      },
      strategicType: "Timing and market structure analyst",
      reasoningPattern:
        "Identify structural changes that create new opportunities, then find ideas that exploit those changes before the consensus catches up.",
      defaultEpistemicModel: {
        rationalityModel: "full_rationality",
        beliefDistribution: {},
        levelOfReasoning: 5,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["market", "timing", "trend", "shift", "regulation", "technology", "demographics"],
        attenuatedEntities: ["equilibrium", "payoff"],
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
    "technical_architect",
    {
      role: "technical_architect",
      name: "Technical Architect",
      description:
        "Evaluates technical feasibility, identifies what technology enables now that wasn't possible before, and spots technical moats.",
      defaultPersona: {
        name: "Technical Architect",
        background:
          "A senior engineer and CTO who has built products from 0 to millions of users. Understands what's technically hard vs. just tedious. Knows which emerging technologies (AI, edge computing, new APIs) unlock product categories that were previously impossible. Thinks about technical moats — what makes this hard to copy?",
        sentimentBias: 0,
        influenceWeight: 0.9,
        interestedTopics: ["technology", "api", "infrastructure", "scalability", "moat", "feasibility", "ai", "open source"],
        cognitiveStyle:
          "Pragmatic and informed. Distinguishes between 'hard' and 'impossible'. Identifies technical enablers that make ideas newly feasible. Spots where a technical insight creates lasting competitive advantage.",
      },
      strategicType: "Technical feasibility and moat assessor",
      reasoningPattern:
        "Identify what new technology makes possible today that was impossible 2 years ago, then build products on that frontier.",
      defaultEpistemicModel: {
        rationalityModel: "level_k",
        beliefDistribution: {},
        levelOfReasoning: 4,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["technology", "api", "ai", "infrastructure", "github", "open source", "technical"],
        attenuatedEntities: ["social", "sentiment", "coalition"],
      },
    },
  ],

  [
    "designer",
    {
      role: "designer",
      name: "Product Designer",
      description:
        "Thinks about behavioral incentives, user experience friction, and how product design itself can be a competitive advantage.",
      defaultPersona: {
        name: "Product Designer",
        background:
          "A product designer who has shipped apps used by millions. Believes that the best products don't just solve problems — they create new behaviors. Expert at identifying friction points in existing solutions and designing around them. Knows that great UX is a moat because it's the hardest thing to copy.",
        sentimentBias: 0.1,
        influenceWeight: 0.85,
        interestedTopics: ["ux", "design", "friction", "behavior", "habit", "onboarding", "retention", "delight"],
        cognitiveStyle:
          "User-centric and behavioral. Thinks about the entire user journey from first touch to daily habit. Identifies where existing products create unnecessary friction and how a 10x better experience could win.",
      },
      strategicType: "Behavioral design thinker",
      reasoningPattern:
        "Map the user's current journey, find the biggest friction points, then design an experience that eliminates them while creating a new habit loop.",
      defaultEpistemicModel: {
        rationalityModel: "bounded_rationality",
        beliefDistribution: {},
        levelOfReasoning: 3,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["user", "experience", "design", "app", "interface", "behavior", "friction"],
        attenuatedEntities: ["equilibrium", "payoff", "coalition", "game"],
      },
    },
  ],

  [
    "domain_expert",
    {
      role: "domain_expert",
      name: "Domain Expert",
      description:
        "Brings deep vertical knowledge and identifies opportunities that only someone immersed in the domain would see.",
      defaultPersona: {
        name: "Domain Expert",
        background:
          "An industry analyst with deep expertise across multiple verticals (healthcare, fintech, education, enterprise SaaS). Understands the regulatory landscape, incumbent weaknesses, and where domain-specific knowledge creates an unfair advantage. Knows the difference between what sounds good in a pitch and what actually works in a specific industry.",
        sentimentBias: 0,
        influenceWeight: 0.9,
        interestedTopics: ["industry", "regulation", "compliance", "vertical", "domain", "incumbent", "specialist"],
        cognitiveStyle:
          "Deep and nuanced. Understands that different industries have different rules, cycles, and buyer behaviors. Rejects ideas that ignore domain-specific constraints and rewards ideas that leverage domain-specific advantages.",
      },
      strategicType: "Vertical opportunity spotter",
      reasoningPattern:
        "Identify which industries are undergoing structural change and where domain-specific knowledge creates an unfair advantage for new entrants.",
      defaultEpistemicModel: {
        rationalityModel: "full_rationality",
        beliefDistribution: {},
        levelOfReasoning: 4,
      },
      defaultKnowledgeFilter: {
        includedTopics: [],
        excludedTopics: [],
        amplifiedEntities: ["industry", "regulation", "healthcare", "fintech", "education", "enterprise", "compliance"],
        attenuatedEntities: ["evolutionary", "game", "nash"],
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
    1: `## Round 1 — Idea Generation

Your task is to **propose 3–5 concrete project ideas** that address real problems you can identify in the data.

Apply your reasoning pattern: "${definition.reasoningPattern}"

Each idea MUST include:
- **Signal grounding**: Which specific data point(s) from the briefing evidence this need? (cite the actual review, post, or trend)
- **First 100 users**: Who exactly are the first users? Be specific — not "developers" but "solo developers building SaaS who currently waste 3+ hours/week on billing integration"
- **Why existing solutions fail**: What do people use today and why is it inadequate? Point to evidence.
- **The wedge**: What is the smallest, most focused version of this product that delivers immediate value?
- **One-line pitch**: A single sentence a user would forward to a colleague: "It's like X but Y"

CRITICAL QUALITY CRITERIA:
- REJECT ideas that are generic enough that anyone could have proposed them without the data
- REJECT ideas that describe a category ("an AI tool for X") rather than a specific product
- REJECT ideas where the first 100 users are vague or undefined
- Every idea must be traceable to a specific signal in the briefing data`,

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
  signalsContext?: string,
): string {
  const gameSection = serializeGameFormulation(gameFormulation);
  const roundSection = buildRoundInstructions(round, definition, roundContext);

  const sections = [
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
  ];

  // Inject synthesized signals before game formulation if available
  if (signalsContext) {
    sections.push(signalsContext, ``, `---`, ``);
  }

  sections.push(
    gameSection,
    ``,
    `---`,
    ``,
    graphContext,
    ``,
    `---`,
    ``,
    roundSection,
  );

  return sections.join("\n");
}

// ─── Action Schema Builder ────────────────────────────────────────────────────

export function buildActionSchema(round: RoundNumber): ActionSchema {
  switch (round) {
    case 1:
      return {
        description:
          "A list of 3–5 concrete project ideas, each grounded in specific data signals with a clear first-user profile.",
        format: JSON.stringify(
          {
            ideas: [
              {
                title: "string — concise product name",
                description: "string — 2-3 sentence product description",
                signalGrounding: "string — which specific data points evidence this need (cite the review, post, or trend)",
                firstUsers: "string — who exactly are the first 100 users and how do you reach them",
                whyExistingFails: "string — what do people use today and why is it inadequate",
                wedge: "string — the smallest focused version that delivers immediate value",
                oneLiner: "string — a single sentence pitch a user would forward to a colleague",
                confidence: "number 0.0–1.0",
              },
            ],
            reasoning: "string — overall reasoning chain connecting data signals to ideas",
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

  // Try extracting from a ```json ... ``` code block (closed)
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fencedMatch?.[1]) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try extracting from an UNCLOSED ```json block (truncated response)
  const unclosedFenced = trimmed.match(/```(?:json)?\s*([\s\S]+)/);
  if (unclosedFenced?.[1]) {
    const candidate = unclosedFenced[1].trim();
    const repaired = repairTruncatedJson(candidate);
    if (repaired) return repaired;
  }

  // Try finding a bare {...} object
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      // Try repairing truncated bare object
      const repaired = repairTruncatedJson(objectMatch[0]);
      if (repaired) return repaired;
    }
  }

  // Last resort: find the first { and try to repair from there
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    const repaired = repairTruncatedJson(trimmed.slice(firstBrace));
    if (repaired) return repaired;
  }

  throw new Error(
    `Unable to extract JSON from agent output. Preview: ${trimmed.slice(0, 300)}`,
  );
}

/**
 * Attempt to repair truncated JSON by closing open brackets/braces and
 * trimming the last incomplete value.
 */
function repairTruncatedJson(text: string): unknown | undefined {
  // Remove trailing incomplete string values (cut off mid-word)
  let cleaned = text.replace(/,\s*"[^"]*":\s*"[^"]*$/, "");
  // Remove trailing incomplete key-value pairs
  cleaned = cleaned.replace(/,\s*"[^"]*":\s*[^,}\]]*$/, "");
  // Remove trailing comma
  cleaned = cleaned.replace(/,\s*$/, "");

  // Count open/close brackets and braces
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;

  for (const ch of cleaned) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") openBraces++;
    else if (ch === "}") openBraces--;
    else if (ch === "[") openBrackets++;
    else if (ch === "]") openBrackets--;
  }

  // Close any unclosed strings
  if (inString) cleaned += '"';

  // Append missing closing brackets/braces
  for (let i = 0; i < openBrackets; i++) cleaned += "]";
  for (let i = 0; i < openBraces; i++) cleaned += "}";

  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
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
