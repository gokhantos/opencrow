# Model Routing — Design Spec
_2026-06-20_

## Overview

Replace every hardcoded `{ provider, model }` pair in the six LLM-calling processes with a DB-backed model-routing table. The dashboard surfaces per-process provider+model pickers embedded in the relevant views. Changes take effect on the next LLM call — no restart required.

---

## 1. Processes in scope

| Key | Current hardcoded default | View |
|---|---|---|
| `signal.facets` | `alibaba / deepseek-v4-flash` | Memory |
| `signal.observations` | `alibaba / deepseek-v4-flash` | Memory |
| `sige.fast-agent` | `anthropic / claude-haiku-4-5-20251001` | Sige |
| `sige.judge.0` | `anthropic / claude-haiku-4-5` | Sige |
| `sige.judge.1` | `openrouter / deepseek/deepseek-chat-v3.1` | Sige |
| `sige.judge.2` | `alibaba / qwen3.7-plus` | Sige |
| `pipeline.generator` | `anthropic / claude-sonnet-4-6` | PipelineIdeas |
| `agent-templates` | `agent-sdk / claude-haiku-4-5` | Agents |

All 8 keys are always present in the DB. There is no in-code fallback at runtime.

---

## 2. Data layer

### 2a. Storage
Uses the existing `config_overrides` table under namespace `"model-routing"`. Each process is one row:

```
namespace = "model-routing"
key       = "signal.facets"          -- one of the 8 keys above
value     = { "provider": "alibaba", "model": "deepseek-v4-flash" }
```

No new table or migration column needed. One new migration (`030`) seeds the 8 rows.

### 2b. `src/store/model-routing.ts`

```ts
export const MODEL_ROUTING_KEYS = [
  "signal.facets",
  "signal.observations",
  "sige.fast-agent",
  "sige.judge.0",
  "sige.judge.1",
  "sige.judge.2",
  "pipeline.generator",
  "agent-templates",
] as const;

export type ModelRoutingKey = (typeof MODEL_ROUTING_KEYS)[number];

export interface ModelRoute {
  readonly provider: "anthropic" | "alibaba" | "openrouter" | "agent-sdk" | "opencode";
  readonly model: string;
}

/** Read a single route. Throws if the key is missing (should not happen post-seed). */
export async function getModelRoute(key: ModelRoutingKey): Promise<ModelRoute>

/** Write a single route. */
export async function setModelRoute(key: ModelRoutingKey, route: ModelRoute): Promise<void>

/** Read all 8 routes. */
export async function getAllModelRoutes(): Promise<Record<ModelRoutingKey, ModelRoute>>
```

Reads hit the DB directly on every call — no caching. This is intentional: hot reload without restart.

### 2c. Migration `030_model_routing_seed.sql`

```sql
INSERT INTO config_overrides (namespace, key, value) VALUES
  ('model-routing', 'signal.facets',       '{"provider":"alibaba","model":"deepseek-v4-flash"}'),
  ('model-routing', 'signal.observations', '{"provider":"alibaba","model":"deepseek-v4-flash"}'),
  ('model-routing', 'sige.fast-agent',     '{"provider":"anthropic","model":"claude-haiku-4-5-20251001"}'),
  ('model-routing', 'sige.judge.0',        '{"provider":"anthropic","model":"claude-haiku-4-5"}'),
  ('model-routing', 'sige.judge.1',        '{"provider":"openrouter","model":"deepseek/deepseek-chat-v3.1"}'),
  ('model-routing', 'sige.judge.2',        '{"provider":"alibaba","model":"qwen3.7-plus"}'),
  ('model-routing', 'pipeline.generator',  '{"provider":"anthropic","model":"claude-sonnet-4-6"}'),
  ('model-routing', 'agent-templates',     '{"provider":"agent-sdk","model":"claude-haiku-4-5"}')
ON CONFLICT (namespace, key) DO NOTHING;
```

`DO NOTHING` makes re-runs idempotent and preserves any user-customized values.

---

## 3. API layer

New route file: `src/web/routes/model-routing.ts`

```
GET  /api/model-routing          → ModelRoute[] with key included
PUT  /api/model-routing/:key     → body { provider, model } — validates key + provider
```

Validation:
- `key` must be one of the 8 `MODEL_ROUTING_KEYS` — 404 otherwise
- `provider` must be one of `["anthropic","alibaba","openrouter","agent-sdk","opencode"]` — 400 otherwise
- `model` must be a non-empty string — 400 otherwise

No DELETE endpoint. Every key must always have a value.

---

## 4. Callsite changes

Six files are updated to call `getModelRoute` instead of using hardcoded values:

| File | Key |
|---|---|
| `src/memory/signal-facets.ts` | `signal.facets` |
| `src/memory/signal-enrichment.ts` | `signal.facets` (DEFAULT_RANK_MODEL constant removed) |
| `src/memory/observation-extractor.ts` | `signal.observations` |
| `src/sige/auto/scheduler.ts` | `sige.fast-agent` |
| `src/config/schema.ts` | `SIGE_DEFAULT_JUDGE_MODELS` constant removed; jury assembly reads `sige.judge.{0,1,2}` at runtime |
| `src/tools/agent-templates.ts` | `agent-templates` |

The pipeline generator (`pipeline.generator`) replaces the `provider`/`model` fields at `src/config/schema.ts:551-552` — these are already in the smart config but will now also be seeded and editable via model-routing. The smart config fields remain as a local override if set; `getModelRoute("pipeline.generator")` is the fallback when not overridden.

---

## 5. OpenCode provider

OpenCode (PR #221, parked) is included as a fifth provider option. As part of this feature:

- `chat()` in `src/agent/chat.ts` gets an `opencode` branch alongside the existing `anthropic`, `alibaba`, `openrouter` branches
- A new `src/agent/opencode-direct.ts` handles the HTTP call to the Zen endpoint (`/zen/go/v1`), mirroring `alibaba-direct.ts` in structure
- Thinking is disabled via `{ type: "disabled" }` (not `enable_thinking: false`) per the Go endpoint's contract
- The model list in the UI picker is: `opencode-sonnet`, `opencode-opus` (exact IDs to be confirmed against the live endpoint)

If the OpenCode endpoint is not configured (no `OPENCODE_API_KEY` / base URL), the provider is shown in the picker but calls will fail gracefully with a logged error — same pattern as the existing Anthropic OAuth fallback.

---

## 6. UI

### 6a. Shared component: `ModelRoutePicker`

`src/web/ui/components/ModelRoutePicker.tsx`

Props:
```ts
interface ModelRoutePickerProps {
  processKey: ModelRoutingKey;
  label: string;
}
```

Behaviour:
- Fetches current `{ provider, model }` from `GET /api/model-routing/:key` on mount
- Renders provider dropdown (5 options: Agent SDK, Anthropic, Alibaba, OpenRouter, OpenCode)
- Renders model dropdown when provider is `anthropic`, `agent-sdk`, or `alibaba`; free-text input for `openrouter` and `opencode`
- On change: immediate `PUT /api/model-routing/:key` with debounce (500 ms) — no explicit Save button
- Shows a subtle "Saved" toast on success, inline error on failure
- Reuses model lists from `ModelTab.tsx` (extract into `src/web/ui/lib/model-lists.ts`)

### 6b. Memory view (`Memory.tsx`)

New "Model Configuration" card added below the existing memory stats section:

```
┌─ Model Configuration ───────────────────────────────┐
│  Signal Facets          [Provider ▾]  [Model ▾]     │
│  Observation Extraction [Provider ▾]  [Model ▾]     │
└─────────────────────────────────────────────────────┘
```

### 6c. Sige view (`Sige.tsx`)

New "Model Configuration" section added to the existing Sige config panel:

```
┌─ Model Configuration ───────────────────────────────┐
│  Fast Agent (auto)      [Provider ▾]  [Model ▾]     │
│  Judge 0                [Provider ▾]  [Model ▾]     │
│  Judge 1                [Provider ▾]  [Model ▾]     │
│  Judge 2                [Provider ▾]  [Model ▾]     │
└─────────────────────────────────────────────────────┘
```

### 6d. PipelineIdeas view (`PipelineIdeas.tsx`)

Single picker added to the pipeline config section:

```
┌─ Model Configuration ───────────────────────────────┐
│  Generator              [Provider ▾]  [Model ▾]     │
└─────────────────────────────────────────────────────┘
```

### 6e. Agents view

New "Default Tool Template Model" card in the global defaults section:

```
┌─ Tool Template Model ───────────────────────────────┐
│  Agent Templates        [Provider ▾]  [Model ▾]     │
└─────────────────────────────────────────────────────┘
```

---

## 7. Model lists (extracted to `src/web/ui/lib/model-lists.ts`)

```ts
export const ANTHROPIC_MODELS = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]
export const AGENT_SDK_MODELS  = ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"]
export const ALIBABA_MODELS    = { Qwen: [...], DeepSeek: [...], Zhipu: [...], MiniMax: [...], Moonshot: [...] }  // from ModelTab.tsx
export const OPENCODE_MODELS   = ["opencode-sonnet", "opencode-opus"]
// openrouter: free-text input
```

---

## 8. Testing

### Unit (`*.test.ts`)
- `src/store/model-routing.test.ts` — `getModelRoute` / `setModelRoute` / `getAllModelRoutes` with a mocked DB
- `src/memory/signal-facets.test.ts` — assert extraction call receives provider/model from `getModelRoute` mock (not hardcoded)

### Integration (`*.integration.test.ts`)
- `src/web/routes/model-routing.integration.test.ts`
  - `GET /api/model-routing` returns all 8 keys after seed
  - `PUT /api/model-routing/signal.facets` updates and reads back correctly
  - Unknown key → 404
  - Invalid provider → 400

### Isolated (`*.isolated.test.ts`)
- `src/memory/observation-extractor.isolated.test.ts` — mock `model-routing` store, verify `chat()` called with correct args

---

## 9. Scope boundaries

**In scope:**
- All 8 process keys configurable via DB + dashboard
- OpenCode as fifth provider (chat.ts routing + opencode-direct.ts)
- Model lists extracted from ModelTab into shared lib
- Migration 030 seed

**Out of scope:**
- Per-agent model routing (agents already have their own config)
- Embeddings model routing (separate subsystem with own config)
- Model validation against live provider endpoints
- Cost estimation per model selection
