import React from "react";
import { cn } from "../lib/cn";

interface FilterTab {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

interface FilterTabsProps {
  readonly tabs: readonly FilterTab[];
  readonly active: string;
  readonly onChange: (id: string) => void;
}

export function FilterTabs({ tabs, active, onChange }: FilterTabsProps) {
  return (
    <div className="flex gap-1.5 flex-wrap mb-5" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors duration-150 border",
              isActive
                ? "bg-accent text-white border-accent font-semibold"
                : "bg-transparent border-border-2 text-muted hover:bg-bg-2 hover:border-border-hover hover:text-foreground",
            )}
            type="button"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 ml-2 rounded font-mono text-xs font-semibold",
                  isActive ? "bg-white/20 text-white" : "bg-bg-3 text-faint",
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
