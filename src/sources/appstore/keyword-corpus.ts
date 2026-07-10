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

// The full modifier vocabulary. NOT every noun is crossed with every one of
// these — see `n()` below. "free"/"pro"/"app" are generic enough to suffix
// almost any noun sensibly; "tracker"/"planner"/"widget"/"for beginners"
// only make sense for nouns that are actually trackable, plannable,
// glanceable, or learnable, so each noun opts into those explicitly.
export const MODIFIERS: readonly string[] = [
  "free",
  "pro",
  "app",
  "tracker",
  "planner",
  "widget",
  "for beginners",
];

/** Modifiers safe to append to virtually any noun ("X free", "X pro", "X app"). */
const BASE_MODIFIERS: readonly string[] = ["free", "pro", "app"];

interface NounEntry {
  readonly noun: string;
  /** BASE_MODIFIERS plus any noun-specific extras opted into via `n()`. */
  readonly modifiers: readonly string[];
}

/**
 * Builds a noun's modifier allowlist: always BASE_MODIFIERS, plus whichever
 * of "tracker" / "planner" / "widget" / "for beginners" actually make
 * sense for this noun. This is the curation step that keeps the corpus
 * from crossing every noun with every modifier — e.g. "vpn" never opts
 * into "planner", so "vpn planner" is never generated.
 */
function n(noun: string, extra: readonly string[] = []): NounEntry {
  return { noun, modifiers: extra.length === 0 ? BASE_MODIFIERS : [...BASE_MODIFIERS, ...extra] };
}

interface ZoneSeed {
  readonly nouns: readonly NounEntry[];
  readonly longTail: readonly string[];
}

/**
 * Base nouns and hand-picked long-tail phrases per genre zone. Each noun
 * carries its own modifier allowlist (via `n()`) rather than being crossed
 * with every entry in MODIFIERS, so only sensible combinations are
 * generated ("workout tracker", not "vpn planner"); longTail entries are
 * added verbatim. Kept focused (10–25 nouns/zone) — this is a seed, not the
 * final corpus.
 */
const SEED_TABLE: Record<string, ZoneSeed> = {
  health: {
    nouns: [
      n("workout", ["tracker", "planner", "for beginners"]),
      n("diet", ["tracker", "planner", "for beginners"]),
      n("calorie", ["tracker", "widget"]),
      n("sleep", ["tracker", "widget"]),
      n("meditation", ["tracker", "for beginners"]),
      n("yoga", ["tracker", "for beginners"]),
      n("fitness", ["tracker", "planner", "for beginners"]),
      n("nutrition", ["tracker", "planner"]),
      n("symptom", ["tracker"]),
      n("medication", ["tracker"]),
      n("fasting", ["tracker", "planner"]),
      n("hydration", ["tracker", "widget"]),
      n("step counter", ["widget"]),
      n("heart rate", ["tracker", "widget"]),
      n("blood pressure", ["tracker", "widget"]),
    ],
    longTail: ["fatty liver diet", "workout plan for beginners", "meal prep for weight loss"],
  },
  finance: {
    nouns: [
      n("budget", ["tracker", "planner"]),
      n("expense", ["tracker"]),
      n("invoice", ["tracker"]),
      n("tax", ["planner"]),
      n("investment", ["tracker", "planner"]),
      n("stock", ["tracker", "widget"]),
      n("crypto", ["tracker"]),
      n("savings", ["tracker", "planner"]),
      n("debt payoff", ["tracker", "planner"]),
      n("credit score", ["tracker", "widget"]),
      n("net worth", ["tracker", "widget"]),
      n("retirement", ["planner"]),
      n("portfolio", ["tracker", "widget"]),
      n("receipt", ["tracker"]),
      n("bill", ["tracker", "widget"]),
    ],
    longTail: ["budget planner for couples", "expense tracker for freelancers"],
  },
  productivity: {
    nouns: [
      n("task", ["tracker", "planner"]),
      n("habit", ["tracker", "for beginners"]),
      n("focus", ["tracker", "widget"]),
      n("note", ["widget"]),
      n("calendar", ["widget"]),
      n("reminder", ["widget"]),
      n("to do list", ["widget"]),
      n("time tracker", ["widget"]),
      n("project", ["tracker", "planner"]),
      n("goal", ["tracker", "planner"]),
      n("pomodoro", ["widget"]),
      n("journal", ["for beginners"]),
      n("checklist"),
      n("schedule", ["planner", "widget"]),
    ],
    longTail: ["habit tracker for students", "time blocking planner"],
  },
  business: {
    nouns: [
      n("invoice generator"),
      n("crm"),
      n("payroll"),
      n("inventory", ["tracker"]),
      n("expense report", ["tracker"]),
      n("contract"),
      n("proposal"),
      n("client", ["tracker"]),
      n("point of sale"),
      n("employee", ["tracker"]),
      n("shift", ["tracker", "planner"]),
      n("timesheet", ["tracker"]),
      n("sales tracker"),
    ],
    longTail: ["invoice generator for small business", "scheduling app for teams"],
  },
  lifestyle: {
    nouns: [
      n("journal", ["for beginners"]),
      n("mood", ["tracker"]),
      n("gratitude", ["tracker"]),
      n("affirmation"),
      n("self care", ["planner"]),
      n("morning routine", ["tracker", "planner"]),
      n("vision board"),
      n("wellness", ["tracker"]),
      n("minimalism", ["for beginners"]),
      n("declutter", ["planner"]),
    ],
    longTail: ["morning routine planner", "self care journal for women"],
  },
  food: {
    nouns: [
      n("recipe"),
      n("meal plan"),
      n("grocery list", ["widget"]),
      n("cooking", ["for beginners"]),
      n("nutrition label"),
      n("restaurant finder"),
      n("coffee"),
      n("wine"),
      n("baking", ["for beginners"]),
      n("meal prep", ["planner"]),
      n("food diary"),
    ],
    longTail: ["meal plan for weight loss", "grocery list organizer"],
  },
  education: {
    nouns: [
      n("flashcard"),
      n("study planner"),
      n("quiz"),
      n("language learning", ["for beginners"]),
      n("math practice", ["for beginners"]),
      n("vocabulary", ["for beginners"]),
      n("exam prep", ["planner"]),
      n("homework", ["tracker", "planner"]),
      n("note taking", ["for beginners"]),
      n("reading tracker"),
      n("tutor"),
    ],
    longTail: ["study planner for exams", "flashcard app for language learning"],
  },
  utilities: {
    nouns: [
      n("file manager"),
      n("qr code"),
      n("pdf editor"),
      n("password manager"),
      n("flashlight"),
      n("unit converter", ["widget"]),
      n("document scanner"),
      n("clipboard", ["widget"]),
      n("battery saver", ["widget"]),
      n("storage cleaner"),
      n("vpn"),
    ],
    longTail: ["pdf editor for contracts", "qr code scanner offline"],
  },
  photo: {
    nouns: [
      n("photo editor", ["for beginners"]),
      n("collage maker"),
      n("filter"),
      n("photo organizer"),
      n("background remover"),
      n("photo restoration"),
      n("wallpaper", ["widget"]),
      n("screenshot"),
      n("gif maker"),
      n("photo album"),
    ],
    longTail: ["photo editor for portraits", "collage maker for instagram"],
  },
  parenting: {
    nouns: [
      n("baby tracker"),
      n("feeding schedule", ["tracker"]),
      n("sleep training", ["for beginners"]),
      n("parenting tips", ["for beginners"]),
      n("growth chart", ["tracker"]),
      n("potty training", ["for beginners"]),
      n("screen time", ["tracker", "widget"]),
      n("family calendar", ["widget"]),
      n("chore chart", ["planner"]),
      n("kids activities"),
    ],
    longTail: ["baby tracker for newborns", "screen time control for kids"],
  },
  social: {
    nouns: [
      n("dating"),
      n("chat"),
      n("video call"),
      n("social feed"),
      n("friend finder"),
      n("icebreaker"),
      n("profile"),
      n("community"),
      n("meetup", ["planner"]),
      n("messaging"),
    ],
    longTail: ["dating app for professionals", "icebreaker games for friends"],
  },
  travel: {
    nouns: [
      n("itinerary", ["planner"]),
      n("flight tracker"),
      n("packing list", ["planner"]),
      n("trip planner"),
      n("travel budget", ["tracker", "planner"]),
      n("language translator"),
      n("offline map"),
      n("hotel booking"),
      n("currency converter", ["widget"]),
      n("road trip", ["planner"]),
    ],
    longTail: ["trip planner for couples", "packing list for backpacking"],
  },
  sports: {
    nouns: [
      n("workout log"),
      n("running tracker", ["for beginners"]),
      n("cycling tracker"),
      n("gym log", ["tracker"]),
      n("sports score", ["widget"]),
      n("fantasy league"),
      n("golf tracker"),
      n("swim tracker", ["for beginners"]),
      n("training plan"),
      n("yoga poses", ["for beginners"]),
    ],
    longTail: ["running tracker for beginners", "gym log with progress photos"],
  },
  entertainment: {
    nouns: [
      n("movie tracker"),
      n("tv show tracker"),
      n("book tracker"),
      n("trivia"),
      n("puzzle"),
      n("music discovery"),
      n("podcast"),
      n("watchlist", ["widget"]),
      n("karaoke"),
      n("streaming guide"),
    ],
    longTail: ["movie tracker with reviews", "book tracker for readers"],
  },
  reference: {
    nouns: [
      n("dictionary", ["widget"]),
      n("encyclopedia"),
      n("thesaurus"),
      n("citation generator"),
      n("periodic table", ["widget"]),
      n("converter", ["widget"]),
      n("calculator", ["widget"]),
      n("trivia facts"),
      n("law reference"),
      n("medical reference"),
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
 * nouns with each noun's own curated modifier allowlist ("noun modifier")
 * and appends its hand-picked long-tail phrases. Rows are normalized and
 * globally deduped by keyword (first zone to produce a keyword wins).
 * Calling this repeatedly returns an identical array — no randomness, no
 * wall-clock reads.
 */
export function buildSeedCorpus(): readonly KeywordSeedRow[] {
  const rows: KeywordSeedRow[] = [];
  const seen = new Set<string>();

  for (const zone of GENRE_ZONES) {
    const entry = SEED_TABLE[zone];
    if (entry === undefined) continue;

    for (const { noun, modifiers } of entry.nouns) {
      for (const modifier of modifiers) {
        addRow(rows, seen, `${noun} ${modifier}`, zone);
      }
    }
    for (const phrase of entry.longTail) {
      addRow(rows, seen, phrase, zone);
    }
  }

  return rows;
}
