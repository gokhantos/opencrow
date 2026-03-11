import React, { useState, useEffect } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ToastProvider } from "./components/Toast";
import { createRoot } from "react-dom/client";
import { Menu } from "lucide-react";

export type Theme = "dark" | "light";
import {
  apiFetch,
  getToken,
  setToken,
  clearToken,
  initTokenFromUrl,
} from "./api";
import type { Tab } from "./navigation";
import { VALID_TABS, TAB_TITLES } from "./navigation";
import Sidebar from "./components/Sidebar";
import Overview from "./views/Overview";
import Channels from "./views/Channels";
import Sessions from "./views/Sessions";
import Logs from "./views/Logs";
import Chat from "./views/Chat";
import Agents from "./views/agents/Agents";
import Cron from "./views/Cron";
import Markets from "./views/Markets";
import SystemMetrics from "./views/SystemMetrics";
import XAccounts from "./views/x-accounts/XAccounts";
import ProductHunt from "./views/ProductHunt";
import HackerNews from "./views/HackerNews";
import Reddit from "./views/Reddit";
import News from "./views/News";
import Ideas from "./views/Ideas";
import GitHub from "./views/GitHub";
import Processes from "./views/Processes";
import Skills from "./views/Skills";
import Tools from "./views/Tools";
import AgentMetrics from "./views/AgentMetrics";
import RoutingRules from "./views/RoutingRules";
import Memory from "./views/Memory";
import AppStore from "./views/AppStore";
import PlayStore from "./views/PlayStore";
import Settings from "./views/Settings";

interface StatusResponse {
  uptime: number;
  authEnabled: boolean;
  version: string;
  sessions: number;
  channels: Record<string, { status: string; type: string }>;
  agents: number;
  cron: { running: boolean; jobCount: number; nextDueAt: number | null } | null;
}

function TokenModal({ onSuccess }: { onSuccess: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setLoading(true);
    setError("");
    setToken(value.trim());
    try {
      await apiFetch<StatusResponse>("/api/status");
      onSuccess();
    } catch {
      clearToken();
      setError("Invalid token. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-bg">
      <div className="bg-bg-1 border border-border-2 rounded-xl p-10 w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8">
          <img src="/logo.png" alt="OpenCrow" className="w-10 h-10 shrink-0" />
          <div>
            <h1 className="text-2xl font-bold text-strong tracking-tight leading-none">
              OpenCrow
            </h1>
            <p className="text-muted text-sm mt-1">
              Enter your access token to continue.
            </p>
          </div>
        </div>
        {error && (
          <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-base mb-5">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="mb-5">
            <label
              className="block text-sm font-semibold text-muted uppercase tracking-wide mb-2"
              htmlFor="token-input"
            >
              Access Token
            </label>
            <input
              id="token-input"
              className="w-full bg-bg border-2 border-border-2 rounded-lg px-4 py-3 text-foreground text-base outline-none transition-colors duration-150 focus:border-accent placeholder:text-faint"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Enter token..."
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="w-full bg-accent text-white rounded-lg px-4 py-3 text-base font-semibold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50 border-none"
            disabled={loading}
          >
            {loading ? (
              <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              "Continue"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function tabFromHash(): Tab {
  const hash = location.hash.slice(1);
  return VALID_TABS.has(hash as Tab) ? (hash as Tab) : "overview";
}

/** Map scraper IDs to their corresponding nav tab IDs */
const SCRAPER_TO_TAB: Record<string, Tab> = {
  hackernews: "hackernews",
  reddit: "reddit",
  github: "github",
  producthunt: "producthunt",
  appstore: "appstore",
  playstore: "playstore",
  news: "news",
  x: "x-accounts",
  ideas: "ideas",
};

interface FeaturesState {
  readonly enabledScrapers: ReadonlySet<string>;
  readonly qdrantEnabled: boolean;
  readonly marketEnabled: boolean;
}

function computeHiddenTabs(features: FeaturesState | null): ReadonlySet<Tab> {
  if (!features) return new Set();
  const hidden = new Set<Tab>();

  // Hide scraper tabs when that scraper is disabled
  for (const [scraperId, tabId] of Object.entries(SCRAPER_TO_TAB)) {
    if (!features.enabledScrapers.has(scraperId)) {
      hidden.add(tabId);
    }
  }

  // Hide memory tab when Qdrant/RAG is disabled
  if (!features.qdrantEnabled) {
    hidden.add("memory");
  }

  // Hide markets tab when market feature is disabled
  if (!features.marketEnabled) {
    hidden.add("markets");
  }

  return hidden;
}

function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [authState, setAuthState] = useState<"loading" | "ok" | "needed">(
    "loading",
  );
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem("opencrow-theme") as Theme) || "dark";
  });
  const [features, setFeatures] = useState<FeaturesState | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("opencrow-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = `${TAB_TITLES[tab]} — OpenCrow`;
  }, [tab]);

  useEffect(() => {
    initTokenFromUrl();
    checkAuth();
  }, []);

  // Re-fetch features when settings change
  useEffect(() => {
    function onFeaturesChanged() {
      fetchFeatures();
    }
    window.addEventListener("features-changed", onFeaturesChanged);
    return () => window.removeEventListener("features-changed", onFeaturesChanged);
  }, []);

  function navigateTo(newTab: Tab) {
    location.hash = newTab;
    setTab(newTab);
  }

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  async function fetchFeatures() {
    try {
      const res = await apiFetch<{
        data: {
          scrapers: { enabled: string[] };
          qdrant: { enabled: boolean };
          market: { enabled: boolean };
        };
      }>("/api/features");
      setFeatures({
        enabledScrapers: new Set(res.data.scrapers.enabled),
        qdrantEnabled: res.data.qdrant.enabled,
        marketEnabled: res.data.market.enabled,
      });
    } catch {
      // Non-critical — show all tabs if features can't be loaded
    }
  }

  async function checkAuth() {
    try {
      await apiFetch<StatusResponse>("/api/status");
      setAuthState("ok");
      fetchFeatures();
    } catch (err: unknown) {
      const apiErr = err as { status?: number };
      if (apiErr?.status === 401) {
        setAuthState("needed");
      } else {
        setAuthState("ok");
        fetchFeatures();
      }
    }
  }

  function handleLogout() {
    clearToken();
    setAuthState("needed");
  }

  if (authState === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <span className="w-7 h-7 border-2 border-border-2 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (authState === "needed") {
    return <TokenModal onSuccess={() => setAuthState("ok")} />;
  }

  const hasToken = Boolean(getToken());
  const hiddenTabs = computeHiddenTabs(features);

  return (
    <div className="grid grid-cols-[230px_minmax(0,1fr)] max-lg:grid-cols-[56px_minmax(0,1fr)] max-md:grid-cols-[1fr] h-screen overflow-hidden bg-bg">
      {/* Mobile-only top bar */}
      <div className="hidden max-md:flex items-center gap-3 fixed top-0 left-0 right-0 h-[52px] bg-bg border-b border-border px-4 z-[200]">
        <button
          className="flex items-center justify-center w-9 h-9 shrink-0 border-none rounded-md bg-transparent text-foreground cursor-pointer hover:bg-bg-2 transition-colors"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
        >
          <Menu size={20} />
        </button>
        <img src="/logo.png" alt="OpenCrow" className="w-7 h-7 shrink-0" />
        <span className="text-base font-semibold text-strong tracking-tight">
          OpenCrow
        </span>
      </div>

      <Sidebar
        activeTab={tab}
        onSelect={navigateTo}
        hiddenTabs={hiddenTabs}
        showSignOut={hasToken}
        onSignOut={handleLogout}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        theme={theme}
        onThemeToggle={toggleTheme}
      />

      <main className="overflow-y-auto max-md:pt-[52px]">
        <ErrorBoundary key={tab} onReset={() => navigateTo(tab)}>
          <div
            className="px-8 py-7 max-lg:px-6 max-lg:py-6 max-md:px-4 max-md:py-5"
          >
            {tab === "overview" && <Overview />}
            {tab === "channels" && <Channels />}
            {tab === "sessions" && <Sessions />}
            {tab === "chat" && <Chat />}
            {tab === "agents" && <Agents />}
            {tab === "skills" && <Skills />}
            {tab === "tools" && <Tools />}
            {tab === "cron" && <Cron />}
            {tab === "markets" && <Markets />}
            {tab === "x-accounts" && <XAccounts />}
            {tab === "producthunt" && <ProductHunt />}
            {tab === "hackernews" && <HackerNews />}
            {tab === "reddit" && <Reddit />}
            {tab === "github" && <GitHub />}
            {tab === "appstore" && <AppStore />}
            {tab === "playstore" && <PlayStore />}
            {tab === "news" && <News />}
            {tab === "ideas" && <Ideas />}
            {tab === "memory" && <Memory />}
            {tab === "processes" && <Processes />}
            {tab === "routing" && <RoutingRules />}
            {tab === "agent-metrics" && <AgentMetrics />}
            {tab === "system" && <SystemMetrics />}
            {tab === "logs" && <Logs />}
            {tab === "settings" && <Settings />}
          </div>
        </ErrorBoundary>
      </main>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <ToastProvider>
    <App />
  </ToastProvider>
);
