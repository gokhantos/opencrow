import { useState } from "react";
import { Controller } from "react-hook-form";
import { cn } from "../../../lib/cn";
import { Button, Input } from "../../../components";
import { SELECT_CLS } from "./constants";
import type { ToolInfo } from "../types";
import type { UseAgentFormReturn } from "./useAgentForm";

/** Tools tab: tool-access mode + per-tool allow/block selection + preloaded skills. */
export function ToolsTab({ form }: { form: UseAgentFormReturn }) {
  const { toolMode, availableTools, selectedTools, availableSkills, selectedSkills } =
    form;
  const { control, setValue } = form.form;
  const [skillSearch, setSkillSearch] = useState("");

  return (
    <div className="flex flex-col gap-6">
      {/* Tool Access */}
      <div className="flex flex-col gap-2.5">
        <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
          Tool Access
        </h4>
        <div className="mb-5">
          <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
            Mode
          </label>
          <Controller
            control={control}
            name="toolMode"
            render={({ field }) => (
              <select className={SELECT_CLS} {...field}>
                <option value="all">All tools</option>
                <option value="allowlist">Allowlist</option>
                <option value="blocklist">Blocklist</option>
              </select>
            )}
          />
        </div>
        {toolMode !== "all" && availableTools.length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-faint mb-3 flex items-center justify-between">
              {toolMode === "allowlist"
                ? "Select tools this agent can use:"
                : "Select tools to block from this agent:"}
              <span className="font-mono text-xs font-semibold text-accent px-2 py-0.5 bg-accent-subtle rounded-full">
                {selectedTools.length} selected
              </span>
            </p>
            {Object.entries(
              availableTools.reduce<Record<string, ToolInfo[]>>(
                (acc, tool) => ({
                  ...acc,
                  [tool.category]: [...(acc[tool.category] ?? []), tool],
                }),
                {},
              ),
            ).map(([category, tools]) => (
              <div key={category} className="mb-2.5">
                <span className="block font-heading text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-faint mb-2">
                  {category.replace(/_/g, " ")}
                </span>
                <div className="flex flex-wrap gap-1">
                  {tools.map((tool) => {
                    const isSelected = selectedTools.includes(tool.name);
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        title={tool.description ?? tool.name}
                        className={cn(
                          "px-2.5 py-1 rounded-full border font-mono text-xs font-medium cursor-pointer transition-colors",
                          isSelected
                            ? "bg-accent-subtle border-accent text-accent font-semibold"
                            : "bg-bg-2 border-border text-muted hover:bg-bg-3 hover:border-border-2 hover:text-strong",
                        )}
                        onClick={() =>
                          setValue(
                            "selectedTools",
                            isSelected
                              ? selectedTools.filter((t) => t !== tool.name)
                              : [...selectedTools, tool.name],
                          )
                        }
                      >
                        {tool.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex gap-1.5 mt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() =>
                  setValue(
                    "selectedTools",
                    availableTools.map((t) => t.name),
                  )
                }
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setValue("selectedTools", [])}
              >
                Clear all
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Preloaded Skills */}
      <div className="flex flex-col gap-2.5">
        <h4 className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-1 pb-2 border-b border-border">
          Preloaded Skills
          {selectedSkills.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-[5px] ml-1.5 text-xs font-semibold rounded-[10px] bg-purple text-white align-middle">
              {selectedSkills.length}
            </span>
          )}
        </h4>
        <p className="text-sm text-faint m-0 mb-2.5 leading-[1.4]">
          Skills are injected into the agent's system prompt automatically on
          every turn.
        </p>
        {availableSkills.length > 0 && (
          <Input
            type="text"
            value={skillSearch}
            onChange={(e) => setSkillSearch(e.target.value)}
            placeholder="Filter skills..."
            className="mb-2"
          />
        )}
        <div className="flex flex-wrap gap-1.5 max-h-[200px] overflow-y-auto py-0.5">
          {availableSkills
            .filter(
              (s) =>
                !skillSearch ||
                s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
                s.id.toLowerCase().includes(skillSearch.toLowerCase()) ||
                s.description.toLowerCase().includes(skillSearch.toLowerCase()),
            )
            .map((skill) => {
              const active = selectedSkills.includes(skill.id);
              return (
                <label
                  key={skill.id}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs cursor-pointer border transition-colors select-none max-w-full",
                    active
                      ? "bg-purple/15 border-purple text-foreground"
                      : "bg-bg-2 border-border text-muted hover:border-purple hover:text-foreground",
                  )}
                >
                  <input
                    type="checkbox"
                    className="hidden"
                    checked={active}
                    onChange={() =>
                      setValue(
                        "selectedSkills",
                        active
                          ? selectedSkills.filter((s) => s !== skill.id)
                          : [...selectedSkills, skill.id],
                      )
                    }
                  />
                  <span className="font-medium whitespace-nowrap">
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span
                      className="text-xs text-faint overflow-hidden text-ellipsis whitespace-nowrap max-w-[200px]"
                      title={skill.description}
                    >
                      {skill.description}
                    </span>
                  )}
                </label>
              );
            })}
          {availableSkills.length === 0 && (
            <p className="text-faint text-sm m-0">No skills available</p>
          )}
        </div>
      </div>
    </div>
  );
}
