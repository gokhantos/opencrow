import React, { useRef } from "react";
import { cn } from "../lib/cn";

export interface TabItem {
  readonly key: string;
  readonly label: string;
}

interface TabsProps {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onSelect: (key: string) => void;
  /** Accessible label for the tablist container, e.g. "View options". */
  readonly ariaLabel: string;
  readonly className?: string;
}

/**
 * Accessible tablist primitive with role="tablist", role="tab", aria-selected,
 * and left/right arrow key navigation.
 *
 * Distinct from FilterTabs — use this when you need the full ARIA tab pattern
 * (role="tablist" + role="tab" + aria-selected + keyboard arrows) and will
 * pair it with role="tabpanel" panels.
 *
 * Usage:
 *   <Tabs
 *     ariaLabel="Pipeline views"
 *     items={[{ key: "runs", label: "Runs" }, { key: "config", label: "Config" }]}
 *     active={activeTab}
 *     onSelect={setActiveTab}
 *   />
 */
export function Tabs({ items, active, onSelect, ariaLabel, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();

    const tabs = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!tabs || tabs.length === 0) return;

    const next =
      e.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;

    tabs[next]?.focus();
    const item = items[next];
    if (item) onSelect(item.key);
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className={cn("flex items-center gap-1", className)}
    >
      {items.map((item, index) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(item.key)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={cn(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-150 cursor-pointer border-none whitespace-nowrap",
              isActive
                ? "bg-bg-2 text-strong"
                : "bg-transparent text-muted hover:text-foreground hover:bg-bg-2",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
