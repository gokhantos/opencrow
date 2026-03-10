import React from "react";
import { LogOut, Sun, Moon } from "lucide-react";
import { NAV_SECTIONS, type Tab } from "../navigation";
import type { Theme } from "../app";
import SidebarSection from "./SidebarSection";
import { cn } from "../lib/cn";

interface SidebarProps {
  readonly activeTab: Tab;
  readonly onSelect: (tab: Tab) => void;
  readonly hiddenTabs?: ReadonlySet<Tab>;
  readonly showSignOut: boolean;
  readonly onSignOut: () => void;
  readonly mobileOpen: boolean;
  readonly onMobileClose: () => void;
  readonly theme: Theme;
  readonly onThemeToggle: () => void;
}

export default function Sidebar({
  activeTab,
  onSelect,
  hiddenTabs,
  showSignOut,
  onSignOut,
  mobileOpen,
  onMobileClose,
  theme,
  onThemeToggle,
}: SidebarProps) {
  function handleSelect(tab: Tab) {
    onSelect(tab);
    onMobileClose();
  }

  const isDark = theme === "dark";

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={cn(
          "hidden max-md:block fixed inset-0 bg-black/50 z-[290] transition-opacity duration-200",
          mobileOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none",
        )}
        onClick={onMobileClose}
      />

      <aside
        className={cn(
          "w-[230px] h-screen flex flex-col bg-bg border-r border-border overflow-y-auto overflow-x-hidden shrink-0 transition-transform duration-200",
          "max-lg:w-[56px]",
          "max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:h-dvh max-md:w-[270px] max-md:z-[300] max-md:shadow-2xl max-md:shadow-black/30",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-3.5 h-[56px] border-b border-border shrink-0 max-lg:justify-center max-md:justify-start max-md:px-4">
          <img
            src="/logo.png"
            alt="OpenCrow"
            className="w-[38px] h-[38px] shrink-0 drop-shadow-[0_0_10px_rgba(167,139,250,0.35)]"
          />
          <span
            className="text-[15px] font-bold text-strong tracking-tight max-lg:hidden max-md:block"
            style={{ fontFamily: "'Outfit', system-ui, sans-serif" }}
          >
            Open<span style={{ color: "#a78bfa" }}>Crow</span>
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-2.5 px-2.5 overflow-y-auto" aria-label="Main navigation">
          {NAV_SECTIONS.map((section) => {
            const filtered = hiddenTabs?.size
              ? { ...section, items: section.items.filter((item) => !hiddenTabs.has(item.id)) }
              : section;
            if (filtered.items.length === 0) return null;
            return (
              <SidebarSection
                key={section.title}
                section={filtered}
                activeTab={activeTab}
                onSelect={handleSelect}
              />
            );
          })}
        </nav>

        {/* Footer */}
        <div className="px-2.5 py-2.5 border-t border-border shrink-0">
          <button
            className="flex items-center gap-2.5 w-full px-3 py-2.5 border-none rounded-md bg-transparent text-muted font-sans text-sm cursor-pointer text-left transition-colors duration-150 hover:text-foreground hover:bg-bg-2 max-lg:justify-center max-lg:p-2 max-lg:gap-0 max-md:justify-start max-md:px-3 max-md:py-2.5 max-md:gap-2.5"
            onClick={onThemeToggle}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          >
            {isDark ? (
              <Sun size={16} className="shrink-0" />
            ) : (
              <Moon size={16} className="shrink-0" />
            )}
            <span className="whitespace-nowrap overflow-hidden text-ellipsis max-lg:hidden max-md:block">
              {isDark ? "Light mode" : "Dark mode"}
            </span>
          </button>

          {showSignOut && (
            <button
              className="flex items-center gap-2.5 w-full px-3 py-2.5 border-none rounded-md bg-transparent text-muted font-sans text-sm cursor-pointer text-left transition-colors duration-150 hover:text-danger hover:bg-danger-subtle max-lg:justify-center max-lg:p-2 max-lg:gap-0 max-md:justify-start max-md:px-3 max-md:py-2.5 max-md:gap-2.5"
              onClick={onSignOut}
              title="Sign out"
            >
              <LogOut size={16} className="shrink-0" />
              <span className="whitespace-nowrap overflow-hidden text-ellipsis max-lg:hidden max-md:block">
                Sign out
              </span>
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
