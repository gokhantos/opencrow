import React, { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../api";
import { cn } from "../lib/cn";
import { LoadingState, EmptyState, PageHeader, SearchBar, FilterTabs } from "../components";

interface ToolInfo {
  name: string;
  category: string;
  description: string;
  params: string[];
  enabled: boolean;
}

interface ToolsResponse {
  success: boolean;
  data: ToolInfo[];
  categories: Record<string, string>;
}

function ToolCard({
  tool,
  index,
  isSelected,
  onSelect,
  onToggle,
}: {
  tool: ToolInfo;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative bg-bg-1 border rounded-lg overflow-hidden text-left w-full transition-all duration-200",
        "hover:border-border-hover hover:bg-bg-1/80",
        isSelected
          ? "border-accent border-l-[3px] border-l-accent"
          : "border-border border-l-[3px] border-l-transparent",
        !tool.enabled && "opacity-45",
      )}
      style={{
        animation: `agCardIn 0.3s ease-out ${index * 20}ms both`,
      }}
    >
      <button
        type="button"
        className="w-full text-left px-4 py-3 cursor-pointer bg-transparent border-0"
        onClick={onSelect}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-mono text-sm font-semibold text-strong truncate">
            {tool.name}
          </span>
          {!tool.enabled && (
            <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-bg-2 text-faint">
              disabled
            </span>
          )}
        </div>
        <p className="text-xs text-muted m-0 leading-relaxed line-clamp-2">
          {tool.description}
        </p>
        {tool.params.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {tool.params.slice(0, 4).map((p) => (
              <span
                key={p}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-2 text-faint"
              >
                {p}
              </span>
            ))}
            {tool.params.length > 4 && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg-2 text-faint">
                +{tool.params.length - 4}
              </span>
            )}
          </div>
        )}
      </button>
    </div>
  );
}

function DetailPanel({
  tool,
  categoryLabel,
  onClose,
  onToggle,
}: {
  tool: ToolInfo;
  categoryLabel: string;
  onClose: () => void;
  onToggle: () => void;
}) {
  return (
    <div className="bg-bg-1 border border-border rounded-xl p-6 sticky top-6">
      <div className="flex items-start justify-between gap-3 mb-5">
        <h3 className="text-lg font-bold text-strong m-0 font-mono">
          {tool.name}
        </h3>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className={cn(
              "relative w-9 h-[18px] rounded-full transition-colors cursor-pointer border-0",
              tool.enabled ? "bg-accent" : "bg-bg-3",
            )}
            onClick={onToggle}
            title={tool.enabled ? "Disable tool" : "Enable tool"}
          >
            <span
              className={cn(
                "absolute top-[1px] w-4 h-4 rounded-full bg-white transition-transform",
                tool.enabled ? "translate-x-[18px]" : "translate-x-[1px]",
              )}
            />
          </button>
          <button
            type="button"
            className="w-7 h-7 rounded-md border border-border bg-transparent text-muted cursor-pointer flex items-center justify-center hover:bg-bg-2 hover:text-strong transition-colors"
            onClick={onClose}
          >
            &times;
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <span className="text-[10px] text-faint uppercase tracking-widest font-semibold">
            Category
          </span>
          <p className="text-sm text-foreground m-0 mt-1">{categoryLabel}</p>
        </div>

        <div>
          <span className="text-[10px] text-faint uppercase tracking-widest font-semibold">
            Description
          </span>
          <p className="text-sm text-foreground m-0 mt-1 leading-relaxed">
            {tool.description}
          </p>
        </div>

        {tool.params.length > 0 && (
          <div>
            <span className="text-[10px] text-faint uppercase tracking-widest font-semibold">
              Parameters
            </span>
            <div className="mt-2 space-y-1">
              {tool.params.map((p) => (
                <div
                  key={p}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg-2"
                >
                  <span className="font-mono text-xs text-foreground">{p}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Tools() {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [categories, setCategories] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [selectedTool, setSelectedTool] = useState<ToolInfo | null>(null);
  const [showDisabled, setShowDisabled] = useState(true);

  const loadTools = useCallback(async () => {
    try {
      const res = await apiFetch<ToolsResponse>("/api/tools");
      setTools(res.data);
      setCategories(res.categories);
      setError("");
    } catch {
      setError("Failed to load tools");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTools();
  }, [loadTools]);

  const toggleTool = useCallback(
    async (toolName: string) => {
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) return;

      // Optimistic update
      const updated = tools.map((t) =>
        t.name === toolName ? { ...t, enabled: !t.enabled } : t,
      );
      setTools(updated);
      setSelectedTool((prev) =>
        prev?.name === toolName ? { ...prev, enabled: !prev.enabled } : prev,
      );

      // Persist: collect all manually disabled tools
      const disabledTools = updated
        .filter((t) => !t.enabled)
        .map((t) => t.name);

      try {
        await apiFetch("/api/tools/disabled", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ disabled: disabledTools }),
        });
      } catch {
        // Revert on failure
        loadTools();
      }
    },
    [tools, loadTools],
  );

  const enabledCount = tools.filter((t) => t.enabled).length;
  const disabledCount = tools.length - enabledCount;

  const uniqueCategories = [...new Set(tools.map((t) => t.category))];
  const filterTabs = [
    { id: "all", label: "All", count: showDisabled ? tools.length : enabledCount },
    ...uniqueCategories.map((cat) => ({
      id: cat,
      label: categories[cat] ?? cat,
      count: tools.filter((t) => t.category === cat && (showDisabled || t.enabled)).length,
    })).filter((tab) => tab.count > 0),
  ];

  const filtered = tools.filter((t) => {
    if (!showDisabled && !t.enabled) return false;
    if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.params.some((p) => p.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Group filtered tools by category
  const grouped = new Map<string, ToolInfo[]>();
  for (const tool of filtered) {
    const list = grouped.get(tool.category) ?? [];
    list.push(tool);
    grouped.set(tool.category, list);
  }

  if (loading) return <LoadingState />;

  return (
    <div className="max-w-[1400px]">
      <PageHeader
        title="Tools"
        subtitle={`${enabledCount} enabled, ${disabledCount} disabled`}
        count={tools.length}
      />

      {error && (
        <div className="bg-danger-subtle border border-danger/20 rounded-lg px-4 py-3 text-danger text-sm mb-5">
          {error}
        </div>
      )}

      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1 max-w-md">
          <SearchBar
            value={search}
            onChange={setSearch}
            placeholder="Search tools..."
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDisabled}
            onChange={(e) => setShowDisabled(e.target.checked)}
            className="accent-accent"
          />
          Show disabled
        </label>
      </div>

      <FilterTabs
        tabs={filterTabs}
        active={categoryFilter}
        onChange={setCategoryFilter}
      />

      <div className={cn("flex gap-6", selectedTool && "max-lg:flex-col")}>
        <div className="flex-1 min-w-0">
          {filtered.length === 0 && (
            <EmptyState description="No tools match your search." />
          )}

          {[...grouped.entries()].map(([cat, catTools]) => {
            const label = categories[cat] ?? cat;
            return (
              <div key={cat} className="mb-6">
                {categoryFilter === "all" && (
                  <div className="flex items-center gap-3 mb-3 px-1">
                    <h3 className="text-xs uppercase tracking-[0.12em] text-faint font-semibold m-0">
                      {label}
                    </h3>
                    <span className="text-[11px] font-mono text-muted">
                      {catTools.length}
                    </span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                )}
                <div className="grid grid-cols-3 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3">
                  {catTools.map((tool, i) => (
                    <ToolCard
                      key={tool.name}
                      tool={tool}
                      index={i}
                      isSelected={selectedTool?.name === tool.name}
                      onSelect={() =>
                        setSelectedTool(
                          selectedTool?.name === tool.name ? null : tool,
                        )
                      }
                      onToggle={() => toggleTool(tool.name)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {selectedTool && (
          <div className="w-[320px] max-lg:w-full shrink-0">
            <DetailPanel
              tool={selectedTool}
              categoryLabel={categories[selectedTool.category] ?? selectedTool.category}
              onClose={() => setSelectedTool(null)}
              onToggle={() => toggleTool(selectedTool.name)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
