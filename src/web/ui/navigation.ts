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
  Cpu,
  Github,
  GraduationCap,
  Newspaper,
  TrendingUp,
  Lightbulb,
  Clock,
  Activity,
  FileText,
  Server,
  Coins,
  BarChart3,
  GitBranch,
  Brain,
  AlertTriangle,
  Smartphone,
} from "lucide-react";

export type Tab =
  | "overview"
  | "agents"
  | "skills"
  | "sessions"
  | "channels"
  | "x-accounts"
  | "producthunt"
  | "hackernews"
  | "reddit"
  | "huggingface"
  | "github"
  | "google-trends"
  | "appstore"
  | "playstore"
  | "news"
  | "markets"
  | "ideas"
  | "cron"
  | "processes"
  | "system"
  | "tools"
  | "usage"
  | "agent-metrics"
  | "routing"
  | "memory"
  | "failures"
  | "logs";

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
  "overview", "agents", "skills", "sessions", "channels",
  "x-accounts", "producthunt", "hackernews", "reddit", "huggingface",
  "github", "google-trends", "appstore", "playstore",
  "news", "markets", "ideas", "cron",
  "processes", "system", "tools", "usage", "agent-metrics", "routing",
  "memory", "failures", "logs",
]);

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
      { id: "agents", label: "Agents", Icon: Bot },
      { id: "skills", label: "Skills", Icon: GraduationCap },
      { id: "tools", label: "Tools", Icon: Wrench },
      { id: "agent-metrics", label: "Agent Metrics", Icon: BarChart3 },
      { id: "sessions", label: "Sessions", Icon: MessageSquare },
      { id: "routing", label: "Routing", Icon: GitBranch },
      { id: "channels", label: "Channels", Icon: Hash },
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
      { id: "huggingface", label: "HuggingFace", Icon: Cpu },
      { id: "github", label: "GitHub", Icon: Github },
      { id: "google-trends", label: "Google Trends", Icon: Search },
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
      { id: "usage", label: "Usage", Icon: Coins },
      { id: "failures", label: "Failures", Icon: AlertTriangle },
      { id: "system", label: "Metrics", Icon: Activity },
      { id: "logs", label: "Logs", Icon: FileText },
    ],
  },
];
