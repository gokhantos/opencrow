import { useState, useEffect, useRef } from "react";
import { apiFetch } from "../api";
import { useToast } from "./Toast";
import {
  ANTHROPIC_MODELS,
  AGENT_SDK_MODELS,
  ALIBABA_MODEL_GROUPS,
  OPENCODE_MODELS,
  PROVIDER_LABELS,
} from "../lib/model-lists";

const SELECT_CLS =
  "px-3 py-2 bg-bg border border-border rounded-lg text-foreground text-sm outline-none transition-colors duration-150 focus:border-accent";

interface ModelRoute {
  readonly provider: string;
  readonly model: string;
}

interface RoutesResponse {
  readonly routes: ReadonlyArray<{ readonly key: string; readonly provider: string; readonly model: string }>;
}

export interface ModelRoutePickerProps {
  readonly processKey: string;
  readonly label: string;
}

/**
 * Self-contained picker for a single model-routing process key.
 * Fetches the current route on mount, debounces saves 500ms after any change.
 */
export function ModelRoutePicker({ processKey, label }: ModelRoutePickerProps) {
  const { success, error: toastError } = useToast();
  const [route, setRoute] = useState<ModelRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial value from GET /api/model-routing
  useEffect(() => {
    let cancelled = false;
    apiFetch<RoutesResponse>("/api/model-routing")
      .then((res) => {
        if (cancelled) return;
        const entry = res.routes.find((r) => r.key === processKey);
        if (entry) {
          setRoute({ provider: entry.provider, model: entry.model });
        }
      })
      .catch(() => {
        if (!cancelled) toastError(`Failed to load route for ${label}.`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [processKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function scheduleSave(next: ModelRoute) {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(async () => {
      try {
        await apiFetch(`/api/model-routing/${encodeURIComponent(processKey)}`, {
          method: "PUT",
          body: JSON.stringify({ provider: next.provider, model: next.model }),
        });
        success(`${label} saved.`);
      } catch {
        toastError(`Failed to save ${label}.`);
      }
    }, 500);
  }

  function handleProviderChange(provider: string) {
    // Pick a sensible default model when the provider changes
    let model = "";
    if (provider === "agent-sdk") {
      model = AGENT_SDK_MODELS[0] ?? "";
    } else if (provider === "anthropic") {
      model = ANTHROPIC_MODELS[0] ?? "";
    } else if (provider === "alibaba") {
      model = ALIBABA_MODEL_GROUPS[0]?.models[0] ?? "";
    } else if (provider === "opencode") {
      model = OPENCODE_MODELS[0] ?? "";
    }
    const next: ModelRoute = { provider, model };
    setRoute(next);
    scheduleSave(next);
  }

  function handleModelChange(model: string) {
    if (!route) return;
    const next: ModelRoute = { ...route, model };
    setRoute(next);
    scheduleSave(next);
  }

  if (loading || !route) {
    return (
      <div className="flex items-center gap-3 py-2">
        <span className="text-sm text-muted min-w-[160px]">{label}</span>
        <span className="text-xs text-faint">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2 flex-wrap">
      <span className="text-sm text-foreground min-w-[160px]">{label}</span>

      {/* Provider select */}
      <select
        className={SELECT_CLS}
        value={route.provider}
        onChange={(e) => handleProviderChange(e.target.value)}
        aria-label={`${label} provider`}
      >
        {Object.entries(PROVIDER_LABELS).map(([value, displayLabel]) => (
          <option key={value} value={value}>
            {displayLabel}
          </option>
        ))}
      </select>

      {/* Model selector — dropdown for known providers, free-text for openrouter */}
      {route.provider === "agent-sdk" ? (
        <select
          className={SELECT_CLS}
          value={route.model}
          onChange={(e) => handleModelChange(e.target.value)}
          aria-label={`${label} model`}
        >
          {AGENT_SDK_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : route.provider === "anthropic" ? (
        <select
          className={SELECT_CLS}
          value={route.model}
          onChange={(e) => handleModelChange(e.target.value)}
          aria-label={`${label} model`}
        >
          {ANTHROPIC_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : route.provider === "alibaba" ? (
        <select
          className={SELECT_CLS}
          value={route.model}
          onChange={(e) => handleModelChange(e.target.value)}
          aria-label={`${label} model`}
        >
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
      ) : route.provider === "opencode" ? (
        <select
          className={SELECT_CLS}
          value={route.model}
          onChange={(e) => handleModelChange(e.target.value)}
          aria-label={`${label} model`}
        >
          {OPENCODE_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      ) : (
        // openrouter — free-text
        <input
          type="text"
          className={SELECT_CLS}
          style={{ minWidth: "220px" }}
          placeholder="e.g. deepseek/deepseek-chat-v3.1"
          value={route.model}
          onChange={(e) => handleModelChange(e.target.value)}
          aria-label={`${label} model`}
        />
      )}
    </div>
  );
}
