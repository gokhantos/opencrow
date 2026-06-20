import { Controller } from "react-hook-form";
import { Input } from "../../../components";
import { SELECT_CLS } from "./constants";
import type { UseAgentFormReturn } from "./useAgentForm";
import {
  ANTHROPIC_MODELS,
  AGENT_SDK_MODELS,
  ALIBABA_MODEL_GROUPS,
  OPENCODE_MODELS,
} from "../../../lib/model-lists";

/** Model tab: provider/model config, thinking & effort controls, system prompt. */
export function ModelTab({ form }: { form: UseAgentFormReturn }) {
  const { provider, thinkingMode, isOpus } = form;
  const { register, control } = form.form;

  return (
    <>
      {/* Section: Model */}
      <fieldset className="border-none p-0 m-0">
        <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between">
          Model Configuration
        </legend>
        <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
          <div className="mb-5">
            <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Provider
            </label>
            <Controller
              control={control}
              name="provider"
              render={({ field }) => (
                <select className={SELECT_CLS} {...field}>
                  <option value="agent-sdk">Agent SDK</option>
                  <option value="anthropic">Anthropic (OAuth)</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="alibaba">Alibaba ModelStudio</option>
                  <option value="opencode">OpenCode</option>
                </select>
              )}
            />
          </div>
          <div className="mb-5">
            <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
              Model
            </label>
            {provider === "agent-sdk" ? (
              <select className={SELECT_CLS} {...register("model")}>
                {AGENT_SDK_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : provider === "anthropic" ? (
              <select className={SELECT_CLS} {...register("model")}>
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : provider === "alibaba" ? (
              <select className={SELECT_CLS} {...register("model")}>
                {ALIBABA_MODEL_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : provider === "opencode" ? (
              <select className={SELECT_CLS} {...register("model")}>
                {OPENCODE_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                type="text"
                placeholder="e.g. stepfun/step-3.5-flash:free"
                {...register("model")}
              />
            )}
          </div>
          <div className="mb-5">
            <Input
              label="Max Iterations"
              type="number"
              min={1}
              max={500}
              {...register("maxIterations", { valueAsNumber: true })}
            />
          </div>
          <div className="mb-5">
            <Input
              label="Max Input Length (0 = no limit)"
              type="number"
              min={0}
              placeholder="0"
              {...register("maxInputLength", { valueAsNumber: true })}
            />
          </div>
          {/* -- Agent SDK-specific: Thinking & Effort Controls -- */}
          {provider === "agent-sdk" && (
            <>
              <div className="flex items-center mb-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent cursor-pointer"
                    {...register("reasoning")}
                  />
                  <span className="select-none">Extended Thinking</span>
                </label>
              </div>
              <div className="mb-5">
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Thinking Mode
                </label>
                <Controller
                  control={control}
                  name="thinkingMode"
                  render={({ field }) => (
                    <select className={SELECT_CLS} {...field}>
                      <option value="adaptive">Adaptive (model decides)</option>
                      <option value="enabled">Fixed budget</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  )}
                />
              </div>
              {thinkingMode === "enabled" && (
                <div className="mb-5">
                  <Input
                    label="Thinking Budget (tokens)"
                    type="number"
                    min={1024}
                    max={128000}
                    step={1024}
                    {...register("thinkingBudget", { valueAsNumber: true })}
                  />
                </div>
              )}
              <div className="mb-5">
                <label className="block text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                  Effort Level
                </label>
                <Controller
                  control={control}
                  name="effort"
                  render={({ field }) => (
                    <select className={SELECT_CLS} {...field}>
                      <option value="low">Low (fast, minimal thinking)</option>
                      <option value="medium">Medium</option>
                      <option value="high">High (deep reasoning)</option>
                      <option value="max" disabled={!isOpus}>
                        Max (Opus only)
                      </option>
                    </select>
                  )}
                />
              </div>
              <div className="flex items-center mb-5">
                <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="w-4 h-4 accent-accent cursor-pointer"
                    {...register("extendedContext")}
                  />
                  <span className="select-none">1M Context Window (beta)</span>
                </label>
              </div>
            </>
          )}
          <div className="flex items-center mb-5">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-foreground">
              <input
                type="checkbox"
                className="w-4 h-4 accent-accent cursor-pointer"
                {...register("stateless")}
              />
              <span className="select-none">Stateless</span>
            </label>
          </div>
        </div>
      </fieldset>

      {/* Section: System Prompt */}
      <fieldset className="border-none p-0 m-0">
        <legend className="font-heading text-xs font-semibold uppercase tracking-widest text-accent mb-4 pb-2 border-b border-border w-full flex items-center justify-between">
          System Prompt
        </legend>
        <textarea
          rows={6}
          className="w-full px-4 py-3 bg-bg border border-border rounded-lg text-foreground font-mono text-sm leading-relaxed outline-none transition-colors duration-150 resize-y min-h-[120px] focus:border-accent"
          placeholder="Uses global default if empty"
          {...register("systemPrompt")}
        />
      </fieldset>
    </>
  );
}
