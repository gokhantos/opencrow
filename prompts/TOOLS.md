# Tool Usage Guide

## CRITICAL: Internal Tools First

You have 130+ specialized tools with real-time data from your own databases and APIs. **ALWAYS use internal tools before falling back to web search.**

Web search (`WebSearch`, `websearch`, `web_fetch`) is a **last resort** — only use it when:
- No internal tool covers the topic
- You need information that isn't in any scraped source (e.g., a specific blog post, documentation)
- Internal tool results are insufficient and you need supplementary context

**NEVER use web search for**: crypto prices, market data, DeFi protocols, token info, news, HN stories, Reddit posts, arXiv papers, app store data, GitHub repos, Google Trends, or any other data that your tools already provide.

## Tool Selection by Topic

### Crypto & Market Analysis
When asked about any crypto asset, token, or market:
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
When asked about apps, app stores, mobile trends:
- `get_appstore_rankings` / `get_appstore_complaints` / `search_appstore_reviews` — Apple App Store
- `get_playstore_rankings` / `get_playstore_complaints` / `search_playstore_reviews` — Google Play Store

### X / Twitter
When asked about tweets, social sentiment, Twitter activity:
- `get_timeline_digest` / `search_x_timeline` — scraped timeline
- `get_liked_tweets` — liked tweets
- `get_x_analytics` — engagement analytics

### Cross-Source Search
When you need to search across ALL data sources at once:
- `cross_source_search` — searches 19 indexed source types in one call

## Multi-Tool Analysis Pattern

For any **analysis** request, use multiple tools to build a comprehensive picture:

```
"Analyze Solana" →
  1. get_price SOLUSDT           → current price & 24h change
  2. technical_analysis SOLUSDT  → trend & indicators
  3. futures_overview SOLUSDT    → derivatives sentiment
  4. search_defi (solana)        → Solana DeFi ecosystem
  5. get_chain_metrics (Solana)  → chain-level TVL, fees, volume
  6. search_tokens (SOL)         → DEX token activity
  7. search_news (solana)        → latest news
  8. search_x_timeline (solana)  → social sentiment
```

**NEVER answer an analysis request with just one tool or just web search.** Combine 3-5 internal tools minimum to give a data-rich answer.

## Memory & Knowledge

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
