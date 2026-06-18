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
    OPENCROW_IN_CONTAINER=1 \
    # Shell execution (bash tool + dev-tool exec path) MUST be sandboxed in the
    # canonical deployment. "required" fails CLOSED: if the bubblewrap mechanism
    # installed below is somehow unavailable at runtime, shell commands are
    # refused rather than run unsandboxed. Without this the LLM (which ingests
    # untrusted scraped content) could read/exfiltrate arbitrary files. Operators
    # who deliberately accept the risk can override to "best-effort"/"off".
    OPENCROW_TOOLS_SANDBOX=required

# bubblewrap is the OS sandbox mechanism the shell-exec path (bash tool +
# run_tests/validate_code) wraps every command in. On Debian trixie it installs
# setuid-root, so the non-root `bun` user can still create the sandbox namespace.
# It is REQUIRED here (OPENCROW_TOOLS_SANDBOX=required above) — the image fails
# closed without it. Headless-Chromium OS libraries for the scrapers follow.
# Installed as root (apt needs it) BEFORE switching to the bun user. This is the
# Debian 13 / "trixie" chromium
# dependency set that `playwright install-deps chromium` would install (the base
# image, oven/bun:1.3.14, is debian:trixie-slim — note the t64 time64 suffixes);
# we list it explicitly so the layer is deterministic and doesn't need playwright
# present yet. The browser binary itself is fetched later, as the bun user.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bubblewrap \
      libasound2t64 \
      libatk-bridge2.0-0t64 \
      libatk1.0-0t64 \
      libatspi2.0-0t64 \
      libcairo2 \
      libcups2t64 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0t64 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      fonts-liberation \
      fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

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
