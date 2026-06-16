# Contributing to OpenCrow

Thanks for your interest in contributing to OpenCrow! This guide will help you get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/<your-username>/opencrow.git`
3. Install dependencies: `bun install`
   - `postinstall` auto-installs the git hooks (`git config core.hooksPath .githooks`). No manual step needed.
   - The Playwright browser is **not** installed automatically. If you need it (browser-based scrapers/E2E), run `bun run setup:browser` once.
4. Copy environment config: `cp .env.example .env`
5. Start services: `docker compose up -d`
6. Build the dashboard stylesheet: `bun run tw:build` (the generated `tailwind-out.css` is gitignored)
7. Run in dev mode: `bun run dev`

## Development Workflow

1. Create a feature branch from `master`: `git checkout -b feat/your-feature`
2. Make your changes
3. Run type checking: `bun run typecheck`
4. Lint: `bun run lint`
5. Run the test lanes:
   - `bun run test:unit` — fast, no database required.
   - `bun run test:integration` — DB-backed; first start Postgres with `docker compose up -d postgres`.
   - `bun run test:isolated` — `mock.module` tests that must run in their own process.
   - `bun run test:all` runs all three lanes in sequence.

   > Test selection is by filename suffix: `*.integration.test.ts` (needs a DB),
   > `*.isolated.test.ts` (mock.module), everything else is a unit test. Avoid bare
   > `bun test`, which mixes the lanes and will fail without a database.
6. Commit using [conventional commits](#commit-messages)
7. Push and open a Pull Request against `master`

## Commit Messages

We use conventional commits:

```
feat: add new scraper for X
fix: resolve memory leak in agent sessions
refactor: simplify tool routing logic
docs: update setup instructions
test: add tests for cron scheduler
chore: update dependencies
perf: optimize vector search query
```

## Project Structure

- `src/agent/` - Agent SDK integration and MCP bridge
- `src/channels/` - Telegram, WhatsApp, Web channel plugins
- `src/sources/` - Data scrapers (each in its own directory)
- `src/tools/` - Tool definitions and registry
- `src/web/` - Hono API routes and React SPA
- `src/memory/` - RAG pipeline and vector search

## Adding a New Tool

1. Create a file in `src/tools/` following the `ToolDefinition` interface
2. Define the JSON Schema for parameters
3. Implement the `execute` function
4. Register it in the tool registry

## Adding a New Scraper

1. Create a directory in `src/sources/<name>/`
2. Implement the scraper following existing patterns
3. Add it to the process manifest
4. Add corresponding search/digest tools

## Code Style

- TypeScript with strict mode
- Immutable patterns (no mutation)
- Small, focused files (< 800 lines)
- Zod for input validation
- Error handling on all async operations

## Pull Requests

- Keep PRs focused on a single change
- Include a clear description of what and why
- Ensure `bun run typecheck` and `bun run lint` pass
- Ensure `bun run test:unit` passes (run `bun run test:integration` too if you touched DB code)
- Add tests for new functionality
- Update documentation if needed

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Bun version)

## Questions?

Open a discussion on GitHub or reach out to the maintainers.
