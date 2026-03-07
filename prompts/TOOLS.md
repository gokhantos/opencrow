# Tool Usage Guide

## CRITICAL: Use ToolSearch to Discover Your Tools

Your 130+ specialized tools are exposed via the `opencrow-tools` MCP server. They are NOT visible by default — you MUST use `ToolSearch` to load them before calling them.

**MANDATORY first step for ANY non-trivial request:**
1. Use `ToolSearch` with keywords matching the task (e.g., "price market crypto", "defi protocol", "hacker news")
2. The returned tools will have names like `mcp__opencrow-tools__get_price` — these are YOUR tools
3. Call the discovered tools directly

**NEVER skip ToolSearch and jump to WebSearch.** Your internal tools have fresher, more structured data than web search.

## CRITICAL: Internal Tools First

Web search (`WebSearch`) is a **last resort** — only use it when:
- You searched with ToolSearch and no relevant internal tool exists
- You need information outside your scraped data (specific blog posts, documentation pages)
- Internal tool results are insufficient and you need supplementary context

**NEVER use WebSearch for**: crypto prices, market data, DeFi protocols, token info, news, HN stories, Reddit posts, arXiv papers, app store data, GitHub repos, Google Trends, or any other data that your tools already provide.

## ToolSearch Queries by Topic

Use these ToolSearch queries to discover the right tools:

### Crypto & Market Analysis
**ToolSearch**: `"price market crypto"`, `"technical analysis candles"`, `"futures funding liquidation"`
Tools you'll find:
1. `get_price` / `market_summary` — current prices, 24h change
2. `technical_analysis` — RSI, MACD, Bollinger, trend indicators
3. `get_candles` — OHLCV with technical overlays
4. `market_snapshot` — comprehensive overview in one call
5. `futures_overview` — open interest, long/short ratios, funding
6. `funding_rate` / `funding_summary` — funding rate history
7. `liquidations` — recent liquidation cascades
8. `search_tokens` / `get_trending_tokens` — DexScreener token data
9. `token_stats` — aggregate stats by chain
10. `search_news` — crypto-specific news from scraped sources

### DeFi Analysis
**ToolSearch**: `"defi protocol tvl"`, `"yield bridge hack"`, `"stablecoin treasury"`
When asked about DeFi, protocols, TVL, yields:
1. `get_defi_protocols` / `search_defi` — protocols by TVL
2. `get_defi_movers` — top TVL movers (24h)
3. `get_chain_tvls` / `get_chain_metrics` — chain-level data
4. `get_chain_tvl_history` — TVL time series
5. `get_yield_pools` — top yield opportunities
6. `get_bridges` — bridge volumes
7. `get_defi_hacks` — exploit history
8. `get_protocol_detail` — deep protocol info
9. `get_stablecoins` / `get_treasury` — stablecoin and treasury data
10. `get_defi_categories` / `get_global_defi_metrics` — DeFi overview

### Research & Trends
**ToolSearch**: `"hacker news reddit"`, `"arxiv scholar papers"`, `"github trending"`, `"huggingface models"`, `"google trends"`, `"product hunt"`, `"news digest"`
When asked about tech trends, papers, projects, or news:
- `get_hn_digest` / `search_hn` — Hacker News
- `get_reddit_digest` / `search_reddit` — Reddit
- `get_github_repos` / `search_github_repos` — GitHub trending
- `get_arxiv_papers` / `search_arxiv_papers` — academic papers
- `get_scholar_papers` / `search_scholar_papers` — Semantic Scholar
- `get_hf_models` / `search_hf_models` — HuggingFace models
- `get_trends_digest` / `search_trends` — Google Trends
- `get_product_digest` / `search_products` — Product Hunt
- `get_news_digest` / `search_news` — multi-source news
- `get_calendar` — economic calendar

### App & Mobile
**ToolSearch**: `"appstore playstore rankings reviews"`
When asked about apps, app stores, mobile trends:
- `get_appstore_rankings` / `get_appstore_complaints` / `search_appstore_reviews` — Apple App Store
- `get_playstore_rankings` / `get_playstore_complaints` / `search_playstore_reviews` — Google Play Store

### X / Twitter
**ToolSearch**: `"twitter timeline tweets analytics"`
When asked about tweets, social sentiment, Twitter activity:
- `get_timeline_digest` / `search_x_timeline` — scraped timeline
- `get_liked_tweets` — liked tweets
- `get_x_analytics` — engagement analytics

### Cross-Source Search
**ToolSearch**: `"cross source search"`
When you need to search across ALL data sources at once:
- `cross_source_search` — searches 19 indexed source types in one call

## Multi-Tool Analysis Pattern

For any **analysis** request, follow this exact workflow:

```
"Analyze Solana" →
  Step 1: ToolSearch "price market crypto"     → discover market tools
  Step 2: ToolSearch "defi protocol chain"     → discover DeFi tools
  Step 3: ToolSearch "news search"             → discover news tools
  Step 4: Call discovered tools:
    - mcp__opencrow-tools__get_price (SOLUSDT)
    - mcp__opencrow-tools__technical_analysis (SOLUSDT)
    - mcp__opencrow-tools__futures_overview (SOLUSDT)
    - mcp__opencrow-tools__get_chain_metrics (Solana)
    - mcp__opencrow-tools__search_defi (solana)
    - mcp__opencrow-tools__search_tokens (SOL)
    - mcp__opencrow-tools__search_news (solana)
  Step 5: Synthesize all data into analysis
```

**NEVER answer an analysis request with just one tool or just WebSearch.** Combine 3-5+ internal tools minimum to give a data-rich answer.

## Memory & Knowledge

**ToolSearch**: `"remember recall memory"`, `"observations"`
- `remember` / `recall` — persist and retrieve key-value memories across sessions
- `search_memory` — semantic search across all past conversations and knowledge
- `get_observations` — your own learnings from past sessions
- `search_agent_observations` — cross-agent knowledge sharing

**Proactively use `remember`** to store: user preferences, important decisions, recurring contexts, and analysis conclusions that may be useful later.

## Sub-Agent Delegation

Use `list_agents` + `spawn_agent` for complex tasks:
- Multi-step research → spawn `researcher`
- Code implementation → spawn `backend` or `frontend`
- Crypto analysis → spawn `crypto-analyst`
- Portfolio review → spawn `portfolio`

## Skills

Use `list_skills` + `use_skill` to load domain-specific patterns before executing specialized work. Skills contain best practices and templates.
