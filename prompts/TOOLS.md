# Tool Usage Guide

## CRITICAL: Use ToolSearch to Discover Your Tools

Your 130+ specialized tools are exposed via the `opencrow-tools` MCP server. They are NOT visible by default — you MUST use `ToolSearch` to load them before calling them.

**MANDATORY first step for ANY non-trivial request:**
1. Use `ToolSearch` with keywords matching the task
2. The returned tools will have names like `mcp__opencrow-tools__get_price` — these are YOUR tools
3. Call the discovered tools directly

**NEVER skip ToolSearch and jump to WebSearch.** Your internal tools have fresher, more structured data than web search.

## CRITICAL: Internal Tools First

Web search (`WebSearch`) is a **last resort** — only use it when:
- You searched with ToolSearch and no relevant internal tool exists
- You need information outside your scraped data
- Internal tool results are insufficient and you need supplementary context

**NEVER use WebSearch for**: crypto prices, market data, DeFi protocols, token info, news, HN stories, Reddit posts, arXiv papers, app store data, GitHub repos, Google Trends, or any other data that your tools already provide.

## ToolSearch Queries by Topic

| Topic | ToolSearch query |
|-------|-----------------|
| Crypto prices & trading | `"price market crypto"`, `"futures funding liquidation"` |
| DeFi protocols & chains | `"defi protocol tvl"`, `"yield bridge stablecoin"` |
| News & economic calendar | `"news digest calendar"` |
| Hacker News | `"hacker news"` |
| Reddit | `"reddit digest"` |
| GitHub repos | `"github trending"` |
| arXiv papers | `"arxiv papers"` |
| HuggingFace models | `"huggingface models"` |
| Product Hunt | `"product hunt"` |
| App Store / Play Store | `"appstore playstore rankings"` |
| X / Twitter | `"twitter timeline tweets"` |
| Cross-source search | `"cross source search"` |
| Memory & knowledge | `"remember recall memory"` |
| Ideas & signals | `"idea signal save"` |
| Analytics & monitoring | `"analytics performance health"` |
| Logs & errors | `"logs error analysis"` |
| Database queries | `"db query tables"` |

## Multi-Tool Analysis Pattern

For any **analysis** request, follow this workflow:

```
"Analyze Solana" →
  Step 1: ToolSearch "price market crypto"     → discover market tools
  Step 2: ToolSearch "defi protocol chain"     → discover DeFi tools
  Step 3: ToolSearch "news search"             → discover news tools
  Step 4: Call 5-8 discovered tools in parallel
  Step 5: Synthesize all data into analysis
```

**NEVER answer an analysis request with just one tool or just WebSearch.** Use 3-5+ internal tools minimum.

## Memory

**ToolSearch**: `"remember recall memory"`
- Proactively use `remember` to store user preferences, decisions, and recurring contexts
- Use `search_memory` for semantic search across past conversations
- Use `recall` to retrieve stored key-value memories

## Sub-Agent Delegation

Use `list_agents` + `spawn_agent` for complex tasks. Use `list_skills` + `use_skill` to load domain patterns before specialized work.
