// Pure, deterministic keyword seed-corpus generator for the App Store
// keyword-gap scanner. No database, no network — a fixed noun/modifier/
// long-tail table crossed into normalized, deduped KeywordSeedRow entries.
// The autocomplete loop (later task) grows this corpus at runtime; this file
// only ever produces the same array given the same inputs (no Math.random,
// no Date).

import type { KeywordSeedRow } from "./keyword-store";

export const GENRE_ZONES: readonly string[] = [
  "health",
  "finance",
  "productivity",
  "business",
  "lifestyle",
  "food",
  "education",
  "utilities",
  "photo",
  "parenting",
  "social",
  "travel",
  "sports",
  "entertainment",
  "reference",
];

export const MODIFIERS: readonly string[] = [
  "free",
  "pro",
  "app",
  "tracker",
  "planner",
  "widget",
  "for beginners",
];

interface ZoneSeed {
  readonly nouns: readonly string[];
  readonly longTail: readonly string[];
}

/**
 * Base nouns and hand-picked long-tail phrases per genre zone. Nouns are
 * crossed with MODIFIERS ("noun modifier") to build the bulk of the corpus;
 * longTail entries are added verbatim. Kept focused (10–25 nouns/zone) —
 * this is a seed, not the final corpus.
 */
const SEED_TABLE: Record<string, ZoneSeed> = {
  health: {
    nouns: [
      "workout",
      "diet",
      "calorie",
      "sleep",
      "meditation",
      "yoga",
      "fitness",
      "nutrition",
      "symptom",
      "medication",
      "fasting",
      "hydration",
      "step counter",
      "heart rate",
      "blood pressure",
    ],
    longTail: ["fatty liver diet", "workout plan for beginners", "meal prep for weight loss"],
  },
  finance: {
    nouns: [
      "budget",
      "expense",
      "invoice",
      "tax",
      "investment",
      "stock",
      "crypto",
      "savings",
      "debt payoff",
      "credit score",
      "net worth",
      "retirement",
      "portfolio",
      "receipt",
      "bill",
    ],
    longTail: ["budget planner for couples", "expense tracker for freelancers"],
  },
  productivity: {
    nouns: [
      "task",
      "habit",
      "focus",
      "note",
      "calendar",
      "reminder",
      "to do list",
      "time tracker",
      "project",
      "goal",
      "pomodoro",
      "journal",
      "checklist",
      "schedule",
    ],
    longTail: ["habit tracker for students", "time blocking planner"],
  },
  business: {
    nouns: [
      "invoice generator",
      "crm",
      "payroll",
      "inventory",
      "expense report",
      "contract",
      "proposal",
      "client",
      "point of sale",
      "employee",
      "shift",
      "timesheet",
      "sales tracker",
    ],
    longTail: ["invoice generator for small business", "scheduling app for teams"],
  },
  lifestyle: {
    nouns: [
      "journal",
      "mood",
      "gratitude",
      "affirmation",
      "self care",
      "morning routine",
      "vision board",
      "wellness",
      "minimalism",
      "declutter",
    ],
    longTail: ["morning routine planner", "self care journal for women"],
  },
  food: {
    nouns: [
      "recipe",
      "meal plan",
      "grocery list",
      "cooking",
      "nutrition label",
      "restaurant finder",
      "coffee",
      "wine",
      "baking",
      "meal prep",
      "food diary",
    ],
    longTail: ["meal plan for weight loss", "grocery list organizer"],
  },
  education: {
    nouns: [
      "flashcard",
      "study planner",
      "quiz",
      "language learning",
      "math practice",
      "vocabulary",
      "exam prep",
      "homework",
      "note taking",
      "reading tracker",
      "tutor",
    ],
    longTail: ["study planner for exams", "flashcard app for language learning"],
  },
  utilities: {
    nouns: [
      "file manager",
      "qr code",
      "pdf editor",
      "password manager",
      "flashlight",
      "unit converter",
      "document scanner",
      "clipboard",
      "battery saver",
      "storage cleaner",
      "vpn",
    ],
    longTail: ["pdf editor for contracts", "qr code scanner offline"],
  },
  photo: {
    nouns: [
      "photo editor",
      "collage maker",
      "filter",
      "photo organizer",
      "background remover",
      "photo restoration",
      "wallpaper",
      "screenshot",
      "gif maker",
      "photo album",
    ],
    longTail: ["photo editor for portraits", "collage maker for instagram"],
  },
  parenting: {
    nouns: [
      "baby tracker",
      "feeding schedule",
      "sleep training",
      "parenting tips",
      "growth chart",
      "potty training",
      "screen time",
      "family calendar",
      "chore chart",
      "kids activities",
    ],
    longTail: ["baby tracker for newborns", "screen time control for kids"],
  },
  social: {
    nouns: [
      "dating",
      "chat",
      "video call",
      "social feed",
      "friend finder",
      "icebreaker",
      "profile",
      "community",
      "meetup",
      "messaging",
    ],
    longTail: ["dating app for professionals", "icebreaker games for friends"],
  },
  travel: {
    nouns: [
      "itinerary",
      "flight tracker",
      "packing list",
      "trip planner",
      "travel budget",
      "language translator",
      "offline map",
      "hotel booking",
      "currency converter",
      "road trip",
    ],
    longTail: ["trip planner for couples", "packing list for backpacking"],
  },
  sports: {
    nouns: [
      "workout log",
      "running tracker",
      "cycling tracker",
      "gym log",
      "sports score",
      "fantasy league",
      "golf tracker",
      "swim tracker",
      "training plan",
      "yoga poses",
    ],
    longTail: ["running tracker for beginners", "gym log with progress photos"],
  },
  entertainment: {
    nouns: [
      "movie tracker",
      "tv show tracker",
      "book tracker",
      "trivia",
      "puzzle",
      "music discovery",
      "podcast",
      "watchlist",
      "karaoke",
      "streaming guide",
    ],
    longTail: ["movie tracker with reviews", "book tracker for readers"],
  },
  reference: {
    nouns: [
      "dictionary",
      "encyclopedia",
      "thesaurus",
      "citation generator",
      "periodic table",
      "converter",
      "calculator",
      "trivia facts",
      "law reference",
      "medical reference",
    ],
    longTail: ["dictionary offline no ads", "citation generator apa"],
  },
};

/** Lowercase, trim, and collapse internal whitespace to single spaces. */
function normalize(keyword: string): string {
  return keyword.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Push a normalized keyword row if it hasn't been seen yet (global dedupe). */
function addRow(
  rows: KeywordSeedRow[],
  seen: Set<string>,
  rawKeyword: string,
  genreZone: string,
): void {
  const keyword = normalize(rawKeyword);
  if (seen.has(keyword)) return;
  seen.add(keyword);
  rows.push({ keyword, genreZone, source: "seed" });
}

/**
 * Deterministic seed corpus: for every genre zone, crosses that zone's base
 * nouns with MODIFIERS ("noun modifier") and appends its hand-picked
 * long-tail phrases. Rows are normalized and globally deduped by keyword
 * (first zone to produce a keyword wins). Calling this repeatedly returns an
 * identical array — no randomness, no wall-clock reads.
 */
export function buildSeedCorpus(): readonly KeywordSeedRow[] {
  const rows: KeywordSeedRow[] = [];
  const seen = new Set<string>();

  for (const zone of GENRE_ZONES) {
    const entry = SEED_TABLE[zone];
    if (entry === undefined) continue;

    for (const noun of entry.nouns) {
      for (const modifier of MODIFIERS) {
        addRow(rows, seen, `${noun} ${modifier}`, zone);
      }
    }
    for (const phrase of entry.longTail) {
      addRow(rows, seen, phrase, zone);
    }
  }

  return rows;
}
