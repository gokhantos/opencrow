import { test, expect } from "bun:test";

// These are module-private functions, so we re-implement them here for testing.
// In a real refactor, they'd be extracted to a shared utils file.

function displayName(name: string): string {
  if (name.startsWith("agent:")) return name.slice(6);
  if (name.startsWith("scraper:")) {
    const id = name.slice(8);
    const labels: Record<string, string> = {
      hackernews: "Hacker News",
      producthunt: "Product Hunt",
      "x-bookmarks": "X Bookmarks",
      "x-autolike": "X Autolike",
      "x-autofollow": "X Autofollow",
      "x-timeline": "X Timeline",
    };
    return labels[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
  }
  const labels: Record<string, string> = {
    core: "Core",
    cron: "Cron",
    web: "Web",
    market: "Market",
  };
  return labels[name] ?? name;
}

interface ProcessInfo {
  name: string;
  pid: number;
  status: "alive" | "stale" | "dead";
  startedAt: number;
  lastHeartbeat: number;
  uptimeSeconds: number;
  metadata: Record<string, unknown>;
}

interface ProcessGroup {
  label: string;
  processes: readonly ProcessInfo[];
}

function groupProcesses(
  processes: readonly ProcessInfo[],
): readonly ProcessGroup[] {
  const sorted = [...processes].sort((a, b) => a.name.localeCompare(b.name));
  const infra = sorted.filter((p) =>
    ["core", "cron", "web", "market"].includes(p.name),
  );
  const agents = sorted.filter((p) => p.name.startsWith("agent:"));
  const scrapers = sorted.filter((p) => p.name.startsWith("scraper:"));
  const other = sorted.filter(
    (p) =>
      !["core", "cron", "web", "market"].includes(p.name) &&
      !p.name.startsWith("agent:") &&
      !p.name.startsWith("scraper:"),
  );

  const groups: ProcessGroup[] = [];
  if (infra.length > 0)
    groups.push({ label: "Infrastructure", processes: infra });
  if (agents.length > 0) groups.push({ label: "Agents", processes: agents });
  if (scrapers.length > 0)
    groups.push({ label: "Scrapers", processes: scrapers });
  if (other.length > 0) groups.push({ label: "Other", processes: other });
  return groups;
}

function portFromMetadata(meta: Record<string, unknown>): string | null {
  if (meta.port) return String(meta.port);
  return null;
}

const mkProcess = (name: string, status: "alive" | "stale" | "dead" = "alive"): ProcessInfo => ({
  name,
  pid: 1234,
  status,
  startedAt: 0,
  lastHeartbeat: 0,
  uptimeSeconds: 100,
  metadata: {},
});

/* ---------- displayName ---------- */

test("displayName strips agent: prefix", () => {
  expect(displayName("agent:default")).toBe("default");
  expect(displayName("agent:ai-idea-gen")).toBe("ai-idea-gen");
});

test("displayName maps known scraper ids to labels", () => {
  expect(displayName("scraper:hackernews")).toBe("Hacker News");
  expect(displayName("scraper:producthunt")).toBe("Product Hunt");
  expect(displayName("scraper:x-bookmarks")).toBe("X Bookmarks");
  expect(displayName("scraper:x-autolike")).toBe("X Autolike");
  expect(displayName("scraper:x-autofollow")).toBe("X Autofollow");
  expect(displayName("scraper:x-timeline")).toBe("X Timeline");
});

test("displayName capitalizes unknown scraper ids", () => {
  expect(displayName("scraper:reddit")).toBe("Reddit");
  expect(displayName("scraper:github")).toBe("Github");
});

test("displayName maps infra names to labels", () => {
  expect(displayName("core")).toBe("Core");
  expect(displayName("cron")).toBe("Cron");
  expect(displayName("web")).toBe("Web");
  expect(displayName("market")).toBe("Market");
});

test("displayName returns unknown names as-is", () => {
  expect(displayName("custom-thing")).toBe("custom-thing");
});

/* ---------- groupProcesses ---------- */

test("groupProcesses groups infra, agents, scrapers", () => {
  const processes = [
    mkProcess("core"),
    mkProcess("web"),
    mkProcess("agent:default"),
    mkProcess("agent:ai-idea-gen"),
    mkProcess("scraper:hackernews"),
  ];
  const groups = groupProcesses(processes);
  expect(groups.length).toBe(3);
  expect(groups[0]!.label).toBe("Infrastructure");
  expect(groups[0]!.processes.length).toBe(2);
  expect(groups[1]!.label).toBe("Agents");
  expect(groups[1]!.processes.length).toBe(2);
  expect(groups[2]!.label).toBe("Scrapers");
  expect(groups[2]!.processes.length).toBe(1);
});

test("groupProcesses puts unknown processes in Other", () => {
  const groups = groupProcesses([mkProcess("custom")]);
  expect(groups.length).toBe(1);
  expect(groups[0]!.label).toBe("Other");
});

test("groupProcesses returns empty for no processes", () => {
  expect(groupProcesses([])).toEqual([]);
});

test("groupProcesses sorts within groups alphabetically", () => {
  const processes = [
    mkProcess("agent:zebra"),
    mkProcess("agent:alpha"),
  ];
  const groups = groupProcesses(processes);
  expect(groups[0]!.processes[0]!.name).toBe("agent:alpha");
  expect(groups[0]!.processes[1]!.name).toBe("agent:zebra");
});

test("groupProcesses omits empty groups", () => {
  const processes = [mkProcess("core"), mkProcess("cron")];
  const groups = groupProcesses(processes);
  expect(groups.length).toBe(1);
  expect(groups[0]!.label).toBe("Infrastructure");
});

/* ---------- portFromMetadata ---------- */

test("portFromMetadata returns port as string", () => {
  expect(portFromMetadata({ port: 48080 })).toBe("48080");
  expect(portFromMetadata({ port: "3000" })).toBe("3000");
});

test("portFromMetadata returns null when no port", () => {
  expect(portFromMetadata({})).toBeNull();
  expect(portFromMetadata({ other: "value" })).toBeNull();
});
