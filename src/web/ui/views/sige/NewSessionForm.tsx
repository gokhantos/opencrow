import { useState } from "react";
import { ChevronDown, ChevronUp, Zap } from "lucide-react";
import { Button } from "../../components";
import { cn } from "../../lib/cn";
import type { SigeCreateConfig } from "./api";

const DEFAULT_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "qwen3.5-plus",
  "qwen-plus",
] as const;

interface NewSessionFormProps {
  readonly onSubmit: (seedInput: string, config?: SigeCreateConfig) => Promise<void>;
  readonly submitting: boolean;
}

export function NewSessionForm({ onSubmit, submitting }: NewSessionFormProps) {
  const [seedInput, setSeedInput] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [alpha, setAlpha] = useState(0.5);
  const [socialAgentCount, setSocialAgentCount] = useState(20);
  const [model, setModel] = useState("claude-haiku-4-5-20251001");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!seedInput.trim()) {
      setError("Seed input is required.");
      return;
    }
    setError("");
    await onSubmit(seedInput.trim(), { alpha, socialAgentCount, model });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-bg-1 border border-border rounded-xl p-6 mb-8"
    >
      <div className="mb-5">
        <label
          className="block text-sm font-semibold text-muted uppercase tracking-wide mb-2"
          htmlFor="sige-seed-input"
        >
          Seed Input
        </label>
        <textarea
          id="sige-seed-input"
          className={cn(
            "w-full min-h-[120px] px-4 py-3 bg-bg border border-border-2 rounded-lg text-foreground text-sm font-mono leading-relaxed resize-y outline-none transition-colors placeholder:text-faint",
            "focus:border-accent",
            error && "border-danger focus:border-danger",
          )}
          placeholder="Enter the strategic question, market data, competitive landscape, or any context for the idea generation engine..."
          value={seedInput}
          onChange={(e) => {
            setSeedInput(e.target.value);
            if (error) setError("");
          }}
          disabled={submitting}
        />
        {error && (
          <p className="text-danger text-xs mt-1.5">{error}</p>
        )}
      </div>

      {/* Advanced Config toggle */}
      <button
        type="button"
        className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-colors cursor-pointer bg-transparent border-none p-0 mb-4"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
      >
        {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        Advanced Config
      </button>

      {advancedOpen && (
        <div className="mb-5 p-4 bg-bg border border-border rounded-lg space-y-5">
          {/* Alpha slider */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                className="text-xs font-semibold text-muted uppercase tracking-wide"
                htmlFor="sige-alpha"
              >
                Alpha — Expert vs Social weight
              </label>
              <span className="text-xs font-mono text-accent font-semibold">
                {alpha.toFixed(2)}
              </span>
            </div>
            <input
              id="sige-alpha"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={alpha}
              onChange={(e) => setAlpha(Number(e.target.value))}
              className="w-full accent-accent h-1.5 cursor-pointer"
              disabled={submitting}
            />
            <div className="flex justify-between text-xs text-faint mt-1">
              <span>Pure expert (0)</span>
              <span>Pure social (1)</span>
            </div>
          </div>

          {/* Social agent count */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                className="text-xs font-semibold text-muted uppercase tracking-wide"
                htmlFor="sige-agent-count"
              >
                Social Agent Count
              </label>
              <span className="text-xs font-mono text-accent font-semibold">
                {socialAgentCount}
              </span>
            </div>
            <input
              id="sige-agent-count"
              type="range"
              min={5}
              max={100}
              step={5}
              value={socialAgentCount}
              onChange={(e) => setSocialAgentCount(Number(e.target.value))}
              className="w-full accent-accent h-1.5 cursor-pointer"
              disabled={submitting}
            />
            <div className="flex justify-between text-xs text-faint mt-1">
              <span>5</span>
              <span>100</span>
            </div>
          </div>

          {/* Model selector */}
          <div>
            <label
              className="block text-xs font-semibold text-muted uppercase tracking-wide mb-1.5"
              htmlFor="sige-model"
            >
              Orchestrator Model
            </label>
            <select
              id="sige-model"
              className="w-full py-2.5 px-3 rounded-lg border border-border-2 bg-bg text-foreground text-sm outline-none transition-colors focus:border-accent cursor-pointer"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={submitting}
            >
              {DEFAULT_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end">
        <Button
          type="submit"
          variant="primary"
          size="md"
          loading={submitting}
          disabled={!seedInput.trim()}
        >
          <Zap size={16} />
          Start Session
        </Button>
      </div>
    </form>
  );
}
