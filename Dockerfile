# OpenCrow — single-container app image.
# Runs the core orchestrator, which spawns the web dashboard + cron (+ agents/scrapers
# when configured) as child processes inside this one container.
FROM oven/bun:1.3.14

# Claude Code refuses to run with --dangerously-skip-permissions (used by the Agent
# SDK) as root, so the app must run as a non-root user. The base image ships a `bun`
# user (uid 1000) with home at /home/bun.
ENV HOME=/home/bun \
    NODE_ENV=production \
    # The Agent SDK runs the bundled Claude Code CLI under bun — no browser needed.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    # Explicit container signal for the single-instance guard: inside a container
    # the runtime + restart policy own singleton-ness and PIDs are recycled, so
    # the supervisor must take over a stale registry row WITHOUT killing by PID
    # (a recycled PID is typically the container's own bun/start-script parent).
    OPENCROW_IN_CONTAINER=1

WORKDIR /app
RUN chown bun:bun /app
USER bun

# Install dependencies first for better layer caching.
# postinstall (git hooks + playwright) is guarded with `|| true`, so a missing
# git/npx in the slim image is non-fatal.
COPY --chown=bun:bun package.json bun.lock ./
# Prefer the frozen lockfile for reproducibility, but fall back to a normal
# install: bun 1.3.14 intermittently reports "lockfile had changes" on a cold
# x64 resolve even when the lock is correct (same quirk handled in CI).
RUN bun install --frozen-lockfile || bun install

# Application source.
COPY --chown=bun:bun . .

# The dashboard stylesheet is gitignored, so generate it at build time.
RUN bun run tw:build

# Web dashboard (core API :48081 stays container-internal).
EXPOSE 48080

# Liveness: hit the core orchestrator's unauthenticated internal health endpoint
# (:48081 /internal/health, served by the orchestrator process itself). If the
# orchestrator wedges or crash-loops, this probe fails and the runtime marks the
# container unhealthy instead of it silently appearing "up". Uses bun's fetch so
# we don't depend on curl/wget being present in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:48081/internal/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "start"]
