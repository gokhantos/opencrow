import type { LucideIcon } from "lucide-react";
import {
  Home,
  Bot,
  MessageSquare,
  Hash,
  Wrench,
  AtSign,
  Rocket,
  Flame,
  MessageCircle,
  Github,
  GraduationCap,
  Newspaper,
  TrendingUp,
  Lightbulb,
  Clock,
  Activity,
  FileText,
  Server,
  BarChart3,
  GitBranch,
  Brain,
  Smartphone,
  Settings,
  MessagesSquare,
  Workflow,
} from "lucide-react";

export type Tab =
  | "overview"
  | "chat"
  | "agents"
  | "skills"
  | "sessions"
  | "channels"
  | "x-accounts"
  | "producthunt"
  | "hackernews"
  | "reddit"
  | "github"
  | "appstore"
  | "playstore"
  | "news"
  | "markets"
  | "ideas"
  | "cron"
  | "processes"
  | "system"
  | "tools"
  | "agent-metrics"
  | "routing"
  | "memory"
  | "logs"
  | "settings"
  | "workflows";

export interface NavItem {
  readonly id: Tab;
  readonly label: string;
  readonly Icon: LucideIcon;
}

export interface NavSection {
  readonly title: string;
  readonly collapsible: boolean;
  readonly items: readonly NavItem[];
}

export const VALID_TABS = new Set<Tab>([
  "overview", "chat", "agents", "skills", "sessions", "channels",
  "x-accounts", "producthunt", "hackernews", "reddit",
  "github", "appstore", "playstore",
  "news", "markets", "ideas", "cron",
  "processes", "system", "tools", "agent-metrics", "routing",
  "memory", "logs", "settings", "workflows",
]);

export const TAB_TITLES: Record<Tab, string> = {
  overview: "Overview",
  chat: "Chat",
  agents: "Agents",
  skills: "Skills",
  sessions: "Sessions",
  channels: "Channels",
  "x-accounts": "X / Twitter",
  producthunt: "Product Hunt",
  hackernews: "Hacker News",
  reddit: "Reddit",
  github: "GitHub",
  appstore: "App Store",
  playstore: "Play Store",
  news: "News Feed",
  markets: "Markets",
  ideas: "Ideas",
  cron: "Cron",
  processes: "Processes",
  system: "Metrics",
  tools: "Tools",
  "agent-metrics": "Agent Metrics",
  routing: "Routing",
  memory: "Memory",
  logs: "Logs",
  settings: "Settings",
  workflows: "Workflows",
};

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    title: "Dashboard",
    collapsible: false,
    items: [{ id: "overview", label: "Overview", Icon: Home }],
  },
  {
    title: "Agents",
    collapsible: false,
    items: [
      { id: "chat", label: "Chat", Icon: MessagesSquare },
      { id: "agents", label: "Agents", Icon: Bot },
      { id: "skills", label: "Skills", Icon: GraduationCap },
      { id: "tools", label: "Tools", Icon: Wrench },
      { id: "agent-metrics", label: "Agent Metrics", Icon: BarChart3 },
      { id: "sessions", label: "Sessions", Icon: MessageSquare },
      { id: "routing", label: "Routing", Icon: GitBranch },
      { id: "channels", label: "Channels", Icon: Hash },
      { id: "workflows", label: "Workflows", Icon: Workflow },
    ],
  },
  {
    title: "Sources",
    collapsible: true,
    items: [
      { id: "x-accounts", label: "X / Twitter", Icon: AtSign },
      { id: "producthunt", label: "Product Hunt", Icon: Rocket },
      { id: "hackernews", label: "Hacker News", Icon: Flame },
      { id: "reddit", label: "Reddit", Icon: MessageCircle },
      { id: "github", label: "GitHub", Icon: Github },
      { id: "appstore", label: "App Store", Icon: Smartphone },
      { id: "playstore", label: "Play Store", Icon: Smartphone },
    ],
  },
  {
    title: "Intelligence",
    collapsible: true,
    items: [
      { id: "news", label: "News Feed", Icon: Newspaper },
      { id: "markets", label: "Markets", Icon: TrendingUp },
      { id: "ideas", label: "Ideas", Icon: Lightbulb },
      { id: "memory", label: "Memory", Icon: Brain },
    ],
  },
  {
    title: "System",
    collapsible: true,
    items: [
      { id: "cron", label: "Cron", Icon: Clock },
      { id: "processes", label: "Processes", Icon: Server },
      { id: "system", label: "Metrics", Icon: Activity },
      { id: "logs", label: "Logs", Icon: FileText },
      { id: "settings", label: "Settings", Icon: Settings },
    ],
  },
];
