# Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the provider+model for six LLM-calling processes (signal facets, observation extraction, SIGE fast-agent, 3 SIGE judges, pipeline generator, agent tool templates) configurable from the dashboard, taking effect on the next run with no restart.

**Architecture:** A new `model-routing` namespace in the existing `config_overrides` table stores one `{provider, model}` row per process key. A `getModelRoute(key)` store helper reads the DB at call time (hot reload). A migration seeds the 8 rows from current hardcoded values. New API + per-view dashboard pickers let operators edit them. OpenCode is added as a fifth provider in `chat()`.

**Tech Stack:** Bun, TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Hono, `Bun.sql` via `getDb()`, React 19, Tailwind v4, Zod, Biome.

## Global Constraints

- Immutability — never mutate inputs; return new objects. Domain types `readonly`.
- Strict TS — `import type` for types; index access is `T | undefined`.
- DB — `config_overrides` stores values in a TEXT column `value_json` (JSON string), NOT native JSONB. Seed migrations must `JSON`-encode into `value_json`.
- Migrations — numbered `.sql` in `src/store/migrations/`, idempotent (`ON CONFLICT DO NOTHING`), registered in `src/store/migrations/index.ts`.
- Validation — Zod at every external boundary (API bodies).
- Logging — `createLogger("scope")`, no bare `console.log`.
- Lint/format — Biome (2-space, double quotes, semicolons, trailing commas, width 100).
- Tests — lane by suffix: `*.test.ts` (unit), `*.integration.test.ts` (DB), `*.isolated.test.ts` (`mock.module`).
- Provider enum everywhere becomes: `"anthropic" | "alibaba" | "openrouter" | "agent-sdk" | "opencode"`.

---

## File Structure

**Create:**
- `src/store/model-routing.ts` — keys, types, `getModelRoute`/`setModelRoute`/`getAllModelRoutes`
- `src/store/model-routing.test.ts` — unit tests (mocked store)
- `src/store/migrations/030_model_routing_seed.sql` — seed 8 rows
- `src/web/routes/model-routing.ts` — GET/PUT API
- `src/web/routes/model-routing.integration.test.ts` — API round-trip
- `src/agent/opencode-direct.ts` — OpenCode HTTP client (mirrors `alibaba-direct.ts`)
- `src/web/ui/lib/model-lists.ts` — shared provider→model lists
- `src/web/ui/components/ModelRoutePicker.tsx` — shared picker component

**Modify:**
- `src/store/migrations/index.ts` — register migration 030
- `src/memory/signal-facets.ts` — read `signal.facets` route
- `src/memory/signal-enrichment.ts` — drop `DEFAULT_RANK_MODEL`, use route
- `src/memory/observation-extractor.ts` — read `signal.observations` route
- `src/sige/auto/scheduler.ts` — read `sige.fast-agent` route
- `src/tools/agent-templates.ts` — read `agent-templates` route
- `src/agent/chat.ts` — add `opencode` provider branch
- `src/agent/types.ts` — extend provider type with `opencode`
- `src/config/schema.ts` — provider enums add `opencode`; `SIGE_DEFAULT_JUDGE_MODELS` consumers read routes
- `src/web/ui/lib/schemas.ts` — provider enum adds `opencode`
- `src/web/ui/views/agents/agent-form/ModelTab.tsx` — use shared model-lists + opencode
- `src/web/ui/views/Memory.tsx` — add Model Configuration card
- `src/web/ui/views/Sige.tsx` — add Model Configuration section
- `src/web/ui/views/PipelineIdeas.tsx` — add Generator picker
- `src/web/ui/views/agents/*` — add Tool Template Model card
- Wherever the API routes are registered (e.g. `src/web/routes/index.ts` or app setup) — mount model-routing routes

---

## Task 1: Store layer — `model-routing.ts`

**Files:**
- Create: `src/store/model-routing.ts`
- Test: `src/store/model-routing.test.ts`

**Interfaces:**
- Consumes: `getOverride`, `setOverride`, `getAllOverrides` from `./config-overrides`
- Produces:
  - `MODEL_ROUTING_KEYS: readonly ModelRoutingKey[]`
  - `type ModelRoutingKey = "signal.facets" | "signal.observations" | "sige.fast-agent" | "sige.judge.0" | "sige.judge.1" | "sige.judge.2" | "pipeline.generator" | "agent-templates"`
  - `type ModelProvider = "anthropic" | "alibaba" | "openrouter" | "agent-sdk" | "opencode"`
  - `interface ModelRoute { readonly provider: ModelProvider; readonly model: string }`
  - `MODEL_ROUTING_DEFAULTS: Readonly<Record<ModelRoutingKey, ModelRoute>>`
  - `async function getModelRoute(key: ModelRoutingKey): Promise<ModelRoute>`
  - `async function setModelRoute(key: ModelRoutingKey, route: ModelRoute): Promise<void>`
  - `async function getAllModelRoutes(): Promise<Record<ModelRoutingKey, ModelRoute>>`

- [ ] **Step 1: Write the failing test**

```ts
// src/store/model-routing.test.ts
import { describe, expect, test } from "bun:test";
import {
  MODEL_ROUTING_KEYS,
  MODEL_ROUTING_DEFAULTS,
  modelRouteSchema,
} from "./model-routing";

describe("model-routing constants", () => {
  test("defines 8 process keys", () => {
    expect(MODEL_ROUTING_KEYS.length).toBe(8);
    expect(MODEL_ROUTING_KEYS).toContain("signal.facets");
    expect(MODEL_ROUTING_KEYS).toContain("agent-templates");
  });

  test("every key has a default route", () => {
    for (const key of MODEL_ROUTING_KEYS) {
      const def = MODEL_ROUTING_DEFAULTS[key];
      expect(typeof def.provider).toBe("string");
      expect(def.model.length).toBeGreaterThan(0);
    }
  });

  test("signal.facets default is alibaba/deepseek-v4-flash", () => {
    expect(MODEL_ROUTING_DEFAULTS["signal.facets"]).toEqual({
      provider: "alibaba",
      model: "deepseek-v4-flash",
    });
  });

  test("modelRouteSchema rejects unknown provider", () => {
    const r = modelRouteSchema.safeParse({ provider: "bogus", model: "x" });
    expect(r.success).toBe(false);
  });

  test("modelRouteSchema accepts opencode", () => {
    const r = modelRouteSchema.safeParse({ provider: "opencode", model: "opencode-sonnet" });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit src/store/model-routing.test.ts`
Expected: FAIL — module `./model-routing` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/store/model-routing.ts
import { z } from "zod";
import { getOverride, setOverride, getAllOverrides } from "./config-overrides";

const NAMESPACE = "model-routing";

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

export const MODEL_PROVIDERS = [
  "anthropic",
  "alibaba",
  "openrouter",
  "agent-sdk",
  "opencode",
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const modelRouteSchema = z.object({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string().min(1),
});

export type ModelRoute = z.infer<typeof modelRouteSchema>;

export const MODEL_ROUTING_DEFAULTS: Readonly<Record<ModelRoutingKey, ModelRoute>> = {
  "signal.facets": { provider: "alibaba", model: "deepseek-v4-flash" },
  "signal.observations": { provider: "alibaba", model: "deepseek-v4-flash" },
  "sige.fast-agent": { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  "sige.judge.0": { provider: "anthropic", model: "claude-haiku-4-5" },
  "sige.judge.1": { provider: "openrouter", model: "deepseek/deepseek-chat-v3.1" },
  "sige.judge.2": { provider: "alibaba", model: "qwen3.7-plus" },
  "pipeline.generator": { provider: "anthropic", model: "claude-sonnet-4-6" },
  "agent-templates": { provider: "agent-sdk", model: "claude-haiku-4-5" },
};

function isKey(key: string): key is ModelRoutingKey {
  return (MODEL_ROUTING_KEYS as readonly string[]).includes(key);
}

export function isModelRoutingKey(key: string): key is ModelRoutingKey {
  return isKey(key);
}

/**
 * Resolve a process's model route. Reads the DB override on every call (hot
 * reload). Falls back to the seeded default if the row is missing or invalid,
 * so a never-seeded DB still works.
 */
export async function getModelRoute(key: ModelRoutingKey): Promise<ModelRoute> {
  const raw = await getOverride(NAMESPACE, key);
  const parsed = modelRouteSchema.safeParse(raw);
  return parsed.success ? parsed.data : MODEL_ROUTING_DEFAULTS[key];
}

export async function setModelRoute(key: ModelRoutingKey, route: ModelRoute): Promise<void> {
  await setOverride(NAMESPACE, key, modelRouteSchema.parse(route));
}

export async function getAllModelRoutes(): Promise<Record<ModelRoutingKey, ModelRoute>> {
  const overrides = await getAllOverrides(NAMESPACE);
  const byKey = new Map(overrides.map((o) => [o.key, o.value] as const));
  const result = {} as Record<ModelRoutingKey, ModelRoute>;
  for (const key of MODEL_ROUTING_KEYS) {
    const parsed = modelRouteSchema.safeParse(byKey.get(key));
    result[key] = parsed.success ? parsed.data : MODEL_ROUTING_DEFAULTS[key];
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit src/store/model-routing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck && bun run lint
git add src/store/model-routing.ts src/store/model-routing.test.ts
git commit -m "feat(model-routing): store helper with keys, defaults, and Zod schema"
```

---

## Task 2: Seed migration

**Files:**
- Create: `src/store/migrations/030_model_routing_seed.sql`
- Modify: `src/store/migrations/index.ts`

**Interfaces:**
- Consumes: `config_overrides(namespace, key, value_json, updated_at)` table (exists)
- Produces: 8 seeded rows in namespace `model-routing`

- [ ] **Step 1: Write the migration**

```sql
-- src/store/migrations/030_model_routing_seed.sql
-- Seed per-process model routes. Values mirror the prior hardcoded defaults.
-- Idempotent: DO NOTHING preserves any operator-customized rows on re-run.
INSERT INTO config_overrides (namespace, key, value_json, updated_at) VALUES
  ('model-routing', 'signal.facets',       '{"provider":"alibaba","model":"deepseek-v4-flash"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'signal.observations', '{"provider":"alibaba","model":"deepseek-v4-flash"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.fast-agent',     '{"provider":"anthropic","model":"claude-haiku-4-5-20251001"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.judge.0',        '{"provider":"anthropic","model":"claude-haiku-4-5"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.judge.1',        '{"provider":"openrouter","model":"deepseek/deepseek-chat-v3.1"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.judge.2',        '{"provider":"alibaba","model":"qwen3.7-plus"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'pipeline.generator',  '{"provider":"anthropic","model":"claude-sonnet-4-6"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'agent-templates',     '{"provider":"agent-sdk","model":"claude-haiku-4-5"}', EXTRACT(EPOCH FROM now())::bigint)
ON CONFLICT (namespace, key) DO NOTHING;
```

- [ ] **Step 2: Register in `index.ts`**

Read `src/store/migrations/index.ts` and add the `030_model_routing_seed.sql` entry following the exact pattern used for `029_mem0_chunk_map.sql` (same import/array style).

- [ ] **Step 3: Verify migration applies**

Run: `docker compose up -d postgres` (if not native) then `bun run test:integration src/store/config-overrides.integration.test.ts` to confirm migrations run clean. Alternatively run a standalone migrate via the project's startup path.
Expected: migrations apply without error; `SELECT count(*) FROM config_overrides WHERE namespace='model-routing'` returns 8.

- [ ] **Step 4: Commit**

```bash
git add src/store/migrations/030_model_routing_seed.sql src/store/migrations/index.ts
git commit -m "feat(model-routing): seed migration for 8 process routes"
```

---

## Task 3: API route

**Files:**
- Create: `src/web/routes/model-routing.ts`
- Create: `src/web/routes/model-routing.integration.test.ts`
- Modify: route registration (mount alongside existing routes — match how `features.ts` routes are registered)

**Interfaces:**
- Consumes: `getAllModelRoutes`, `setModelRoute`, `isModelRoutingKey`, `modelRouteSchema`, `MODEL_ROUTING_KEYS` from `../../store/model-routing`
- Produces:
  - `GET /api/model-routing` → `{ routes: { key, provider, model }[] }`
  - `PUT /api/model-routing/:key` → `{ key, provider, model }`

- [ ] **Step 1: Write the failing integration test**

```ts
// src/web/routes/model-routing.integration.test.ts
import { describe, expect, test, beforeAll } from "bun:test";
// Follow the harness used by pipelines.integration.test.ts to build the Hono app
// and an authed request helper (bearer OPENCROW_WEB_TOKEN).
import { makeTestApp, authed } from "./__test-helpers"; // adjust import to match repo's actual helper

describe("model-routing API", () => {
  let app: ReturnType<typeof makeTestApp>;
  beforeAll(async () => {
    app = makeTestApp();
  });

  test("GET returns all 8 routes after seed", async () => {
    const res = await app.request(authed("/api/model-routing"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routes.length).toBe(8);
  });

  test("PUT updates a route and reads back", async () => {
    const res = await app.request(
      authed("/api/model-routing/signal.facets", {
        method: "PUT",
        body: JSON.stringify({ provider: "openrouter", model: "x/y" }),
      }),
    );
    expect(res.status).toBe(200);
    const get = await (await app.request(authed("/api/model-routing"))).json();
    const row = get.routes.find((r: { key: string }) => r.key === "signal.facets");
    expect(row.provider).toBe("openrouter");
    expect(row.model).toBe("x/y");
  });

  test("PUT unknown key → 404", async () => {
    const res = await app.request(
      authed("/api/model-routing/nope", {
        method: "PUT",
        body: JSON.stringify({ provider: "alibaba", model: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("PUT invalid provider → 400", async () => {
    const res = await app.request(
      authed("/api/model-routing/signal.facets", {
        method: "PUT",
        body: JSON.stringify({ provider: "bogus", model: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
```

> Note for implementer: inspect `src/web/routes/pipelines.integration.test.ts` for the EXACT app-construction + auth helper. Mirror it; do not invent `__test-helpers` if the repo uses a different pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker compose up -d postgres && bun run test:integration src/web/routes/model-routing.integration.test.ts`
Expected: FAIL — route not mounted (404 on GET).

- [ ] **Step 3: Implement the route**

```ts
// src/web/routes/model-routing.ts
import type { Hono } from "hono";
import { z } from "zod";
import { createLogger } from "../../logger";
import {
  getAllModelRoutes,
  setModelRoute,
  isModelRoutingKey,
  modelRouteSchema,
} from "../../store/model-routing";

const log = createLogger("routes:model-routing");

export function registerModelRoutingRoutes(app: Hono): void {
  app.get("/model-routing", async (c) => {
    const all = await getAllModelRoutes();
    const routes = Object.entries(all).map(([key, route]) => ({ key, ...route }));
    return c.json({ routes });
  });

  app.put("/model-routing/:key", async (c) => {
    const key = c.req.param("key");
    if (!isModelRoutingKey(key)) {
      return c.json({ error: `unknown model-routing key: ${key}` }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = modelRouteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid route", details: parsed.error.flatten() }, 400);
    }
    await setModelRoute(key, parsed.data);
    log.info("Model route updated", { key, provider: parsed.data.provider, model: parsed.data.model });
    return c.json({ key, ...parsed.data });
  });
}
```

- [ ] **Step 4: Mount the route**

Find where routes like `features` are registered onto the app (grep `registerFeature` or `features` in `src/web/`). Add `registerModelRoutingRoutes(app)` in the same place, under the same `/api` base prefix.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test:integration src/web/routes/model-routing.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck && bun run lint
git add src/web/routes/model-routing.ts src/web/routes/model-routing.integration.test.ts <route-registration-file>
git commit -m "feat(model-routing): GET/PUT API with key + provider validation"
```

---

## Task 4: OpenCode provider in `chat()`

**Files:**
- Create: `src/agent/opencode-direct.ts`
- Modify: `src/agent/chat.ts:135-169` (add `opencode` branch), `src/agent/types.ts` (provider type)

**Interfaces:**
- Consumes: `AgentOptions`, `AgentResponse`, `ConversationMessage` from `./types`
- Produces: `export async function chat(messages, options): Promise<AgentResponse>` in `opencode-direct.ts`

- [ ] **Step 1: Extend provider type**

In `src/agent/types.ts`, find the provider union (currently `"openrouter" | "agent-sdk" | "alibaba" | "anthropic"`) and add `| "opencode"`.

- [ ] **Step 2: Implement `opencode-direct.ts`**

Mirror `src/agent/alibaba-direct.ts` exactly (same structure: read base URL + key, OpenAI-compatible POST, map response to `AgentResponse`, tag `provider: "opencode"`). Key differences:
- Endpoint: `${OPENCODE_BASE_URL}/zen/go/v1/chat/completions` (base default `https://` Go endpoint; read `process.env.OPENCODE_BASE_URL` and `process.env.OPENCODE_API_KEY`)
- Thinking disabled via request field `thinking: { type: "disabled" }` (NOT `enable_thinking`)
- If no API key: log a warning and throw a clear error (same graceful pattern as alibaba-direct's missing-key path)

> Implementer: read `src/agent/alibaba-direct.ts` in full and copy its shape. Do not introduce new HTTP utilities.

- [ ] **Step 3: Add the `chat.ts` branch**

In `src/agent/chat.ts`, after the `anthropic` branch (line ~161-166) and before the `else throw`, add:

```ts
  } else if (provider === "opencode") {
    log.debug("Routing to OpenCode direct", {
      agentId: options.agentId,
      model: options.model,
    });
    response = await chatOpenCodeDirect(messages, options);
```

And add the import at top: `import { chat as chatOpenCodeDirect } from "./opencode-direct";`

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: clean (no unknown-provider errors).

- [ ] **Step 5: Commit**

```bash
git add src/agent/opencode-direct.ts src/agent/chat.ts src/agent/types.ts
git commit -m "feat(agent): add opencode provider to chat() dispatch"
```

---

## Task 5: Wire callsites — signal facets + enrichment

**Files:**
- Modify: `src/memory/signal-facets.ts:138,175`, `src/memory/signal-enrichment.ts:19,203`

**Interfaces:**
- Consumes: `getModelRoute` from `../store/model-routing`

- [ ] **Step 1: Update `signal-facets.ts`**

Replace the hardcoded `model = "deepseek-v4-flash"` default and `provider: "alibaba"` with a route lookup. At the top of `extractSignalFacetsBatch`, resolve once:

```ts
const route = await getModelRoute("signal.facets");
const model = opts.model ?? route.model;
const provider = route.provider;
```

Then in the `chat(...)` options use `provider` instead of the literal `"alibaba"`. Add `import { getModelRoute } from "../store/model-routing";`. Remove the literal default in the destructure (keep `opts.model` override path).

- [ ] **Step 2: Update `signal-enrichment.ts`**

Remove `const DEFAULT_RANK_MODEL = "deepseek-v4-flash";`. Where `const model = opts.model ?? DEFAULT_RANK_MODEL;` was, use:

```ts
const model = opts.model ?? (await getModelRoute("signal.facets")).model;
```

Add the import. Confirm the surrounding function is already `async` (it is).

- [ ] **Step 3: Update signal-facets unit test**

Add to `src/memory/signal-facets.test.ts` — but note `extractSignalFacetsBatch` calls `chat` and `getModelRoute` (DB). For a pure unit test, prefer testing via the existing parse tests and defer the route-wiring assertion to Task 9's isolated test. If a quick check is cheap, mock both via an isolated test instead. (No new assertion required here if it needs DB.)

- [ ] **Step 4: Typecheck + unit lane**

Run: `bun run typecheck && bun run test:unit src/memory/signal-facets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memory/signal-facets.ts src/memory/signal-enrichment.ts
git commit -m "feat(memory): route signal facet/enrichment model via model-routing"
```

---

## Task 6: Wire callsites — observation extractor

**Files:**
- Modify: `src/memory/observation-extractor.ts:97-98`

- [ ] **Step 1: Update `observation-extractor.ts`**

Before the `chat(...)` call, resolve the route:

```ts
const route = await getModelRoute("signal.observations");
```

Replace the literal `model: "deepseek-v4-flash", provider: "alibaba"` with `model: route.model, provider: route.provider`. Add `import { getModelRoute } from "../store/model-routing";`.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/memory/observation-extractor.ts
git commit -m "feat(memory): route observation extractor model via model-routing"
```

---

## Task 7: Wire callsites — SIGE fast-agent + judges + pipeline generator

**Files:**
- Modify: `src/sige/auto/scheduler.ts:24,50-57`, `src/config/schema.ts` (judge consumers + provider enums), pipeline generator consumer

**Interfaces:**
- Consumes: `getModelRoute`, `getAllModelRoutes` from `../../store/model-routing`

- [ ] **Step 1: SIGE fast-agent**

In `src/sige/auto/scheduler.ts`, remove the `FAST_AGENT_MODEL` constant. `buildFastProfile()` becomes async (or accept the model as a param resolved by caller). Simplest: make `buildFastProfile` take a `model: string` argument and have the caller (the tick path) do `const { model } = await getModelRoute("sige.fast-agent")` and pass it in. Update the `agentModel: model` field accordingly. Adjust the one call site.

- [ ] **Step 2: SIGE judges**

Find consumers of `SIGE_DEFAULT_JUDGE_MODELS` (grep). At the assembly point, replace the constant read with a runtime route read:

```ts
const all = await getAllModelRoutes();
const judgeModels = [all["sige.judge.0"], all["sige.judge.1"], all["sige.judge.2"]];
```

Leave the `sigeHardeningConfigSchema.judgeModels` schema field intact for backward compat, but the runtime default now comes from routes. Keep `SIGE_DEFAULT_JUDGE_MODELS` only if other code still imports it; otherwise remove.

- [ ] **Step 3: Pipeline generator**

Find where `smart.provider` / `smart.model` (schema.ts:551-552) are consumed for idea generation (grep `\.smart\.provider` / `config.*\.model`). At that consumer, resolve `const route = await getModelRoute("pipeline.generator")` and prefer it; the smart fields become an explicit override only if the operator set a non-default. Document with a one-line comment that model-routing is now the source of truth.

- [ ] **Step 4: Provider enums add opencode**

In `src/config/schema.ts`, every `z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic"])` becomes `z.enum(["openrouter", "agent-sdk", "alibaba", "anthropic", "opencode"])`. Grep for all occurrences (also `src/web/ui/lib/schemas.ts`, `src/web/routes/sige.ts`, `src/web/routes/agents.ts`, `src/sige/types.ts`, etc.) and update each.

- [ ] **Step 5: Typecheck + relevant tests**

Run: `bun run typecheck && bun run test:unit`
Expected: clean / green. Fix any test asserting the old enum or constant.

- [ ] **Step 6: Commit**

```bash
git add src/sige/auto/scheduler.ts src/config/schema.ts src/web/ui/lib/schemas.ts <other-enum-files> <pipeline-consumer> <judge-consumer>
git commit -m "feat(sige,pipeline): route fast-agent/judges/generator via model-routing; add opencode to provider enums"
```

---

## Task 8: Agent tool templates callsite

**Files:**
- Modify: `src/tools/agent-templates.ts:29,43,64`

- [ ] **Step 1: Resolve route in the template builder**

The default `claude-haiku-4-5` for `provider: "agent-sdk"` templates should come from `getModelRoute("agent-templates")`. If the template factory is currently synchronous, make the entry that builds defaults async and resolve the route there; pass `route.provider`/`route.model` into the seed defaults. Keep `seed.model ?? route.model` override semantics.

> Implementer: read the full file first — it may export pure constants consumed synchronously. If so, convert the consumer that materializes templates into an async path, or resolve the route once at the call boundary and inject. Do not block module top-level on a DB read.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/tools/agent-templates.ts <any-consumer-touched>
git commit -m "feat(tools): route agent template model via model-routing"
```

---

## Task 9: Isolated test — observation extractor uses route

**Files:**
- Create: `src/memory/observation-extractor.isolated.test.ts`

- [ ] **Step 1: Write the isolated test**

```ts
// src/memory/observation-extractor.isolated.test.ts
import { describe, expect, test, mock, beforeEach } from "bun:test";

// Mock the NARROWEST deps: the route store and chat. (isolated lane: one process)
const chatMock = mock(async () => ({ text: "[]", provider: "alibaba" }));
mock.module("../store/model-routing", () => ({
  getModelRoute: mock(async () => ({ provider: "opencode", model: "opencode-sonnet" })),
}));
mock.module("../agent/chat", () => ({ chat: chatMock }));

describe("observation extractor model routing", () => {
  beforeEach(() => chatMock.mockClear());

  test("passes provider+model from the route into chat()", async () => {
    const { extractObservations } = await import("./observation-extractor");
    await extractObservations({
      agentId: "a", channel: "telegram", chatId: "c",
      conversation: [{ role: "user", content: "hello", timestamp: 1 }],
    } as never);
    expect(chatMock).toHaveBeenCalled();
    const opts = chatMock.mock.calls[0]?.[1] as { provider: string; model: string };
    expect(opts.provider).toBe("opencode");
    expect(opts.model).toBe("opencode-sonnet");
  });
});
```

> Implementer: adjust `extractObservations` argument shape to the real signature (read the file). The assertion that matters: `chat` receives provider/model from `getModelRoute`, not a literal.

- [ ] **Step 2: Run**

Run: `bun run test:isolated src/memory/observation-extractor.isolated.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/memory/observation-extractor.isolated.test.ts
git commit -m "test(memory): verify observation extractor reads model from route"
```

---

## Task 10: Shared model-lists lib + ModelTab refactor

**Files:**
- Create: `src/web/ui/lib/model-lists.ts`
- Modify: `src/web/ui/views/agents/agent-form/ModelTab.tsx`

**Interfaces:**
- Produces:
  - `ANTHROPIC_MODELS: readonly string[]`
  - `AGENT_SDK_MODELS: readonly string[]`
  - `ALIBABA_MODEL_GROUPS: readonly { label: string; models: readonly string[] }[]`
  - `OPENCODE_MODELS: readonly string[]`
  - `PROVIDER_LABELS: Record<string, string>`

- [ ] **Step 1: Extract lists**

Create `src/web/ui/lib/model-lists.ts` containing the exact model strings currently inlined in `ModelTab.tsx` (anthropic/agent-sdk: `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5`; the full Alibaba optgroups; opencode: `["opencode-sonnet", "opencode-opus"]`). Add `PROVIDER_LABELS = { "agent-sdk": "Agent SDK", anthropic: "Anthropic (OAuth)", openrouter: "OpenRouter", alibaba: "Alibaba ModelStudio", opencode: "OpenCode" }`.

- [ ] **Step 2: Refactor ModelTab to consume the lib**

Replace the inline `<option>` lists with `.map` over the imported constants. Add the OpenCode provider `<option>` and an OpenCode model branch (dropdown from `OPENCODE_MODELS`).

- [ ] **Step 3: Typecheck + UI build**

Run: `bun run typecheck && bun run tw:build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/web/ui/lib/model-lists.ts src/web/ui/views/agents/agent-form/ModelTab.tsx
git commit -m "refactor(ui): extract shared model lists; add opencode to ModelTab"
```

---

## Task 11: ModelRoutePicker component

**Files:**
- Create: `src/web/ui/components/ModelRoutePicker.tsx`

**Interfaces:**
- Consumes: `apiFetch` (repo's authed fetch client), the model-lists lib
- Produces: `export function ModelRoutePicker({ processKey, label }: { processKey: string; label: string })`

- [ ] **Step 1: Implement the component**

A controlled provider `<select>` + model selector (dropdown for anthropic/agent-sdk/alibaba/opencode, free-text `<input>` for openrouter). On mount, `GET /api/model-routing` once at parent level OR fetch single; simplest: parent passes the current route in and the picker `PUT`s on change. To keep it self-contained: fetch all routes on mount, pick `processKey`. On change, debounce 500ms then `PUT /api/model-routing/${processKey}` with `{ provider, model }`; show inline "Saved"/error. Reuse the toast helpers used in `Settings.tsx` (`success`, `toastError`).

> Implementer: match the fetch/save pattern in `Settings.tsx`'s scraper-config form (`apiFetch`, `useState`, dirty tracking). Follow existing component styling (`SELECT_CLS`, labels).

- [ ] **Step 2: Typecheck + build**

Run: `bun run typecheck && bun run tw:build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/ui/components/ModelRoutePicker.tsx
git commit -m "feat(ui): ModelRoutePicker — provider+model picker with debounced save"
```

---

## Task 12: Embed pickers in the four views

**Files:**
- Modify: `src/web/ui/views/Memory.tsx`, `src/web/ui/views/Sige.tsx`, `src/web/ui/views/PipelineIdeas.tsx`, and the Agents global-defaults view

- [ ] **Step 1: Memory view**

Add a "Model Configuration" card with two pickers:
`<ModelRoutePicker processKey="signal.facets" label="Signal Facets" />` and `<ModelRoutePicker processKey="signal.observations" label="Observation Extraction" />`.

- [ ] **Step 2: Sige view**

Add a "Model Configuration" section with four pickers: `sige.fast-agent` ("Fast Agent (auto)"), `sige.judge.0/1/2` ("Judge 0/1/2").

- [ ] **Step 3: PipelineIdeas view**

Add one picker: `pipeline.generator` ("Generator").

- [ ] **Step 4: Agents view**

Add a "Tool Template Model" card: `agent-templates` ("Agent Templates").

- [ ] **Step 5: Typecheck + build + commit**

```bash
bun run typecheck && bun run tw:build
git add src/web/ui/views/Memory.tsx src/web/ui/views/Sige.tsx src/web/ui/views/PipelineIdeas.tsx <agents-view-file>
git commit -m "feat(ui): embed model-routing pickers in Memory/Sige/Pipeline/Agents views"
```

---

## Task 13: Final verification + security review

- [ ] **Step 1: Full typecheck + lint + all test lanes**

Run: `bun run typecheck && bun run lint && bun run test:unit && docker compose up -d postgres && bun run test:integration && bun run test:isolated && bun run tw:build`
Expected: all green. Paste any failures and fix.

- [ ] **Step 2: Security review**

Dispatch `security-reviewer` on the full diff. Focus: PUT endpoint auth (bearer), no SSRF via opencode base URL (env-only, not user-supplied), Zod validation on the body, no secret leakage in logs. Fix CRITICAL/HIGH.

- [ ] **Step 3: QA coverage check**

Dispatch `qa-test-engineer` to confirm 80%+ coverage on the new store + route + provider files. Add tests for gaps.

---

## Self-Review

**Spec coverage:**
- All 8 keys → Tasks 5–8 (callsites) + Task 1 (store) + Task 2 (seed). ✓
- API GET/PUT → Task 3. ✓
- Hot reload (read-at-call) → Task 1 `getModelRoute` reads DB each call. ✓
- Configurable fallback (seed not hardcoded) → Task 2 seed; Task 1 default only as last-resort safety. ✓
- OpenCode provider → Task 4 (chat), Task 7 (enums), Tasks 10–11 (UI). ✓
- UI in Memory/Sige/PipelineIdeas/Agents → Task 12. ✓
- SIGE judge = 3 fixed slots → Task 7 reads judge.0/1/2. ✓
- Tests across 3 lanes → Tasks 1, 3, 9, 13. ✓

**Placeholder scan:** Implementer notes ("read the file", "match the pattern") point at concrete existing files to mirror, not vague TODOs — acceptable because exact helper/signature names differ in-repo and must be matched, not invented. Code blocks provided for every new module.

**Type consistency:** `ModelRoute`, `ModelRoutingKey`, `ModelProvider`, `getModelRoute`, `getAllModelRoutes`, `setModelRoute`, `isModelRoutingKey`, `modelRouteSchema` used consistently across Tasks 1, 3, 5–8, 9. Provider enum `"anthropic" | "alibaba" | "openrouter" | "agent-sdk" | "opencode"` consistent across store, schema, chat, UI.
