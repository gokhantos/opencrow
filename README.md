<p align="center">
  <img src="src/web/opencrow.png" alt="OpenCrow" width="120" />
</p>

<h1 align="center">OpenCrow</h1>

<p align="center">
  <a href="https://github.com/gokhantos/opencrow/actions"><img src="https://img.shields.io/github/actions/workflow/status/gokhantos/opencrow/ci.yml?branch=master&label=build" alt="Build"></a>
  <a href="https://github.com/gokhantos/opencrow/releases"><img src="https://img.shields.io/github/v/release/gokhantos/opencrow?label=release" alt="Release"></a>
  <a href="https://github.com/gokhantos/opencrow/blob/master/LICENSE"><img src="https://img.shields.io/github/license/gokhantos/opencrow" alt="License"></a>
  <a href="https://github.com/gokhantos/opencrow/stargazers"><img src="https://img.shields.io/github/stars/gokhantos/opencrow" alt="Stars"></a>
</p>

<p align="center">
A self-hosted multi-agent AI platform that orchestrates specialized agents across Telegram, WhatsApp, and a web dashboard — with 100+ tools, 16 autonomous data scrapers, vector memory, cron scheduling, and real-time market streaming.
</p>

---

## What Can OpenCrow Do?

- **Run AI agents** on Telegram, WhatsApp, and web — each with its own persona, model, tools, and memory
- **Scrape 15 data sources** autonomously — HackerNews, Reddit, GitHub, X/Twitter, App Store, Play Store, DeFi protocols, crypto tokens, Google Trends, news, and more
- **Remember everything** — conversations, facts, and observations are indexed into vector memory and recalled across sessions
- **Generate ideas** — research agents collect signals, ideation agents synthesize them into product/crypto/AI startup ideas on a schedule
- **Monitor markets** — real-time crypto derivatives via Binance WebSocket (prices, liquidations, open interest, technical indicators)
- **Automate with cron** — schedule any agent to run at intervals, one-shot times, or cron expressions
- **Self-manage** — agents can deploy code, restart processes, manage other agents, and monitor system health
- **Scale horizontally** — each agent, scraper, and subsystem runs as an isolated process with crash recovery

---

## Architecture

OpenCrow runs as a thin core process that spawns and supervises isolated child processes. Each subsystem (agents, scrapers, web, cron, markets) runs independently with crash-loop detection, exponential backoff, and automatic recovery.

```
core (orchestrator + internal API)
  └── spawns:
      ├── cron                       (scheduled jobs + agent execution)
      ├── web                        (React dashboard + Hono API)
      ├── agent:default              (Telegram + WhatsApp channels)
      ├── agent:<id>                 (per-agent Telegram/WhatsApp bots)
      ├── scraper:<id>               (one per data source, isolated)
      └── market                     (WebSocket hub + derivatives pipeline)
```

- **Process isolation** — Kill a scraper, everything else keeps running. Crash one agent, others are unaffected.
- **Dynamic scaling** — Agents and scrapers are added/removed via config. The orchestrator reconciles desired vs actual state every 5 seconds.
- **Monolith mode** — For development, `src/gateway.ts` runs everything in a single process.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| AI | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) via MCP bridge |
| Web Framework | Hono |
| Frontend | React SPA (TSX + CSS bundled by Bun HTML imports) |
| Database | PostgreSQL (`Bun.sql` tagged templates) |
| Vector Search | Qdrant |
| Time Series | QuestDB |
| Telegram | grammY |
| WhatsApp | Baileys |
| Embeddings | OpenRouter (`text-embedding-3-small`, 512 dims) |

## Agent System

Agents are the core of OpenCrow. Each agent is an AI persona with its own system prompt, model, tools, and channel connections.

### How agents work

1. Message arrives via Telegram/WhatsApp/Web
2. Router checks authorization, resolves which agent handles the chat
3. Agent SDK spawns a Claude Code subprocess with the agent's system prompt
4. OpenCrow tools are exposed via an in-process MCP server (no network hop)
5. Agent iterates: thinking → tool use → response, auto-continuing until done
6. SDK session ID is captured and resumed on next message for conversational continuity
7. Observations are extracted from the conversation and indexed into memory

### Agent features

- **Session resume** — Conversations persist across messages via SDK session IDs
- **Cross-session memory** — Related memories and user preferences are injected into prompts
- **Auto-continuation** — Agents keep working when they have pending tool use, unlimited iterations
- **Sub-agent spawning** — Agents can spawn specialized sub-agents for complex tasks
- **Activity logging** — Real-time progress shown as an editable Telegram message with tool tracking
- **Hot-reload** — Agent configs stored in DB (`config_overrides` table), reloaded every 30 seconds
- **Agent templates** — Predefined templates (chatbot, researcher, coder, etc.) for quick agent creation
- **Tool filtering** — Per-agent allowlist/denylist controls which tools are available
- **Intelligent tool routing** — Tools are ranked by category match, recency, success rate, and keyword relevance

### Built-in sub-agents

31 specialized agents for orchestrated workflows:

| Agent | Role |
|-------|------|
| architect | System design and architectural decisions |
| planner | Implementation planning with risk assessment |
| backend | Backend implementation (Bun, Hono, PostgreSQL) |
| frontend | React SPA development |
| coder | General-purpose coding |
| reviewer | Code review for quality and maintainability |
| security-reviewer | OWASP Top 10, secrets, SSRF, injection detection |
| tdd-guide | Test-driven development enforcement |
| build-error-resolver | Fix build/type errors with minimal diffs |
| debugger | Root cause analysis and bug fixing |
| devops | Infrastructure and deployment |
| data-analyst | Data analysis and visualization |
| tool-creator | Build new OpenCrow tools |
| watchdog | Autonomous health monitoring (runs via cron) |
| prompt-engineer | Prompt optimization |
| product-strategist | Product direction and feature prioritization |
| researcher | Deep research and information gathering |
| writer | Technical writing and documentation |
| api-designer | REST/GraphQL API design |
| ux-advisor | UX review and recommendations |
| performance-engineer | Performance profiling and optimization |
| monitor | System monitoring and alerting |
| digest | Content summarization and digests |
| pipeline | Data pipeline design |
| portfolio | Portfolio analysis |
| crypto-analyst | Crypto market analysis |
| ai-idea-gen | AI startup idea generation |
| crypto-idea-gen | Crypto product idea generation |
| mobile-idea-gen | Mobile app idea generation |
| oss-idea-gen | Open source project idea generation |
| opencrow | Default general-purpose agent |

### Orchestration workflow

```
TRIVIAL task   → Agent answers directly
MODERATE task  → Agent states plan, executes
COMPLEX task   → Agent spawns sub-agents:
                 planner → user approval → backend/frontend → reviewer → security-reviewer
```

## Tools (100+)

Every tool is a `ToolDefinition` with name, JSON Schema, and execute function. Tools are registered per-agent based on capabilities and exposed via MCP.

### File Operations
| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands with safety restrictions |
| `read_file` | Read file contents with optional line range |
| `write_file` | Write/create files with parent directory creation |
| `edit_file` | Surgical editing by replacing specific strings |
| `list_files` | List directory contents with recursive traversal |
| `grep` | Regex-based content search with file filtering |
| `glob` | Find files matching glob patterns |

### Code Development
| Tool | Description |
|------|-------------|
| `run_tests` | Execute test suites (bun:test, jest, vitest, pytest, cargo, go) |
| `validate_code` | Run typecheck, lint, and test validation |
| `project_context` | Auto-detect project technology stack |
| `git_operations` | Git ops with protected branch guards (status, diff, log, commit, push, pull, branch, stash) |
| `deploy` | Smart deploy with path-based restart targeting (only restarts affected processes) |

### Research & Data
| Tool | Description |
|------|-------------|
| `get_hn_digest` / `search_hn` | HackerNews front page stories + semantic search |
| `get_reddit_digest` / `search_reddit` | Reddit posts with subreddit filtering |
| `get_github_repos` / `search_github_repos` | Trending GitHub repos with language filters |
| `get_product_digest` / `search_products` | Product Hunt products and launches |
| `get_timeline_digest` / `search_x_timeline` | X/Twitter timeline and semantic search |
| `get_liked_tweets` / `get_x_analytics` | X/Twitter liked tweets and engagement analytics |
| `get_hf_models` / `search_hf_models` | Trending HuggingFace ML models |
| `get_trends_digest` / `search_trends` | Google Trends with category filtering |
| `get_appstore_rankings` / `get_appstore_complaints` / `search_appstore_reviews` | App Store rankings, low-rated reviews, and semantic search |
| `get_playstore_rankings` / `get_playstore_complaints` / `search_playstore_reviews` | Play Store rankings, low-rated reviews, and semantic search |
| `get_news_digest` / `search_news` | Multi-source news articles |
| `get_calendar` | Economic calendar events with filtering |
| `cross_source_search` | Search across ALL 19 indexed source types in one call |

### Crypto & DeFi
| Tool | Description |
|------|-------------|
| `token_stats` | Aggregate token statistics by chain, trending vs new |
| `get_defi_protocols` / `search_defi` | DeFi protocols by TVL from DeFi Llama |
| `get_defi_movers` | Top moving DeFi protocols by TVL change (24h) |
| `get_chain_tvls` / `get_chain_metrics` / `get_chain_tvl_history` | Chain-level TVL, fees, DEX volume, stablecoin data, time series |
| `get_yield_pools` | Top yield pools by APY and TVL |
| `get_bridges` | Bridge volumes ranked by 24h volume |
| `get_defi_hacks` | Historical DeFi exploits and hack database |
| `get_emissions` | Token unlock schedules |
| `get_stablecoins` / `get_treasury` | Stablecoin data and protocol treasury breakdowns |
| `get_protocol_detail` | Deep protocol info (symbol, MCap, fees, revenue, raises, Twitter) |
| `get_defi_categories` / `get_global_defi_metrics` | Category breakdowns and aggregated DeFi overview |

### Markets & Trading
| Tool | Description |
|------|-------------|
| `get_price` / `market_summary` | Real-time crypto prices and 24h summaries |
| `get_candles` | OHLCV candlestick data with technical indicators |
| `technical_analysis` | Pre-computed trend, oscillator, and volume indicators |
| `market_snapshot` | Comprehensive market overview in one call |
| `futures_overview` | Open interest, long/short ratios, funding rates |
| `funding_rate` / `funding_summary` | Funding rate history with aggregation and stats |
| `liquidations` | Recent liquidation events and cascade summary |

### Memory & Knowledge
| Tool | Description |
|------|-------------|
| `search_memory` | Semantic search over past conversations |
| `search_agent_observations` | Search knowledge extracted by other agents |
| `cross_agent_memory` | Cross-agent memory sharing |
| `use_skill` / `list_skills` | Load skill documents into context |

### Ideas & Signals
| Tool | Description |
|------|-------------|
| `save_idea` / `get_ideas` / `get_idea_stats` | Idea management and retrieval |
| `save_signal` / `get_unconsumed_signals` / `consume_signals` | Research signal pipeline |
| `get_signal_themes` | Signal categorization and themes |
| `get_recent_idea_titles` / `get_rejected_ideas_feedback` | Idea deduplication and learning |

### Analytics & Monitoring
| Tool | Description |
|------|-------------|
| `db_query` | Read-only SQL SELECT queries |
| `get_conversation_summaries` | Conversation analysis |
| `get_tool_usage` / `get_agent_performance` | Usage and performance metrics |
| `get_cost_summary` | Cost breakdown by agent/tool |
| `get_error_summary` / `error_analysis` | Error rates and patterns |
| `get_health_dashboard` | System health overview |
| `get_process_logs` / `search_logs` | Process log inspection |
| `get_routing_dashboard` / `get_routing_stats` | Message routing analytics |
| `get_failure_patterns` / `get_anti_recommendations` | Failure pattern analysis and anti-recommendations |
| `get_scraper_runs` / `get_subagent_runs` | Execution history |
| `get_memory_stats` | Memory/context storage statistics |
| `get_agent_capacity` | Agent load balancing and queue depth |

### System & Automation
| Tool | Description |
|------|-------------|
| `process_manage` | Manage orchestrated processes (restart, stop, start, list) |
| `self_restart` | Restart own process with cooldown protection |
| `manage_agent` | CRUD operations for agents |
| `list_agents` | List available agents for sub-agent spawning |
| `agent_templates` | Predefined agent templates for quick creation |
| `cron` / `trigger_cron` | Manage and trigger scheduled jobs |
| `send_message` | Queue messages for async Telegram/WhatsApp delivery |
| `spawn_agent` | Execute sub-agents with task decomposition |
| `ask_user` | Pause and ask user questions with optional choices |
| `web_fetch` | HTTP client with SSRF prevention and rate limiting |

## Data Scrapers

16 autonomous scrapers run as isolated processes, each with its own tick interval and error handling. Scraped data is stored in PostgreSQL and indexed into Qdrant for semantic search.

| Scraper | Interval | What it collects |
|---------|----------|-----------------|
| **HackerNews** | 10 min | Front page stories (title, URL, points, comments) |
| **Reddit** | 30 min | Posts from user feeds, multi-account support with cookies |
| **GitHub** | 12 hrs | Daily + weekly trending repos (stars, forks, language) |
| **Product Hunt** | 10 min | Daily products (votes, topics, makers), multi-account |
| **HuggingFace** | 30 min | Trending, most-liked, recently-modified ML models |
| **News** | 15-120 min | CryptoPanic, Cointelegraph, Reuters, Investing.com (articles + economic calendar) |
| **X/Twitter** | varies | Timeline, bookmarks, auto-like, auto-follow via Playwright + GraphQL interception |
| **Google Trends** | 30 min | Trending topics (US) with traffic volume and related queries |
| **App Store** | 60 min | Top Free/Paid rankings + reviews for top 10 apps |
| **Play Store** | 60 min | Top Free rankings + reviews with full descriptions via gplay |
| **DeFi Llama** | 30 min | 18 endpoints — protocols, chains, DEX volumes, yields, bridges, hacks, stablecoins, treasuries (filters >$100K TVL) |
| **Markets** | real-time | Crypto derivatives via Binance WebSocket (prices, liquidations, open interest, technical indicators) |

### Scraper features

- **Browser automation** — X/Twitter and News use Playwright for JavaScript-heavy sites
- **Anti-detection** — Stealth scripts, cookie auth, GraphQL API interception for X/Twitter
- **Multi-account** — Reddit, Product Hunt support multiple accounts with separate cookies
- **Selective indexing** — DeFi Llama only indexes significant movers (>5% change) or high TVL (>$10M)
- **Rate limiting** — Per-source delays (App Store: 2s between calls)

### X/Twitter automation

The X/Twitter scraper is a full automation suite:

- **Timeline scraping** — Capture tweets from your home timeline via GraphQL interception
- **Bookmark sharing** — Share bookmarked tweets to configured Telegram chats
- **Auto-like** — Automatically like tweets matching configured criteria
- **Auto-follow** — Follow users based on interaction patterns
- **Interaction tracking** — Track likes, retweets, replies across accounts

## Memory & RAG

Hybrid search engine combining vector similarity and full-text search for long-term agent memory.

### Search pipeline

1. **Query expansion** — Semantic expansion with synonyms and related terms
2. **Parallel search** — Vector (Qdrant) + full-text (PostgreSQL) run concurrently
3. **Score merging** — 70% vector weight + 30% full-text weight
4. **Temporal decay** — Per-kind half-life (observations decay faster than documents)
5. **MMR deduplication** — Maximal marginal relevance to reduce redundancy
6. **Channel scoping** — Conversation memories stay within their channel

### Memory types

17 source kinds, each with its own chunk profile and temporal decay: conversations, notes, documents, tweets, articles, products, stories, Reddit posts, HuggingFace models, GitHub repos, observations, ideas, app reviews, app rankings, trends, DeFi protocols, and DEX tokens.

### Observation extraction

After each conversation, observations (facts, preferences, patterns) are automatically extracted and indexed. These are injected into future prompts for cross-session context.

## Channels

Plugin-based channel system with a unified adapter interface.

### Telegram
- grammY-based with serial polling (no runner — avoids 409 conflicts)
- Per-chat message queuing via sequentialize middleware
- Activity log: editable message showing real-time tool progress
- Smart message chunking for 4096 character limit
- HTML formatting with inline buttons

### WhatsApp
- Baileys (Web WhatsApp protocol)
- QR code / pairing code authentication
- Per-number and per-group sender filtering
- Media support (images, documents)

### Web Chat
- Hono API route (`POST /api/chat`)
- Bearer token auth via `OPENCROW_WEB_TOKEN`

### Router

The message router handles authorization, agent selection, and response delivery:

- **Authorization** — Per-channel allowed senders (userIds for Telegram, numbers for WhatsApp)
- **Agent selection** — Explicit `/agent` command > persistent routing rules > default agent
- **Commands** — `/stop` (abort), `/clear` (reset session), `/status` (health), `/agent [id]` (switch)
- **Concurrency** — One active message per chat, prevents overlapping processing
- **Input validation** — Per-agent max input length enforcement

## Cron Scheduler

Agents can be triggered on schedules for autonomous work.

### Schedule types

- **`at`** — One-time execution at a specific timestamp
- **`every`** — Interval-based (e.g., every 6 hours)
- **`cron`** — Standard cron expressions via croner

### Built-in jobs

- **Idea generation** — Research agents save signals, ideation agents synthesize them (every 6 hours)
- **Watchdog** — Health monitoring: processes, errors, cron success, costs, DB, scrapers (every 30 minutes)
- **Digests** — Scheduled content summaries

### Execution

Jobs run agents with full tool access in isolation. Progress is tracked per-run with status, duration, and result summaries stored in the database.

## Web Dashboard

React SPA served via Bun HTML imports with Hono API backend. 30+ views covering every subsystem.

### Views

| View | What it shows |
|------|--------------|
| **Overview** | System health, active processes, recent activity |
| **Agents** | Create, edit, delete agents — configure prompts, models, tools, channels |
| **Chat** | Web-based conversation interface |
| **Cron** | Job management, manual triggering, execution history |
| **Usage** | Tool usage stats, agent performance, cost breakdown |
| **Memory** | Semantic search and inspection of stored memories |
| **Ideas** | Idea browser with filtering and stats |
| **Processes** | Live process tree with restart/stop controls |
| **Logs** | Real-time process log viewer |
| **Markets** | Crypto derivatives data visualization |
| **Routing Rules** | Message routing configuration |
| **Failures** | Failure pattern analysis |
| **System Metrics** | System-level metrics and health |
| **Sessions** | Conversation session browser |
| **Skills** | Skill document management |
| **Tools** | Tool registry inspection |
| **HackerNews** | Scraped stories browser |
| **Reddit** | Reddit post browser with account management |
| **GitHub** | Trending repos browser |
| **HuggingFace** | ML model browser |
| **News** | News article browser |
| **Google Trends** | Trending topics browser |
| **App Store** | App rankings and reviews |
| **DeFi Llama** | Protocol TVL browser |
| **X/Twitter** | Timeline, bookmarks, auto-like, auto-follow management |
| **Product Hunt** | Product browser with account management |

### Auth

`OPENCROW_WEB_TOKEN` environment variable → Bearer token in localStorage → 401 shows login modal.

## Quick Start

```bash
curl -fsSL https://opencrow.dev/install.sh | bash
opencrow setup
```

The setup wizard handles everything: Docker containers, database, `.env`, Telegram/WhatsApp, and service installation.

```bash
opencrow doctor     # Check system health
opencrow update     # Pull latest + reinstall + restart
opencrow status     # Show running service status
opencrow start      # Start in foreground (monolith mode)
opencrow version    # Show version info
```

## Manual Setup

### Prerequisites

- [Bun](https://bun.sh) runtime
- Docker (for PostgreSQL, Qdrant, QuestDB)
- Claude Agent SDK credentials (`~/.claude/.credentials.json`)

### Install

```bash
bun install
cp .env.example .env
```

### Environment variables

```bash
# Required
OPENCROW_WEB_TOKEN=...                    # Web dashboard auth token
TELEGRAM_BOT_TOKEN=...                    # Telegram bot token from BotFather
OPENROUTER_API_KEY=...                    # For embeddings (text-embedding-3-small)
DATABASE_URL=postgres://opencrow:changeme@127.0.0.1:5432/opencrow

# Optional
QDRANT_URL=http://127.0.0.1:6333         # Vector search (defaults to this)
QUESTDB_ILP_URL=tcp::addr=127.0.0.1:9009 # Time series ingestion
QUESTDB_HTTP_URL=http://127.0.0.1:9000   # Time series queries
OPENCROW_WEB_HOST=127.0.0.1              # Web UI bind address
OPENCROW_WEB_PORT=48080                  # Web UI port
```

### Start services

```bash
docker compose up -d    # PostgreSQL + Qdrant + QuestDB
```

### Run

```bash
# Development (monolith, single process)
bun run dev

# Production (distributed, process tree)
bun run start
```

## Development

```bash
bun run dev           # Watch mode (monolith)
bun run dev:web       # Web UI only
bun test              # Run tests
bun run typecheck     # TypeScript check
bun run tw            # Tailwind CSS watch
bun run tw:build      # Tailwind CSS build
```

## Deployment

### systemd

```bash
bun run service:install    # Install opencrow.service
bun run service:start      # Start
bun run service:stop       # Stop
bun run service:restart    # Restart
bun run service:status     # Check health
```

### Manual deploy

```bash
git push origin master
ssh <server> "cd ~/opencrow && git pull origin master"
sudo systemctl restart opencrow
```

## Project Structure

```
src/
├── agent/           # Agent SDK integration, MCP bridge, streaming, sessions
├── agents/          # Agent registry and config resolution
├── channels/        # Telegram + WhatsApp plugins, registry, manager
├── config/          # Schema (Zod), loader, env overrides
├── cron/            # Scheduler, executor, job store, delivery poller
├── daemon/          # systemd + launchd service management
├── entries/         # Process entry points (core, agent, cron, scraper, market)
├── health/          # Checkpoint, rollback notifier
├── memory/          # RAG pipeline (indexer, search, embeddings, Qdrant, chunker)
├── process/         # Orchestrator, manifest, bootstrap, supervisor
├── prompts/         # Prompt loader
├── router/          # Message routing, activity logging
├── sources/         # 16 data scrapers (each in own directory)
├── store/           # Database init + migrations
├── tools/           # 100+ tool definitions (registry, types, factories)
├── web/             # Hono routes + React SPA
│   ├── routes/      # API endpoints (/api/*)
│   └── ui/          # React components, views, styles
├── worktree/        # Git worktree management for isolated agent work
├── cli.ts           # CLI entry point
├── gateway.ts       # Monolith mode (all-in-one)
├── index.ts         # Default entry
├── logger.ts        # Pino-based structured logging
└── web-index.ts     # Web-only entry point

prompts/
├── SOUL.md          # Core identity and values
├── TECH.md          # Technical context and conventions
├── WORKFLOW.md      # Decision and execution process
├── ORCHESTRATION.md # Sub-agent coordination rules
└── agents/          # 31 specialized agent prompts

skills/              # Reusable skill documents for agents
bin/                 # Guardian scripts (crash-loop detection + rollback)
```
