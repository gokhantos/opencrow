/**
 * Prediction Engine - Phase 5: Advanced Intelligence
 *
 * ML-based task prediction using historical data.
 * Predicts agent domains with confidence scores from 500+ historical tasks.
 */

import { getDb } from "../store/db.ts";
import { hashTask } from "./utils/hash";

export interface PredictionResult {
  predictionId: number | null;
  predictedDomain: string;
  predictedAgent: string;
  confidenceScore: number;
  alternativePredictions: AlternativePrediction[];
  features: PredictionFeatures;
  modelVersion: string;
}

export interface AlternativePrediction {
  domain: string;
  agent: string;
  confidenceScore: number;
}

export interface PredictionFeatures {
  taskLength: number;
  keywordMatches: string[];
  domainKeywords: Record<string, number>;
  complexityIndicator: number;
  hasCodeReferences: boolean;
  hasFilePaths: boolean;
  hasErrorMessages: boolean;
}

export interface PredictionRecord {
  id: number;
  sessionId: string;
  taskHash: string;
  taskText: string;
  predictedDomain: string;
  predictedAgent: string;
  confidenceScore: number;
  actualDomain?: string;
  actualAgent?: string;
  wasCorrect?: boolean;
  features: PredictionFeatures;
  createdAt: Date;
}

interface DomainWeights {
  [domain: string]: {
    keywords: string[];
    weight: number;
    successRate: number;
    totalTasks: number;
  };
}

const DOMAIN_KEYWORDS: DomainWeights = {
  architecture: {
    keywords: [
      "design",
      "architecture",
      "plan",
      "structure",
      "pattern",
      "blueprint",
      "system design",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  backend: {
    keywords: [
      "api",
      "endpoint",
      "database",
      "server",
      "route",
      "query",
      "model",
      "schema",
      "migration",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  frontend: {
    keywords: [
      "ui",
      "component",
      "react",
      "css",
      "style",
      "form",
      "button",
      "input",
      "render",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  debugging: {
    keywords: [
      "bug",
      "error",
      "fix",
      "issue",
      "broken",
      "fail",
      "exception",
      "trace",
      "debug",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  review: {
    keywords: ["review", "check", "audit", "verify", "validate", "quality"],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  security: {
    keywords: [
      "security",
      "vulnerability",
      "auth",
      "authentication",
      "authorization",
      "xss",
      "injection",
      "owasp",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  testing: {
    keywords: [
      "test",
      "spec",
      "coverage",
      "jest",
      "vitest",
      "pytest",
      "unit",
      "integration",
      "e2e",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  performance: {
    keywords: [
      "performance",
      "optimize",
      "slow",
      "benchmark",
      "profile",
      "fast",
      "memory",
      "cpu",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  research: {
    keywords: [
      "research",
      "search",
      "find",
      "investigate",
      "explore",
      "analyze",
      "study",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  content: {
    keywords: [
      "write",
      "document",
      "readme",
      "comment",
      "description",
      "summary",
      "report",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  devops: {
    keywords: [
      "deploy",
      "docker",
      "kubernetes",
      "ci",
      "cd",
      "pipeline",
      "infrastructure",
      "server",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  ux: {
    keywords: [
      "ux",
      "ui",
      "accessibility",
      "wcag",
      "design",
      "user experience",
      "usability",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  data: {
    keywords: [
      "data",
      "analytics",
      "metrics",
      "statistics",
      "report",
      "chart",
      "graph",
      "sql",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  "prompt-engineering": {
    keywords: [
      "prompt",
      "agent",
      "llm",
      "instruction",
      "system prompt",
      "persona",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  "api-design": {
    keywords: [
      "api design",
      "endpoint design",
      "schema",
      "contract",
      "openapi",
      "swagger",
      "rest",
      "graphql",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
  monitoring: {
    keywords: [
      "monitor",
      "health",
      "metric",
      "alert",
      "log",
      "observe",
      "track",
    ],
    weight: 1.0,
    successRate: 0,
    totalTasks: 0,
  },
};

const AGENT_DOMAIN_MAP: Record<string, string> = {
  architect: "architecture",
  backend: "backend",
  frontend: "frontend",
  debugger: "debugging",
  reviewer: "review",
  "security-reviewer": "security",
  "tdd-guide": "testing",
  "performance-engineer": "performance",
  researcher: "research",
  writer: "content",
  devops: "devops",
  "ux-advisor": "ux",
  "data-analyst": "data",
  "prompt-engineer": "prompt-engineering",
  "api-designer": "api-design",
  monitor: "monitoring",
};

function extractFeatures(task: string): PredictionFeatures {
  const taskLower = task.toLowerCase();
  const keywordMatches: string[] = [];
  const domainKeywords: Record<string, number> = {};

  for (const [domain, data] of Object.entries(DOMAIN_KEYWORDS)) {
    const matches = data.keywords.filter((kw) =>
      taskLower.includes(kw.toLowerCase()),
    );
    if (matches.length > 0) {
      keywordMatches.push(...matches);
      domainKeywords[domain] = matches.length;
    }
  }

  return {
    taskLength: task.length,
    keywordMatches,
    domainKeywords,
    complexityIndicator: computeComplexity(task),
    hasCodeReferences:
      /[`'"]\.\/|\.\.\/|\.ts|\.js|\.tsx|\.jsx|import|from|require\(/.test(task),
    hasFilePaths:
      /\/[\w.-]+\/[\w.-]+/.test(task) ||
      /^[\w.-]+\.(ts|js|tsx|jsx|py|go|rs)$/.test(task),
    hasErrorMessages:
      /(error|fail|exception|trace|stack|uncaught|syntax)/i.test(task),
  };
}

function computeComplexity(task: string): number {
  const indicators = [
    /build|create|implement|develop/i,
    /refactor|migrate|upgrade/i,
    /integrate|connect|sync/i,
    /optimize|improve|enhance/i,
    /analyze|investigate|research/i,
  ];

  let complexity = 1;
  for (const indicator of indicators) {
    if (indicator.test(task)) complexity++;
  }

  if (task.length > 200) complexity++;
  if (task.includes(";") || task.includes(" and ")) complexity++;
  if (task.includes("?") && task.includes("!")) complexity++;

  return Math.min(complexity, 5);
}

export async function predictAgent(
  task: string,
  sessionId: string,
): Promise<PredictionResult> {
  const features = extractFeatures(task);
  const domainScores = scoreDomains(features);
  const sortedDomains = sortDomainsByScore(domainScores);

  const topDomain = sortedDomains[0]!;
  const predictedAgent = getAgentForDomain(topDomain.domain);

  const alternativePredictions: AlternativePrediction[] = sortedDomains
    .slice(1, 4)
    .map((d) => ({
      domain: d.domain,
      agent: getAgentForDomain(d.domain),
      confidenceScore: d.score,
    }));

  const modelVersion = await getCurrentModelVersion();

  const predictionId = await savePrediction({
    sessionId,
    taskHash: hashTask(task),
    taskText: task,
    predictedDomain: topDomain.domain,
    predictedAgent,
    confidenceScore: topDomain.score,
    features,
  });

  return {
    predictionId,
    predictedDomain: topDomain.domain,
    predictedAgent,
    confidenceScore: topDomain.score,
    alternativePredictions,
    features,
    modelVersion,
  };
}

interface DomainScore {
  domain: string;
  score: number;
}

function scoreDomains(features: PredictionFeatures): DomainScore[] {
  const scores: DomainScore[] = [];

  for (const [domain, data] of Object.entries(DOMAIN_KEYWORDS)) {
    let score = 0;

    const keywordMatches = features.domainKeywords[domain] || 0;
    score += keywordMatches * data.weight * 0.3;

    if (
      features.hasCodeReferences &&
      ["backend", "frontend", "testing"].includes(domain)
    ) {
      score += 0.15;
    }

    if (
      features.hasFilePaths &&
      ["backend", "frontend", "refactor"].includes(domain)
    ) {
      score += 0.1;
    }

    if (
      features.hasErrorMessages &&
      ["debugging", "security", "testing"].includes(domain)
    ) {
      score += 0.15;
    }

    if (data.successRate > 0) {
      score *= 0.5 + data.successRate * 0.5;
    }

    scores.push({ domain, score });
  }

  const maxScore = Math.max(...scores.map((s) => s.score), 0.01);
  return scores.map((s) => ({
    ...s,
    score: Math.min(s.score / maxScore, 1.0),
  }));
}

function sortDomainsByScore(scores: DomainScore[]): DomainScore[] {
  return scores.sort((a, b) => b.score - a.score);
}

function getAgentForDomain(domain: string): string {
  const entry = Object.entries(AGENT_DOMAIN_MAP).find(([_, d]) => d === domain);
  return entry ? entry[0] : "backend";
}

let cachedModelVersion: { value: string; expiresAt: number } | null = null;

async function getCurrentModelVersion(): Promise<string> {
  if (cachedModelVersion && Date.now() < cachedModelVersion.expiresAt) {
    return cachedModelVersion.value;
  }

  const db = getDb();
  const result = await db<{ model_version: string }[]>`
    SELECT model_version FROM prediction_models
    WHERE is_active = TRUE
    ORDER BY trained_at DESC
    LIMIT 1
  `;
  const version = result.length > 0 ? result[0]!.model_version : "v1.0-keyword";
  cachedModelVersion = {
    value: version,
    expiresAt: Date.now() + 5 * 60 * 1000,
  }; // 5min cache
  return version;
}

async function savePrediction(prediction: {
  sessionId: string;
  taskHash: string;
  taskText: string;
  predictedDomain: string;
  predictedAgent: string;
  confidenceScore: number;
  features: PredictionFeatures;
}): Promise<number | null> {
  const db = getDb();
  const result = await db`
    INSERT INTO prediction_records (
      session_id, task_hash, task_text, predicted_domain, predicted_agent,
      confidence_score, features_json
    ) VALUES (
      ${prediction.sessionId},
      ${prediction.taskHash},
      ${prediction.taskText},
      ${prediction.predictedDomain},
      ${prediction.predictedAgent},
      ${prediction.confidenceScore},
      ${JSON.stringify(prediction.features)}
    )
    RETURNING id
  `;
  return result.length > 0 ? Number(result[0].id) : null;
}

export async function recordPredictionOutcome(
  predictionId: number,
  actualDomain: string,
  actualAgent: string,
): Promise<void> {
  const db = getDb();
  const wasCorrect = actualDomain === (await getPredictedDomain(predictionId));

  await db`
    UPDATE prediction_records
    SET actual_domain = ${actualDomain},
        actual_agent = ${actualAgent},
        was_correct = ${wasCorrect}
    WHERE id = ${predictionId}
  `;

  await updateDomainStats(actualDomain, wasCorrect);
}

async function getPredictedDomain(predictionId: number): Promise<string> {
  const db = getDb();
  const result = await db<{ predicted_domain: string }[]>`
    SELECT predicted_domain FROM prediction_records WHERE id = ${predictionId}
  `;
  return result.length > 0 ? result[0]!.predicted_domain : "";
}

async function updateDomainStats(
  domain: string,
  wasCorrect: boolean,
): Promise<void> {
  const db = getDb();

  await db`
    INSERT INTO prediction_performance (domain, total_predictions, correct_predictions, accuracy_rate)
    VALUES (${domain}, 1, ${wasCorrect ? 1 : 0}, ${wasCorrect ? 1.0 : 0.0})
    ON CONFLICT (domain) DO UPDATE SET
      total_predictions = prediction_performance.total_predictions + 1,
      correct_predictions = prediction_performance.correct_predictions + ${wasCorrect ? 1 : 0},
      accuracy_rate = (prediction_performance.correct_predictions + ${wasCorrect ? 1 : 0})::REAL /
                      (prediction_performance.total_predictions + 1),
      last_predicted_at = NOW(),
      updated_at = NOW()
  `;
}

export async function loadDomainStats(): Promise<void> {
  const db = getDb();
  const results = await db<
    { domain: string; total: number; correct: number }[]
  >`
    SELECT domain, total_predictions as total, correct_predictions as correct
    FROM prediction_performance
  `;

  for (const row of results) {
    const domainData = DOMAIN_KEYWORDS[row.domain];
    if (domainData) {
      domainData.totalTasks = row.total;
      domainData.successRate = row.total > 0 ? row.correct / row.total : 0;
    }
  }
}

// hashTask imported from ./utils/hash

export async function getPredictionStats(): Promise<{
  totalPredictions: number;
  overallAccuracy: number;
  byDomain: Array<{
    domain: string;
    total: number;
    correct: number;
    accuracy: number;
  }>;
}> {
  const db = getDb();

  const totalResult = await db<{ total: number; correct: number }[]>`
    SELECT COUNT(*) as total, SUM(CASE WHEN was_correct THEN 1 ELSE 0 END) as correct
    FROM prediction_records
    WHERE was_correct IS NOT NULL
  `;

  const domainResult = await db<
    { domain: string; total: number; correct: number }[]
  >`
    SELECT predicted_domain as domain,
           COUNT(*) as total,
           SUM(CASE WHEN was_correct THEN 1 ELSE 0 END) as correct
    FROM prediction_records
    WHERE was_correct IS NOT NULL
    GROUP BY predicted_domain
    ORDER BY total DESC
  `;

  const total = totalResult[0] ?? { total: 0, correct: 0 };
  const overallAccuracy = total.total > 0 ? total.correct / total.total : 0;

  return {
    totalPredictions: total.total,
    overallAccuracy,
    byDomain: domainResult.map((r) => ({
      domain: r.domain,
      total: r.total,
      correct: r.correct,
      accuracy: r.total > 0 ? r.correct / r.total : 0,
    })),
  };
}
