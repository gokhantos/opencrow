# Native macOS Stack for OpenCrow (de-Colima)

**Date:** 2026-06-20
**Status:** Approved design — pending implementation plan
**Author:** brainstorming session

## Problem

This Mac runs OpenCrow's full stack inside a Colima (Apple Virtualization.framework)
Linux VM via Docker Compose. The VM is allocated **16GiB RAM + 8 vCPU** but the
actual workload inside it is ~2.8GB (app 1.9GB, mem0 456MB, postgres 270MB,
qdrant 150MB). macOS holds the full VM allocation resident (~13GB RSS) and does not
balloon it back, so a 24GB machine sits with <1GB free and ~7GB of swap in use —
constant swap thrash. The VM disk also consumes ~38GB on host.

OpenCrow does **not** run on a Linux server today; this Mac is both the dev machine
and the always-on ("production") instance. Docker/Colima therefore buys nothing here
except overhead.

## Goal

Run the full stack **natively on macOS** and tear down the local Colima VM
(reclaims ~13GB RAM + ~38GB disk). Keep `docker-compose.yml`, the root `Dockerfile`,
and `mem0-server/Dockerfile` **intact** as the future Linux-server deploy path —
this is additive (native becomes the default local stack), not a deletion of Docker
support.

### Non-goals

- No change to CI. CI runs on Linux GitHub runners with Docker and is unaffected by
  removing local Colima.
- No removal of `docker-compose.yml` / Dockerfiles (kept for "server later").
- No app source changes (see below — config defaults already target loopback).

## Key enabling facts

The app needs **zero code changes**. Its config defaults (`src/config/schema.ts`)
already target native loopback, matching the ports the containers publish today:

| Service | App default | Container publishes |
|---|---|---|
| Postgres | `postgres://opencrow:opencrow@127.0.0.1:5432/opencrow` | `127.0.0.1:5432` |
| Qdrant | `http://127.0.0.1:6333` | `127.0.0.1:6333` |
| mem0 | `http://127.0.0.1:8050` | `127.0.0.1:8050` |

The compose file *overrides* these to container names (`postgres`, `qdrant`, `mem0`)
only because containers share a Docker network. Run the app natively with no
overrides and it already points at the native loopback services.

Additional enablers:
- **Ollama is already native** (host `:11434`); mem0 reaches embeddings via
  `host.docker.internal` today → becomes `127.0.0.1` natively. `nomic-embed-text`
  already pulled.
- The repo already ships a **launchd daemon + service CLI**
  (`src/daemon/launchd.ts`, `src/cli/service.ts`, `setup.ts`, `doctor.ts`) — OpenCrow
  is designed to run as a native macOS service. Docker is just one deployment mode.
- mem0-server reads all config from env (`QDRANT_HOST`, `MEM0_OLLAMA_URL`,
  `MEM0_LLM_*`, `MEM0_GRAPH_DB`, `MEM0_API_TOKEN`), so native = set env + run uvicorn.

## Decisions (locked)

- **Scope:** full de-Dockerize locally; keep compose/Dockerfiles for a future server.
- **Orchestration:** Homebrew + launchd (least new code, idiomatic macOS, reboot-safe).
- **Data:** migrate existing Postgres + Qdrant + mem0 data from the Docker volumes.
- **Postgres durability:** drop the dev `fsync=off` / `synchronous_commit=off` /
  `full_page_writes=off` tuning — keep durable defaults (this is a 24/7 instance).
- **Qdrant binary location:** `~/.opencrow/bin/qdrant` (self-contained, no sudo).

## Architecture

### 1. Native services layer

| Service | How it runs | Listens | Lifecycle |
|---|---|---|---|
| Postgres 17 | `brew install postgresql@17` (keg-only); create role+db `opencrow` | `127.0.0.1:5432` | `brew services` |
| Qdrant v1.13.2 | Official macOS **arm64 release binary** at `~/.opencrow/bin/qdrant`, pinned to match existing storage format | `127.0.0.1:6333` | launchd plist |
| mem0 | Python 3.11 venv in `mem0-server/.venv` → `uvicorn app:app --port 8050` | `127.0.0.1:8050` | launchd plist |

mem0 env (moved from the compose block into the plist / a `mem0-server/.env`):
- `QDRANT_HOST=127.0.0.1`, `QDRANT_PORT=6333`
- `MEM0_OLLAMA_URL=http://127.0.0.1:11434`, `MEM0_EMBED_MODEL=nomic-embed-text:latest`,
  `MEM0_EMBED_DIMS=768`
- `MEM0_GRAPH_PROVIDER=kuzu`, `MEM0_GRAPH_DB=~/.opencrow/mem0/kuzu`
- `MEM0_API_TOKEN=$OPENCROW_INTERNAL_TOKEN`
- `MEM0_LLM_PROVIDER=openai`, `MEM0_LLM_MODEL=deepseek-v4-flash`,
  `MEM0_LLM_BASE_URL=…aliyuncs.com/compatible-mode/v1`,
  `MEM0_LLM_API_KEY=$MEM0_LLM_API_KEY`, `MEM0_LLM_DISABLE_THINKING=true`
- `MEM0_COLLECTION=sige_mem0`

Qdrant storage → `~/.opencrow/qdrant/storage`. Postgres uses the brew-managed data
dir (`/opt/homebrew/var/postgresql@17`).

### 2. App layer — unchanged

- Always-on: `bun run src/cli.ts service core install` + `service web install`
  (existing launchd installers).
- Dev: `bun run dev`.
- No env overrides — loopback defaults apply. `.env` supplies existing secrets
  (`OPENCROW_INTERNAL_TOKEN`, `MEM0_LLM_API_KEY`, optional provider keys).

### 3. Automation (reuse existing CLI/daemon)

- Extend `src/cli/setup.ts` + `src/cli/doctor.ts` with a **native path**:
  - check/install brew deps (`postgresql@17`, `python@3.11`),
  - fetch + place the pinned Qdrant arm64 binary in `~/.opencrow/bin`,
  - create the Python venv and `pip install -r mem0-server/requirements.txt`,
  - create the Postgres role/db `opencrow` (idempotent),
  - render the Qdrant + mem0 launchd plists via the existing
    `src/daemon/launchd.ts` unit-builder,
  - verify all four ports (`doctor` is the health gate).
- One-shot migration script `scripts/migrate-to-native.sh`:
  - `pg_dump` from `opencrow-postgres-1` → restore into native PG,
  - copy Qdrant `storage/` and mem0 `/data` (Kùzu graph + vectors) out of the Docker
    volumes into `~/.opencrow/qdrant` and `~/.opencrow/mem0`.

### 4. Cutover sequence (safe order — Colima deleted LAST)

1. Stand up native services empty → `opencrow doctor` green on all four.
2. Run migration script while the Docker stack is still the source of truth.
3. Point the app at native (default), verify: app health (`:48081/internal/health`),
   a mem0 write→search smoke test, and `bun run test:integration` against native PG.
4. **Only then** `colima stop && colima delete` → reclaim ~13GB RAM + ~38GB disk.

### 5. Docs

- CLAUDE.md: add "Native macOS stack (default local)"; relabel Docker/compose as the
  "Linux server deploy" path; update the `test:integration` note (native PG satisfies
  it — no `docker compose up -d postgres` needed locally).

## Data flow

Unchanged from today. App (native bun) → `127.0.0.1:5432` (PG), `:6333` (Qdrant),
`:8050` (mem0). mem0 → `127.0.0.1:6333` (Qdrant) + `127.0.0.1:11434` (Ollama) +
hosted DeepSeek for extraction.

## Error handling & risks

- **Qdrant version pin:** install v1.13.2 binary so the copied `storage/` stays
  format-compatible. Verify collections load post-migration.
- **mem0 graph store:** embedded Kùzu is a file dir — copy whole; ensure
  `MEM0_GRAPH_DB` path matches the copied location.
- **Postgres keg-only:** must add `postgresql@17` bin to PATH for `pg_dump`/`psql`;
  role/db creation must be idempotent (guard with `IF NOT EXISTS` / catch "exists").
- **Ordering:** never delete Colima before native is verified healthy and data is
  migrated. Migration reads from the live containers.
- **Durability change:** dropping `fsync=off` etc. is intentional and safe (slightly
  more I/O, far more crash-safe for a 24/7 instance).
- **Secrets:** mem0 plist must not hardcode keys — source from `.env` /
  `OPENCROW_INTERNAL_TOKEN`, `MEM0_LLM_API_KEY` at render time.

## Testing

- `bun run test:integration` green against native Postgres.
- `opencrow doctor` green on all four services (ports + health).
- mem0 smoke: POST a memory, search it back (auth with the internal token).
- App health endpoint `:48081/internal/health` returns ok under launchd.
- `bun run typecheck` + `bun run lint` clean on any touched CLI/daemon code.

## Implementation delegation (per repo RULE 2)

- `platform-reliability-engineer` — launchd plists, `src/cli` setup/doctor native
  path, migration script, Colima teardown.
- `senior-ai-engineer` — mem0-server native wiring (env, venv, uvicorn).
- `qa-test-engineer` — confirm the integration lane + smoke tests.
- `security-reviewer` — review before merge (secrets in plists, local bind only).

All implementation occurs inside an isolated git worktree (RULE 1) and lands via a
PR to `origin/master` (RULE 3).
