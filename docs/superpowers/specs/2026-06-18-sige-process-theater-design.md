# SIGE Process Theater — Design Specification

## Overview

Replace the bare in-progress view of a SIGE session (a single progress bar +
"Session running…" spinner) with a **live "Process Theater"**: a vertical
timeline of five stage panels that fill in and animate as the run unfolds,
auto-scrolling to the active stage. It serves as both the **live** view and the
**completed** view (when done, every panel is populated).

Decisions locked with the user:
- **Whole-process theater** — all five stages visualized in one view.
- **Stage reveal + client-side animation** — each panel reveals when its STAGE
  completes (using the already-incremental DB persistence); rich client-side
  animation replays the detail. NO backend game-loop refactor / per-round
  streaming.
- **Vertical timeline layout** — full-width stacked panels, auto-scroll to the
  running stage.

## Architecture

```
SessionDetail.tsx
  └─ <ProcessTheater session={...} sessionId={...} />   (live + completed)
        ├─ poll GET /api/sige/sessions/:id every 3s (existing) → status + artifacts
        ├─ SSE GET /api/sige/sessions/:id/stream (existing) → low-latency status
        ├─ lazy GET /api/sige/sessions/:id/graph (NEW) when KG stage reached
        ├─ lazy GET /api/sige/sessions/:id/ideas | /population (existing)
        └─ renders 5 <StagePanel>:
             1 KnowledgeGraphStage   (React Flow)
             2 GameSetupStage        (cards)
             3 ExpertGameStage       (round replay; React Flow + ECharts gauges)
             4 SocialSimStage         (citizen grid + ECharts)
             5 ScoredIdeasStage      (ECharts diverging bars)
        └─ Report shown as final section (existing ReportTab)
        └─ legacy completed-only tabs tucked behind a "Details ▸" expander
```

**Default-safe:** the theater is additive UI. The existing routes/tabs stay; the
theater becomes the primary view. No backend behavior changes except one new
read-only endpoint.

## Backend (one new endpoint)

`src/web/routes/sige.ts` — add:

```
GET /api/sige/sessions/:id/graph
  → getFullGraph(mem0, userId)  (src/sige/knowledge/graph-query.ts)
  → { success: true, data: { nodes: GraphNode[], edges: GraphEdge[], summary } }
  → on Mem0 failure / breaker-open: { success: true, data: { nodes: [], edges: [], summary: "" } }
     (graceful empty — NEVER 500; the panel renders an "unavailable" state)
```

- The route handler constructs/obtains the shared `Mem0Client` the same way the
  existing SIGE routes do (or instantiates from config `sige.mem0.baseUrl`), and
  uses `userId = sige.mem0.userId` (global graph). The `:id` is accepted for
  forward-compatibility (future per-session snapshot) but the MVP returns the
  global graph.
- Brief in-memory cache (e.g. 10s TTL keyed by userId) to avoid hammering Mem0
  while the panel polls.

Data shapes (already defined — DO NOT redefine):
- `GraphView` / `GraphNode` / `GraphEdge` — `src/sige/knowledge/graph-query.ts`
  (node: `{uuid, name, entityType, summary?}`; edge: `{uuid, sourceNodeUuid,
  targetNodeUuid, relationType, fact, weight?}`).
- `GameFormulation`, `ExpertGameResult` (rounds, equilibria, rankedIdeas,
  metaGameHealth), `SocialSimResult` (citizenActions, adoptionRates,
  sentimentDistribution, remixVariants), `FusedScore` — `src/sige/types.ts`.
  Implementers MUST read these for exact field names.

## Frontend components (small, focused — `src/web/ui/views/sige/`)

### `theater/ProcessTheater.tsx`
- Props: `{ session: SigeSessionDetail; sessionId: string }`.
- Owns: data fetching (reuse `fetchSession` poll already in SessionDetail — pass
  `session` down rather than double-polling; add a `useGraph(sessionId)` hook for
  the new endpoint, fetched once the KG stage is active/reached), the ordered
  stage list, active-stage derivation from `session.status`, and auto-scroll to
  the active panel (`scrollIntoView` on status change, respect
  `prefers-reduced-motion`).
- Renders the 5 `StagePanel`s + a final Report section.
- Stage → status mapping (drives done/running/waiting):
  `knowledge_construction → KG`, `game_formulation → GameSetup`,
  `expert_game → ExpertGame`, `social_simulation → SocialSim`,
  `scoring → ScoredIdeas`, `report_generation/completed → all done`.
  A stage is `done` when its artifact is non-null OR status is past it;
  `running` when it is the current status; `waiting` otherwise.

### `theater/StagePanel.tsx`
- Generic shell: header (index, title, status icon, optional summary stat),
  `glow` ring when active, skeleton placeholder when `waiting`, fade/slide reveal
  when transitioning to `done`/`running`. Children = the stage viz.
- Pure presentational; no data fetching.

### `theater/stages/KnowledgeGraphStage.tsx`
- React Flow (`@xyflow/react`) node-link graph from `GraphView`.
- Nodes colored by `entityType`; edge label = `relationType`; hover/title = `fact`.
- Force/sane auto-layout (simple radial or dagre-free spring; cap ~100 nodes,
  ~200 edges — already capped server-side). Empty state: "Knowledge graph
  unavailable (Mem0 offline or empty)".

### `theater/stages/GameSetupStage.tsx`
- From `gameFormulation`: game-type badge (one of 9), `players` as persona cards
  (name + strategy-space count + a couple of strategies), `moveSequence`,
  constraints count. Static (no animation needed beyond reveal).

### `theater/stages/ExpertGameStage.tsx` (centerpiece)
- From `expertResult`: a **client-side replay of the 4 rounds**. A play/scrubber
  control + auto-play. For each round, render the round's `agentActions`/
  `outcomes` (`selectedIdeas`, `eliminatedIdeas`, `coalitions`, `equilibria`):
  idea cards appear, eliminated fade out, selected highlight, coalitions group.
  Equilibria shown as badges (type + stability). `metaGameHealth`
  (diversityIndex, convergenceRate, noveltyScore, agentBalanceScores) as small
  ECharts gauges/bars.
- Pure transform `expertResultToFrames(expertResult)` → ordered frames; unit-tested.
- Use React Flow OR a simple absolutely-positioned card layout with CSS
  transitions; implementer's choice, but keep it performant (≤ ~50 idea nodes).

### `theater/stages/SocialSimStage.tsx`
- From `socialResult`: a grid/swarm of citizen dots colored by `actionType`
  (adopt/resist/remix/combine/oppose/ignore), animating in. Plus adoption-rate
  bars per idea (`adoptionRates`) and sentiment distribution
  (`sentimentDistribution`) via ECharts. `remixVariants` listed compactly.

### `theater/stages/ScoredIdeasStage.tsx`
- From `fusedScores` (or `fetchSessionIdeas`): ranked ideas with expert-vs-social
  **diverging bars** + `fusedScore` + `breakdown` (IncentiveBreakdown) on hover.
  Reuse logic/format from the existing `IdeasTab.tsx` where practical.

### Data + hooks
- `theater/transforms.ts` — PURE helpers: `expertResultToFrames`,
  `socialResultToGrid`, `fusedScoresToChart`, `graphViewToFlow`
  (nodes/edges → React Flow `Node[]`/`Edge[]`). Unit-tested.
- `api.ts` — add `fetchSessionGraph(sessionId)` for the new endpoint.

### Integration into `SessionDetail.tsx`
- Render `<ProcessTheater session={session} sessionId={sessionId} />` for BOTH
  in-progress and completed states (replacing the bare spinner block and serving
  as the completed view). Keep the existing tab components behind a collapsed
  "Details ▸" expander so no functionality is lost. Keep the slim top
  status/progress affordance (existing `ProgressBar`) above the theater.

## Data flow

1. `SessionDetail` polls `fetchSession(sessionId)` every 3s (existing) → passes
   `session` to `ProcessTheater`. Artifacts (`gameFormulation`, `expertResult`,
   `socialResult`, `fusedScores`, `report`) appear incrementally as stages
   complete (run.ts persists each stage's JSON when it finishes).
2. `ProcessTheater` derives each panel's state and renders the matching viz when
   its artifact is present; otherwise a skeleton.
3. The KG panel fetches `/graph` lazily (once) when the KG stage is reached.
4. On terminal status, polling stops (existing behavior); all panels are filled.

## Error handling

- `/graph` failure or Mem0 breaker-open → empty `GraphView` → KG panel shows an
  "unavailable" state. Never throws.
- Artifact null (stage not reached) → skeleton/waiting.
- Failed session → render whatever stages completed + the error banner (existing).
- Malformed/short artifacts (e.g. empty broad pool) → each stage shows a graceful
  "no data for this stage" state rather than crashing. All `.length`/`.map`
  accesses on session artifacts MUST be null-guarded (see the prior null-seed
  crash — `seedInput` is `string | null`; treat all artifact fields as optional).

## Testing

- `theater/transforms.test.ts` (unit): `expertResultToFrames` orders rounds &
  marks selected/eliminated; `socialResultToGrid` buckets citizens by action;
  `fusedScoresToChart` shapes expert/social bars; `graphViewToFlow` maps
  nodes/edges and tolerates empty input.
- Component render smoke tests (happy-dom) for `StagePanel` (waiting/running/done
  states) and each stage with (a) populated and (b) empty/null artifacts → no
  crash. Match the project's UI unit lane (`*.test.ts`).
- Route: extend `src/web/routes/sige.test.ts` (or isolated) — `/graph` returns
  `{nodes:[],edges:[]}` gracefully when Mem0 is unavailable.

## Performance

- React Flow capped at server-side node/edge limits (~100/200).
- Expert-game replay uses CSS transitions / rAF; cap rendered idea nodes (~50).
- Poll stays 3s; stop on terminal. Graph fetched once, 10s server cache.

## Build order

1. Backend: `/graph` endpoint + 10s cache + graceful-empty + `api.ts`
   `fetchSessionGraph`.
2. `transforms.ts` (+ tests) — pure, no UI deps. Establishes the shared data
   contracts the stages consume.
3. `StagePanel.tsx` shell.
4. `ProcessTheater.tsx` container (fetch/poll wiring, active-stage, auto-scroll).
5. Stage components in order: KnowledgeGraph → GameSetup → ExpertGame →
   SocialSim → ScoredIdeas.
6. Integrate into `SessionDetail.tsx` (theater primary; legacy tabs behind
   "Details ▸").
7. Tests (transforms unit + component smoke + route).
8. `bun run typecheck`, `bun run lint`, UI unit lane, `bun run tw:build` (styles).

## Rollout

Additive, no flag needed (it's a view change with one read-only endpoint).
Ship behind normal review; verify with a live autonomous session that the
theater reveals stages correctly and never crashes on null/partial artifacts.
