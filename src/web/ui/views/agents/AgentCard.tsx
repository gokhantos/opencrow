import { cn } from "../../lib/cn";
import type { AgentInfo } from "./types";
import { providerLabel, getInitials, shortModel } from "./types";

export function AgentCard({
  agent,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  agent: AgentInfo;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault?: () => void;
}) {
  const toolsLabel =
    agent.toolFilter.mode === "all"
      ? "All tools"
      : `${agent.toolFilter.tools.length} ${agent.toolFilter.mode === "allowlist" ? "allowed" : "blocked"}`;

  return (
    <div
      className={cn(
        "relative bg-bg-1 border rounded-lg overflow-hidden cursor-pointer transition-colors group",
        "hover:border-border-2 hover:bg-bg-2",
        isSelected
          ? "border-accent bg-accent-subtle"
          : "border-border",
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="px-5 pt-5 pb-4 flex flex-col gap-4">
        {/* Top row: avatar + name + actions */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-9 h-9 rounded-lg bg-bg-3 border border-border flex items-center justify-center font-mono font-semibold text-xs text-muted shrink-0 uppercase tracking-wide">
              {getInitials(agent.name)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-sans font-semibold text-base text-strong tracking-tight truncate">
                  {agent.name}
                </span>
                {agent.isDefault && (
                  <span className="text-[0.65rem] font-semibold text-accent bg-accent-subtle px-2 py-0.5 rounded uppercase tracking-wide shrink-0">
                    default
                  </span>
                )}
                {agent.source === "db" && (
                  <span className="text-[0.65rem] font-semibold text-success bg-success-subtle px-2 py-0.5 rounded uppercase tracking-wide shrink-0">
                    custom
                  </span>
                )}
                {agent.source === "file+db" && (
                  <span className="text-[0.65rem] font-semibold text-warning bg-warning-subtle px-2 py-0.5 rounded uppercase tracking-wide shrink-0">
                    modified
                  </span>
                )}
                {agent.source === "ecc" && (
                  <span className="text-[0.65rem] font-semibold text-purple bg-[rgba(192,132,252,0.1)] px-2 py-0.5 rounded uppercase tracking-wide shrink-0">
                    ecc
                  </span>
                )}
              </div>
              <div className="font-mono text-xs text-faint truncate mt-0.5">
                {agent.id}
              </div>
            </div>
          </div>

          {/* Hover actions */}
          <div
            className="flex gap-1 opacity-0 group-hover:opacity-100 max-md:opacity-100 transition-opacity duration-150 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {!agent.isDefault && onSetDefault && (
              <button
                className="w-8 h-8 border border-border rounded-md bg-bg text-faint cursor-pointer flex items-center justify-center transition-colors hover:bg-accent-subtle hover:text-accent hover:border-accent/30"
                onClick={onSetDefault}
                title="Set as default"
                aria-label="Set as default"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                </svg>
              </button>
            )}
            <button
              className="w-8 h-8 border border-border rounded-md bg-bg text-faint cursor-pointer flex items-center justify-center transition-colors hover:bg-bg-2 hover:text-foreground hover:border-border-2"
              onClick={onEdit}
              title="Edit agent"
              aria-label="Edit agent"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            {!agent.isDefault && (
              <button
                className="w-8 h-8 border border-border rounded-md bg-bg text-faint cursor-pointer flex items-center justify-center transition-colors hover:bg-danger-subtle hover:text-danger hover:border-danger/30"
                onClick={onDelete}
                title="Delete agent"
                aria-label="Delete agent"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Description */}
        {agent.description && (
          <p className="text-muted text-sm leading-relaxed m-0 line-clamp-2">
            {agent.description}
          </p>
        )}

        {/* Metadata row */}
        <div className="flex items-center gap-3 text-xs text-faint pt-0.5 border-t border-border">
          <span className="flex items-center gap-1.5 pt-2.5">
            <span className={cn(
              "w-1.5 h-1.5 rounded-full",
              agent.provider === "agent-sdk"
                ? "bg-success"
                : agent.provider === "alibaba"
                  ? "bg-orange-400"
                  : "bg-accent",
            )} />
            {providerLabel(agent.provider)}
          </span>
          <span className="font-mono pt-2.5">{shortModel(agent.model)}</span>
          {agent.telegramBotToken && (
            <span className="pt-2.5">Bot</span>
          )}
          <span className="ml-auto font-mono pt-2.5">{toolsLabel}</span>
        </div>
      </div>
    </div>
  );
}
