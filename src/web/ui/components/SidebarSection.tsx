import { useState } from "react";
import { cn } from "../lib/cn";
import type { NavSection, Tab } from "../navigation";

interface SidebarSectionProps {
  readonly section: NavSection;
  readonly activeTab: Tab;
  readonly onSelect: (tab: Tab) => void;
  readonly hiddenTabs?: ReadonlySet<Tab>;
}

export default function SidebarSection({
  section,
  activeTab,
  onSelect,
  hiddenTabs,
}: SidebarSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  const visibleItems = hiddenTabs
    ? section.items.filter((item) => !hiddenTabs.has(item.id))
    : section.items;

  // Hide entire section if all items are hidden
  if (visibleItems.length === 0) return null;

  return (
    <div className="mb-2">
      {/* Section header */}
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2 select-none max-lg:hidden max-md:flex",
          section.collapsible && "cursor-pointer hover:text-muted transition-colors",
        )}
        onClick={section.collapsible ? () => setCollapsed((c) => !c) : undefined}
        role={section.collapsible ? "button" : undefined}
        tabIndex={section.collapsible ? 0 : undefined}
        aria-expanded={section.collapsible ? !collapsed : undefined}
        onKeyDown={section.collapsible ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed((c) => !c); } } : undefined}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
          {section.title}
        </span>
        {section.collapsible && (
          <span className={cn(
            "text-[10px] text-faint transition-transform duration-200",
            collapsed && "-rotate-90",
          )}>
            &#9662;
          </span>
        )}
      </div>

      {/* Items */}
      {!collapsed && (
        <div className="flex flex-col gap-0.5 max-lg:px-0.5 max-md:px-0">
          {visibleItems.map((item) => {
            const Icon = item.Icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                className={cn(
                  "flex items-center gap-2.5 w-full px-3 py-2 border-none rounded-md bg-transparent font-sans text-sm cursor-pointer text-left transition-colors duration-150",
                  active
                    ? "bg-bg-2 text-strong font-medium"
                    : "text-muted hover:bg-bg-2 hover:text-foreground",
                  "max-lg:justify-center max-lg:p-2.5 max-lg:gap-0",
                  "max-md:justify-start max-md:px-3 max-md:py-2 max-md:gap-2.5",
                )}
                onClick={() => onSelect(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={16} className={cn(
                  "shrink-0 transition-colors duration-150",
                  active ? "text-accent" : "text-faint",
                )} />
                <span className="whitespace-nowrap overflow-hidden text-ellipsis max-lg:hidden max-md:block">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
