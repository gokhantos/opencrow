import { getDb } from "../store/db";
import { createLogger } from "../logger";
import { findSimilarTasks } from "./semantic-classifier";
import { hashTask } from "./utils/hash";
import { STOP_WORDS } from "./utils/stop-words";
import { type AgentDomain, normalizeDomain } from "./domain-registry";

const log = createLogger("task-classifier");

/**
 * Task domains — canonical taxonomy from domain-registry
 */
export type TaskDomain = AgentDomain;

/**
 * Complexity levels 1-5
 */
export type ComplexityLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Urgency levels
 */
export type UrgencyLevel = "low" | "medium" | "high";

/**
 * Classification result
 */
export interface TaskClassification {
  taskHash: string;
  domain: TaskDomain;
  complexityScore: ComplexityLevel;
  urgency: UrgencyLevel;
  keywords: string[];
}

/**
 * Domain keyword patterns for classification
 */
const DOMAIN_PATTERNS: Partial<Record<TaskDomain, RegExp[]>> = {
  backend: [
    /\b(create|write|add|implement|build)\b.*\b(api|endpoint|route|service|tool|feature|function)\b/i,
    /\b(backend|server|database|query|migration|schema)\b/i,
    /\b(integrate|connect|wire up)\b/i,
    /\b(develop|code|program)\b/i,
  ],
  frontend: [
    /\b(create|write|add|implement|build)\b.*\b(component|page|view|form|button)\b/i,
    /\b(frontend|ui|react|css|style|render)\b/i,
    /\b(responsive|layout|animation)\b/i,
  ],
  architecture: [
    /\b(plan|design|architect|strategy)\b/i,
    /\b(analyze|examine|assess)\b/i,
    /\b(pattern|architecture|structure|trade-off)\b/i,
    /\b(roadmap|milestone|phase|requirement|spec|scope)\b/i,
    /\b(impact|risk|pros|cons)\b/i,
  ],
  research: [
    /\b(search|find|look up|investigate|explore)\b/i,
    /\b(research|study|analyze|compare)\b.*\b(library|framework|tool|option|alternative)\b/i,
    /\b(documentation|docs|spec|api reference)\b/i,
    /\b(trend|market|competitor|landscape)\b/i,
  ],
  content: [
    /\b(write|draft|compose|create)\b.*\b(email|message|post|content|summary|report|doc)\b/i,
    /\b(summarize|brief)\b/i,
    /\b(edit|revise|polish|proofread)\b/i,
  ],
  debugging: [
    /\b(fix|debug|troubleshoot|resolve)\b/i,
    /\b(error|bug|issue|problem|fail|broken)\b/i,
    /\b(why doesn't|why can't|what's wrong)\b/i,
    /\b(stack trace|exception|crash)\b/i,
  ],
  devops: [
    /\b(deploy|release|publish|ship)\b/i,
    /\b(docker|container|image|build)\b/i,
    /\b(ci|cd|pipeline|workflow)\b/i,
    /\b(infrastructure|server|config|environment)\b/i,
    /\b(restart|stop|start|process|service)\b/i,
  ],
  testing: [
    /\b(test|spec|assert|verify)\b/i,
    /\b(unit test|integration test|e2e|coverage)\b/i,
    /\b(mock|stub|fixture)\b/i,
    /\b(run tests|test suite)\b/i,
  ],
  performance: [
    /\b(optimize|improve|enhance|performance)\b/i,
    /\b(slow|latency|bottleneck|profile|benchmark)\b/i,
    /\b(memory|cpu|throughput)\b/i,
  ],
  "api-design": [
    /\b(api design|endpoint design|schema design)\b/i,
    /\b(rest|graphql|grpc|webhook)\b.*\b(design|contract)\b/i,
    /\b(openapi|swagger)\b/i,
  ],
  review: [
    /\b(review|audit|inspect)\b/i,
    /\b(code review|pr review|security review)\b/i,
    /\b(best practice|anti-pattern|smell)\b/i,
  ],
  security: [
    /\b(vulnerability|security|owasp)\b/i,
    /\b(auth|authentication|authorization)\b/i,
    /\b(xss|injection|csrf)\b/i,
  ],
  monitoring: [
    /\b(monitor|health check|alert|observability)\b/i,
    /\b(log analysis|error rate|uptime)\b/i,
  ],
  data: [
    /\b(data|analytics|metrics|statistics)\b/i,
    /\b(sql|query|report|chart|graph)\b/i,
  ],
  ux: [/\b(ux|user experience|usability|accessibility)\b/i, /\b(wcag|a11y)\b/i],
  "prompt-engineering": [
    /\b(prompt|agent prompt|system prompt)\b/i,
    /\b(llm|instruction|persona)\b/i,
  ],
};

/**
 * Keywords that indicate high complexity
 */
const HIGH_COMPLEXITY_KEYWORDS = [
  "architecture",
  "system design",
  "microservice",
  "distributed",
  "scalable",
  "performance optimization",
  "refactor",
  "migration",
  "integration",
  "multi-step",
  "complex",
  "end-to-end",
  "full-stack",
  "pipeline",
  "orchestration",
];

/**
 * Keywords that indicate low complexity
 */
const LOW_COMPLEXITY_KEYWORDS = [
  "simple",
  "quick",
  "small",
  "minor",
  "tiny",
  "fix",
  "update",
  "change",
  "add",
  "remove",
  "rename",
];

/**
 * Keywords that indicate urgency
 */
const URGENCY_KEYWORDS: Record<UrgencyLevel, RegExp[]> = {
  high: [/\b(urgent|asap|immediately|critical|blocker|emergency)\b/i],
  medium: [],
  low: [/\b(when you have time|no rush|later|eventually)\b/i],
};

/**
 * Extract keywords from task text
 */
function extractKeywords(task: string): string[] {
  // Extract words and technical terms
  const words = task.toLowerCase().match(/\b[a-z][a-z0-9+#.-]*\b/g) || [];

  // Filter stop words and short words
  const keywords = words.filter(
    (word) => !STOP_WORDS.has(word) && word.length > 2,
  );

  // Return top 10 unique keywords
  return [...new Set(keywords)].slice(0, 10);
}

/**
 * Determine task domain based on keyword matching
 */
function determineDomain(task: string): TaskDomain {
  const taskLower = task.toLowerCase();
  const scores: Record<string, number> = {};

  // Score each domain
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    scores[domain] = 0;
    for (const pattern of patterns!) {
      if (pattern.test(task)) {
        scores[domain] += 2;
      }
    }
  }

  // Find highest scoring domain
  let maxScore = 0;
  let maxDomain: TaskDomain = "general";

  for (const [domain, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxDomain = domain as TaskDomain;
    }
  }

  // If no clear match, use keyword-based fallback
  if (maxScore === 0) {
    const keywordDomainMap: Record<string, TaskDomain> = {
      component: "frontend",
      react: "frontend",
      css: "frontend",
      frontend: "frontend",
      function: "backend",
      api: "api-design",
      endpoint: "api-design",
      route: "backend",
      backend: "backend",
      typescript: "backend",
      javascript: "backend",
      database: "backend",
      research: "research",
      search: "research",
      find: "research",
      explore: "research",
      compare: "research",
      fix: "debugging",
      error: "debugging",
      bug: "debugging",
      debug: "debugging",
      troubleshoot: "debugging",
      deploy: "devops",
      docker: "devops",
      pipeline: "devops",
      server: "devops",
      test: "testing",
      spec: "testing",
      coverage: "testing",
      review: "review",
      audit: "review",
      security: "security",
      vulnerability: "security",
      plan: "architecture",
      design: "architecture",
      architecture: "architecture",
      strategy: "architecture",
      optimize: "performance",
      performance: "performance",
      slow: "performance",
      monitor: "monitoring",
      health: "monitoring",
      data: "data",
      analytics: "data",
      metrics: "data",
      prompt: "prompt-engineering",
      ux: "ux",
      accessibility: "ux",
      refactor: "backend",
      restructure: "backend",
    };

    for (const [keyword, domain] of Object.entries(keywordDomainMap)) {
      if (taskLower.includes(keyword)) {
        return domain;
      }
    }
  }

  return maxDomain;
}

/**
 * Calculate complexity score based on task characteristics
 */
function calculateComplexity(
  task: string,
  domain: TaskDomain,
): ComplexityLevel {
  const taskLower = task.toLowerCase();
  let score = 3; // Start at medium

  // Check for high complexity indicators
  for (const keyword of HIGH_COMPLEXITY_KEYWORDS) {
    if (taskLower.includes(keyword)) {
      score += 1;
      break;
    }
  }

  // Check for low complexity indicators
  for (const keyword of LOW_COMPLEXITY_KEYWORDS) {
    if (taskLower.includes(keyword)) {
      score -= 1;
      break;
    }
  }

  // Domain-based adjustments
  if (domain === "debugging" || domain === "performance") {
    score += 0.5; // These often require understanding existing code
  }

  if (domain === "architecture" || domain === "research") {
    score -= 0.5; // These are often exploratory
  }

  // Task length as a complexity signal
  if (task.length > 500) {
    score += 0.5; // Long tasks often have more requirements
  } else if (task.length < 50) {
    score -= 0.5; // Very short tasks are often simple
  }

  // Clamp to 1-5
  return Math.max(1, Math.min(5, Math.round(score))) as ComplexityLevel;
}

/**
 * Determine urgency level
 */
function determineUrgency(task: string): UrgencyLevel {
  const taskLower = task.toLowerCase();

  // Check high urgency
  for (const pattern of URGENCY_KEYWORDS.high) {
    if (pattern.test(task)) {
      return "high";
    }
  }

  // Check low urgency
  for (const pattern of URGENCY_KEYWORDS.low) {
    if (pattern.test(task)) {
      return "low";
    }
  }

  return "medium";
}

/**
 * Generate a hash for the task (for deduplication)
 */
// hashTask re-exported from utils/hash.ts
export { hashTask } from "./utils/hash";

/**
 * Classify a task and store the classification
 */
export async function classifyTask(
  task: string,
  sessionId?: string,
): Promise<TaskClassification> {
  const keywordDomain = determineDomain(task);
  const complexityScore = calculateComplexity(task, keywordDomain);
  const urgency = determineUrgency(task);
  const keywords = extractKeywords(task);
  const taskHash = hashTask(task);

  // Phase 2: Use conversation state to adjust classification
  let finalDomain: TaskDomain = keywordDomain;
  let confidenceScore = 0;

  // Phase 7: Enhanced Classification - Semantic similarity matching
  const { semanticDomain, confidenceScore: semanticConfidence } =
    await classifyWithSemanticSimilarity(task, sessionId);

  // Normalize semantic domain to canonical (it may return legacy names from old data)
  const normalizedSemanticDomain = semanticDomain
    ? normalizeDomain(semanticDomain)
    : null;

  // Blend keyword and semantic classification (50/50 if both confident)
  if (normalizedSemanticDomain && semanticConfidence > 0.7) {
    finalDomain = normalizedSemanticDomain;
    confidenceScore = semanticConfidence;
  } else if (semanticConfidence > 0.5 && normalizedSemanticDomain) {
    finalDomain = normalizedSemanticDomain;
    confidenceScore = semanticConfidence;
  }

  // Store classification asynchronously (don't block)
  try {
    const db = getDb();
    await db`INSERT INTO task_classification (task_hash, session_id, domain, complexity_score, urgency, keywords_json, semantic_domain, confidence_score)
             VALUES (${taskHash}, ${sessionId || null}, ${finalDomain}, ${complexityScore}, ${urgency}, ${JSON.stringify(keywords)}, ${semanticDomain || null}, ${confidenceScore})`;
  } catch (err) {
    log.warn("Failed to store task classification", { error: String(err) });
  }

  log.debug("Task classified", {
    taskHash,
    domain: finalDomain,
    complexityScore,
    urgency,
    confidenceScore,
  });

  return {
    taskHash,
    domain: finalDomain,
    complexityScore,
    urgency,
    keywords,
  };
}

/**
 * Phase 1: True Semantic Classification with Embeddings
 * Uses cosine similarity on embeddings instead of keyword overlap
 */
async function classifyWithSemanticSimilarity(
  task: string,
  sessionId?: string,
): Promise<{ semanticDomain: TaskDomain | null; confidenceScore: number }> {
  try {
    const result = await findSimilarTasks(task, {
      minSimilarity: 0.55,
      k: 25,
      outcomeWeight: 0.3,
    });

    return {
      semanticDomain: result.domain,
      confidenceScore: result.confidence,
    };
  } catch (err) {
    log.warn("Semantic classification failed", { error: String(err) });
    return { semanticDomain: null, confidenceScore: 0 };
  }
}
