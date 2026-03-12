/**
 * Preference Extractor - Phase 5: Advanced Intelligence
 *
 * Extracts user preferences from conversations.
 * Categories: communication, coding, workflow, tool, model
 */

import { getDb } from "../store/db.ts";

export interface UserPreference {
  id: string;
  preferenceType: "communication" | "coding" | "workflow" | "tool" | "model";
  preferenceKey: string;
  preferenceValue: string;
  confidence: number;
  sourceSessionId?: string;
  expiresAt?: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PreferenceExtraction {
  id: number;
  sessionId: string;
  messageId?: string;
  extractedPreferences: PreferenceCandidate[];
  extractionConfidence: number;
  createdAt: Date;
}

export interface PreferenceCandidate {
  type: UserPreference["preferenceType"];
  key: string;
  value: string;
  confidence: number;
  evidence: string;
}

interface PreferencePattern {
  type: UserPreference["preferenceType"];
  patterns: RegExp[];
  valueExtractor: RegExp;
}

const PREFERENCE_PATTERNS: PreferencePattern[] = [
  {
    type: "communication",
    patterns: [
      /be concise/i,
      /no emoji/i,
      /short responses?/i,
      /detailed explanation/i,
      /bullet points/i,
      /no walls? of text/i,
      /direct answer/i,
      /explain (?:like|as if)/i,
    ],
    valueExtractor:
      /(be concise|no emoji|short responses?|detailed explanation|bullet points|no walls? of text|direct answer|explain (?:like|as if).+?)(?:\s|$|,|\.|;)/i,
  },
  {
    type: "coding",
    patterns: [
      /use (?:snake_case|camelCase|kebab-case|PascalCase)/i,
      /prefer (?:functions|classes|hooks|composition)/i,
      /no (?:comments|docstrings|type annotations)/i,
      /always (?:use const|add types|validate input)/i,
      /functional (?:style|programming)/i,
      /object-oriented/i,
      /immutable (?:data|state)/i,
    ],
    valueExtractor:
      /(use (?:snake_case|camelCase|kebab-case|PascalCase)|prefer (?:functions|classes|hooks|composition)|no (?:comments|docstrings|type annotations)|always (?:use const|add types|validate input)|functional (?:style|programming)|object-oriented|immutable (?:data|state))(?:\s|$|,|\.|;)/i,
  },
  {
    type: "workflow",
    patterns: [
      /test[- ]first/i,
      /tdd/i,
      /commit (?:often|early)/i,
      /small (?:commits|changes)/i,
      /one (?:thing|task) at (?:a )?time/i,
      /batch (?:operations|changes)/i,
      /iterate (?:quickly|fast)/i,
    ],
    valueExtractor:
      /(test[- ]first|tdd|commit (?:often|early)|small (?:commits|changes)|one (?:thing|task) at (?:a )?time|batch (?:operations|changes)|iterate (?:quickly|fast))(?:\s|$|,|\.|;)/i,
  },
  {
    type: "tool",
    patterns: [
      /use (?:bun|node|deno)/i,
      /prefer (?:npm|yarn|pnpm|bun)/i,
      /use (?:postgres|mysql|mongo|redis)/i,
      /use (?:docker|kubernetes)/i,
      /prefer (?:vim|vscode|emacs)/i,
      /use (?:jest|vitest|pytest)/i,
    ],
    valueExtractor:
      /(use (?:bun|node|deno)|prefer (?:npm|yarn|pnpm|bun)|use (?:postgres|mysql|mongo|redis)|use (?:docker|kubernetes)|prefer (?:vim|vscode|emacs)|use (?:jest|vitest|pytest))(?:\s|$|,|\.|;)/i,
  },
  {
    type: "model",
    patterns: [
      /use (?:opus|sonnet|haiku)/i,
      /prefer (?:fast|cheap|accurate) model/i,
      /use (?:gpt|claude|gemini)/i,
      /default to (?:opus|sonnet|haiku)/i,
    ],
    valueExtractor:
      /(use (?:opus|sonnet|haiku)|prefer (?:fast|cheap|accurate) model|use (?:gpt|claude|gemini)|default to (?:opus|sonnet|haiku))(?:\s|$|,|\.|;)/i,
  },
];

export async function extractPreferencesFromMessage(
  _sessionId: string,
  _messageId: string,
  messageText: string,
): Promise<PreferenceCandidate[]> {
  const candidates: PreferenceCandidate[] = [];

  for (const pattern of PREFERENCE_PATTERNS) {
    for (const regex of pattern.patterns) {
      if (regex.test(messageText)) {
        const match = messageText.match(pattern.valueExtractor);
        if (match) {
          const value = normalizePreferenceValue(match[0]);
          const key = extractKeyFromValue(value);

          candidates.push({
            type: pattern.type,
            key,
            value,
            confidence: calculateConfidence(messageText, regex),
            evidence: messageText.substring(0, 100),
          });
        }
      }
    }
  }

  return candidates;
}

function normalizePreferenceValue(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[,.;\s]+|[,.;\s]+$/g, "");
}

function extractKeyFromValue(value: string): string {
  const keyPatterns: [RegExp, string][] = [
    [/use (snake_case|camelCase|kebab-case|PascalCase)/i, "naming_convention"],
    [/no (comments|docstrings|type annotations)/i, "avoid_$1"],
    [/prefer (functions|classes|hooks|composition)/i, "preferred_pattern"],
    [/use (bun|node|deno)/i, "runtime"],
    [/use (postgres|mysql|mongo|redis)/i, "database"],
    [/use (docker|kubernetes)/i, "containerization"],
    [/use (opus|sonnet|haiku)/i, "model_preference"],
    [/be (concise|detailed|direct)/i, "response_style"],
    [/no (emoji|emojis)/i, "emoji_usage"],
  ];

  for (const [pattern, key] of keyPatterns) {
    const match = value.match(pattern);
    if (match) {
      return key.replace("$1", match[1]?.toLowerCase() || "");
    }
  }

  return value.replace(/\s+/g, "_").substring(0, 30);
}

function calculateConfidence(
  messageText: string,
  _matchedPattern: RegExp,
): number {
  let confidence = 0.5;

  if (/always|never|must|required/i.test(messageText)) {
    confidence += 0.2;
  }

  if (/prefer|like|want/i.test(messageText)) {
    confidence += 0.15;
  }

  if (/[.!]$/.test(messageText.trim())) {
    confidence += 0.1;
  }

  const words = messageText.split(/\s+/);
  if (words.length < 10) {
    confidence += 0.1;
  }

  return Math.min(confidence, 1.0);
}

export async function savePreferences(
  candidates: PreferenceCandidate[],
  sessionId: string,
  messageId?: string,
): Promise<UserPreference[]> {
  const db = getDb();
  const saved: UserPreference[] = [];

  for (const candidate of candidates) {
    if (candidate.confidence < 0.6) continue;

    const id = crypto.randomUUID();
    const now = new Date();

    await db`
      INSERT INTO user_preferences (
        id, preference_type, preference_key, preference_value,
        confidence, source_session_id, is_active, created_at, updated_at
      ) VALUES (
        ${id},
        ${candidate.type},
        ${candidate.key},
        ${candidate.value},
        ${candidate.confidence},
        ${sessionId},
        TRUE,
        ${now},
        ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        preference_value = EXCLUDED.preference_value,
        confidence = EXCLUDED.confidence,
        updated_at = NOW()
    `;

    saved.push({
      id,
      preferenceType: candidate.type,
      preferenceKey: candidate.key,
      preferenceValue: candidate.value,
      confidence: candidate.confidence,
      sourceSessionId: sessionId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db`
    INSERT INTO preference_extractions (
      session_id, message_id, extracted_preferences_json, extraction_confidence
    ) VALUES (
      ${sessionId},
      ${messageId || null},
      ${JSON.stringify(candidates)},
      ${candidates.length > 0 ? Math.max(...candidates.map((c) => c.confidence)) : 0}
    )
  `;

  return saved;
}

export async function getActivePreferences(): Promise<UserPreference[]> {
  const db = getDb();
  const results = await db<
    {
      id: string;
      preference_type: string;
      preference_key: string;
      preference_value: string;
      confidence: number;
      source_session_id: string | null;
      expires_at: Date | null;
      is_active: boolean;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT * FROM user_preferences
    WHERE is_active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY confidence DESC, updated_at DESC
  `;

  return results.map((row) => ({
    id: row.id,
    preferenceType: row.preference_type as UserPreference["preferenceType"],
    preferenceKey: row.preference_key,
    preferenceValue: row.preference_value,
    confidence: row.confidence,
    sourceSessionId: row.source_session_id || undefined,
    expiresAt: row.expires_at || undefined,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function getPreferenceStats(): Promise<{
  totalPreferences: number;
  byType: Record<string, number>;
  averageConfidence: number;
}> {
  const db = getDb();

  const totalResult = await db<{ total: number; avg_confidence: number }[]>`
    SELECT COUNT(*) as total, AVG(confidence) as avg_confidence
    FROM user_preferences
    WHERE is_active = TRUE
  `;

  const byTypeResult = await db<{ preference_type: string; count: number }[]>`
    SELECT preference_type, COUNT(*) as count
    FROM user_preferences
    WHERE is_active = TRUE
    GROUP BY preference_type
  `;

  return {
    totalPreferences: totalResult[0]?.total ?? 0,
    byType: Object.fromEntries(
      byTypeResult.map((r) => [r.preference_type, r.count]),
    ),
    averageConfidence: totalResult[0]?.avg_confidence || 0,
  };
}

export function formatPreferencesForPrompt(
  preferences: UserPreference[],
): string {
  if (preferences.length === 0) return "";

  const byType: Record<string, UserPreference[]> = {};
  for (const pref of preferences) {
    if (!byType[pref.preferenceType]) {
      byType[pref.preferenceType] = [];
    }
    byType[pref.preferenceType]!.push(pref);
  }

  const lines: string[] = ["User Preferences:"];

  for (const [type, prefs] of Object.entries(byType)) {
    lines.push(`  ${type}:`);
    for (const pref of prefs) {
      lines.push(
        `    - ${pref.preferenceKey}: ${pref.preferenceValue} (confidence: ${pref.confidence.toFixed(2)})`,
      );
    }
  }

  return lines.join("\n");
}
