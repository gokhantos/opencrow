# SIGE Memory Architecture — Mem0 + Neo4j Integration Design

## Problem Statement

The current SIGE pipeline uses Zep Cloud for knowledge graph construction, which has three critical limitations:

1. **1,000 episode limit** — our project has 60K+ data records across 10 sources
2. **Double extraction cost** — we run LLM entity extraction AND Zep re-extracts from the same text
3. **No cross-session learning** — each SIGE session creates a new Zep user, so the graph is discarded after each run

MiroFish (the reference implementation that inspired SIGE's design) uses Zep effectively because it operates on small seed documents (news articles, reports). Our use case is fundamentally different — we have a massive, continuously growing data warehouse that should feed a persistent, evolving knowledge graph.

---

## Design Goals

1. **Persistent knowledge graph** that accumulates intelligence across all SIGE sessions
2. **Continuous ingestion** of all project data sources into the graph (not just at session start)
3. **Smart retrieval** combining vector similarity + graph traversal for context-rich queries
4. **Cross-session learning** — Session N+1 is smarter than Session N
5. **Zero external API limits** — self-hosted, no episode caps
6. **MiroFish-level capabilities** — entity resolution, temporal facts, agent persona generation from graph

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Continuous Ingestion Layer                     │
│                                                                  │
│  ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ┌───────────┐   │
│  │ App Store│ │Play Store│ │ Reddit │ │  HN  │ │   News    │   │
│  │ Reviews  │ │ Reviews  │ │ Posts  │ │Stories│ │ Articles  │   │
│  │ (45K)    │ │          │ │ (7K)   │ │ (550)│ │ (2.2K)    │   │
│  └────┬─────┘ └────┬─────┘ └───┬────┘ └──┬───┘ └─────┬─────┘   │
│       │             │           │         │           │          │
│  ┌────▼─────────────▼───────────▼─────────▼───────────▼───────┐  │
│  │              Ingestion Cron Job (background)                │  │
│  │  • Reads new records from Postgres in batches               │  │
│  │  • Converts to natural language descriptions                │  │
│  │  • Calls Mem0 memory.add() with source metadata             │  │
│  │  • Tracks ingestion cursor per source (last_indexed_id)     │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Mem0 (self-hosted)                       │  │
│  │                                                            │  │
│  │  ┌──────────────────┐    ┌──────────────────────────────┐  │  │
│  │  │   Memory Layer   │    │      Graph Layer             │  │  │
│  │  │                  │    │                              │  │  │
│  │  │  memory.add()    │───►│  Automatic entity extraction │  │  │
│  │  │  memory.search() │    │  Entity resolution (dedup)   │  │  │
│  │  │  memory.get_all()│    │  Relationship inference      │  │  │
│  │  │                  │    │  Temporal fact tracking       │  │  │
│  │  └────────┬─────────┘    └──────────────┬───────────────┘  │  │
│  │           │                             │                  │  │
│  │  ┌────────▼─────────┐    ┌──────────────▼───────────────┐  │  │
│  │  │   Qdrant         │    │      Neo4j                   │  │  │
│  │  │  (vector store)  │    │   (graph store)              │  │  │
│  │  │  Already running │    │   Self-hosted on server      │  │  │
│  │  │  on server       │    │   or Neo4j Aura free tier    │  │  │
│  │  └──────────────────┘    └──────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     SIGE Session Pipeline                        │
│                                                                  │
│  1. Query Mem0 graph for domain knowledge                        │
│  2. Build GraphView from Mem0 nodes + edges                      │
│  3. Formulate game from enriched graph                           │
│  4. Run expert game (agents get graph-filtered context)          │
│  5. Run social simulation (citizen personas from graph entities) │
│  6. Score + incentivize                                          │
│  7. Write session results BACK to Mem0 (cross-session learning)  │
│  8. Generate report (queries Mem0 for evidence)                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Component Design

### 1. Mem0 Self-Hosted Server

**Deployment:** REST API server on the production machine alongside existing services.

```
# Install and run
pip install mem0ai
mem0 server start --host 0.0.0.0 --port 8050
```

**Configuration:**
```python
config = {
    "llm": {
        "provider": "openai",              # OpenAI-compatible
        "config": {
            "model": "qwen3.5-plus",
            "api_key": "<ALIBABA_API_KEY>",
            "openai_base_url": "https://coding-intl.dashscope.aliyuncs.com/v1"
        }
    },
    "embedder": {
        "provider": "openai",
        "config": {
            "model": "text-embedding-v3",   # Alibaba's embedding model
            "api_key": "<ALIBABA_API_KEY>",
            "openai_base_url": "https://coding-intl.dashscope.aliyuncs.com/v1"
        }
    },
    "vector_store": {
        "provider": "qdrant",
        "config": {
            "host": "127.0.0.1",
            "port": 6333,
            "collection_name": "sige_memories"
        }
    },
    "graph_store": {
        "provider": "neo4j",
        "config": {
            "url": "bolt://127.0.0.1:7687",
            "username": "neo4j",
            "password": "<NEO4J_PASSWORD>"
        }
    }
}
```

**Key advantage:** Mem0 uses YOUR LLM (Qwen 3.5 Plus via Alibaba) for extraction — same provider you're already paying for, no additional cost. And it uses YOUR Qdrant instance — already running on the server.

---

### 2. Continuous Ingestion Layer

A background cron job that gradually feeds all project data into Mem0's knowledge graph. Unlike the current approach (dumping everything at session start), this builds the graph incrementally over time.

**Ingestion strategies per data source:**

| Source | Natural Language Template | Mem0 Metadata | Why This Format |
|--------|--------------------------|---------------|-----------------|
| App Store reviews (1-2★) | `"User complaint about {app_name}: '{title}' — {content}. Rating: {rating}/5."` | `{ source: "appstore_review", app: "{app_name}", rating: {rating} }` | Mem0 extracts: app entity, pain point, user sentiment |
| Play Store reviews (1-2★) | `"Play Store user complaint about {app_name} ({thumbs_up} upvotes): '{content}'"` | `{ source: "playstore_review", app: "{app_name}", upvotes: {thumbs_up} }` | Upvote count signals severity of pain point |
| Product Hunt | `"New product launched: {name} — '{tagline}'. {votes_count} votes. Topics: {topics}."` | `{ source: "producthunt", votes: {votes_count} }` | Mem0 extracts: product entity, category, competitive signal |
| HN stories | `"Trending on Hacker News ({points} pts, {comments} comments): '{title}'. {description}"` | `{ source: "hackernews", points: {points} }` | Tech community signal, trend detection |
| Reddit | `"r/{subreddit} discussion ({score} upvotes): '{title}'. {selftext}"` | `{ source: "reddit", subreddit: "{subreddit}", score: {score} }` | Community need signal, pain points |
| News | `"[{category}] {title} — {summary}. Source: {source_name}."` | `{ source: "news", category: "{category}" }` | Market trend, industry shift |
| App Store apps | `"App Store app: {name} in {category}. {description}"` | `{ source: "appstore_app", category: "{category}" }` | Competitive landscape entity |
| Play Store apps | `"Play Store app: {name} in {category}. Rating: {rating}★, {installs} installs. {description}"` | `{ source: "playstore_app", category: "{category}", rating: {rating} }` | Market positioning, category gaps |
| GitHub repos | `"Open source project: {name} ({stars} stars). {description}"` | `{ source: "github" }` | Tech trend, tooling landscape |
| Tweets | `"Tweet ({likes} likes): {content}"` | `{ source: "twitter", likes: {likes} }` | Social signal |

**Ingestion rate:** Process 50-100 records per cron run (every 10 minutes). Full initial ingestion of 60K records takes ~4-5 days at this rate. This is intentional — gradual ingestion avoids LLM rate limits and lets the graph build naturally.

**Cursor tracking:** Store `last_indexed_id` per source in `config_overrides` table. Each run picks up where the last one stopped.

**Priority order:** Reviews first (highest signal density), then Reddit, then PH/HN/News, then apps, then GitHub/tweets.

---

### 3. SIGE Session Integration

When a SIGE session starts, instead of building knowledge from scratch:

#### Step 1: Query existing graph
```typescript
// Search Mem0 for memories relevant to the session seed
const memories = await mem0.search(seedInput, { user_id: "sige-global", limit: 50 });
const graphData = await mem0.search(seedInput, { user_id: "sige-global", limit: 50, enable_graph: true });
```

This returns:
- **Vector matches:** Semantically similar memories from all ingested data
- **Graph context:** Related entities and relationships from Neo4j
- The combination gives you: "Users complain about weather apps (review data) → Weather apps have low ratings in the App Store (app data) → A new weather startup just launched on Product Hunt (PH data) → HN is discussing on-device weather ML (HN data)"

#### Step 2: Build GraphView for the pipeline
Convert Mem0's response to the existing `GraphView` format (nodes + edges + summary). The rest of the pipeline is unchanged — game formulation, agent filters, etc.

#### Step 3: Write results back
After the session completes, write the key findings back to Mem0:
```typescript
// Store winning ideas as memories
for (const idea of topIdeas) {
    await mem0.add(
        `SIGE session finding: "${idea.title}" — ${idea.description}. Fused score: ${idea.fusedScore}. Strategic properties: ${JSON.stringify(idea.strategicMetadata)}`,
        { user_id: "sige-global", metadata: { source: "sige_session", session_id: sessionId } }
    );
}
```

This means Session N+1 can find: "In a previous session, the idea 'Local-First Milestone Vault' scored 0.795 and was identified as an evolutionary stable strategy." The graph accumulates strategic intelligence over time.

---

### 4. Agent Persona Generation (MiroFish-Inspired)

MiroFish generates social simulation citizen personas FROM the knowledge graph entities. We should do the same:

**Current approach:** Deterministic template-based personas (age, profession, stance from a seeded RNG).

**Proposed approach:** Query Mem0 graph for real entities and generate personas grounded in actual data:

```typescript
// Instead of random personas, query the graph for real user archetypes
const userEntities = await mem0.search("mobile app users demographics complaints", {
    user_id: "sige-global",
    limit: 30,
    enable_graph: true
});

// Generate citizen personas from real review authors, Reddit users, etc.
// "35-year-old small business owner frustrated with expense tracking apps"
// becomes grounded in actual review: "This app crashes every time I try to export!"
```

This makes the social simulation dramatically more realistic — citizen agents represent real user archetypes extracted from your data, not random templates.

---

### 5. Report Agent Enhancement (MiroFish-Inspired)

MiroFish's report agent has four tools: `insight_forge`, `panorama_search`, `quick_search`, and `interview_agents`. Our report agent should have equivalent capabilities backed by Mem0:

| Tool | Current Implementation | With Mem0 |
|------|----------------------|-----------|
| **InsightForge** (deep) | Queries Zep with multi-hop | `mem0.search()` with graph traversal — follows entity relationships across the full accumulated knowledge graph |
| **PanoramaSearch** (broad) | Queries Zep broadly | `mem0.get_all()` filtered by metadata — shows evolution of facts over time |
| **QuickSearch** (fast) | Single Zep query | `mem0.search()` with low limit — instant fact lookup |
| **Interview** | Not implemented | Query specific graph entities for their "perspective" — e.g., ask the "Small Business Owner" archetype what they think |

---

### 6. Cross-Session Learning Loop

```
Session 1: "Mobile app ideas for 2026"
  → Queries graph: finds 45K review pain points, 557 PH launches, 7K Reddit discussions
  → Produces: 12 ranked ideas, "Local-First Milestone Vault" wins
  → Writes back: winning ideas + strategic analysis as new memories
  → Graph now has: data entities + strategic findings

Session 2: "Deep dive into health & wellness mobile apps"
  → Queries graph: finds previous session's health-related ideas PLUS health app reviews, medical Reddit posts
  → Agents already know: "Previous session found privacy-first approaches score well"
  → Produces: refined health app ideas building on Session 1 findings

Session 3: "Competitive analysis of top 5 ideas from Sessions 1-2"
  → Queries graph: finds all previous ideas, their scores, competitive landscape from app stores
  → Adversarial agent knows: which ideas were challenged and how they survived
  → Produces: final shortlist with risk mitigation strategies

Each session makes the graph smarter. The graph makes each session smarter.
```

---

## Infrastructure Requirements

### Neo4j (on server)
```bash
# Docker (simplest)
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/your-password \
  -v neo4j_data:/data \
  neo4j:5-community

# Or Neo4j Aura free tier (managed, 200K nodes)
```

### Mem0 Server (on server)
```bash
pip install mem0ai
# Run as systemd service alongside OpenCrow
mem0 server start --host 127.0.0.1 --port 8050
```

### Qdrant (already running)
No changes needed — Mem0 uses the same Qdrant instance with a separate collection.

---

## Implementation Phases

### Phase 1: Infrastructure Setup (Day 1)
- Deploy Neo4j on server (Docker)
- Deploy Mem0 REST API server (systemd service)
- Configure Mem0 with Alibaba LLM + Qdrant + Neo4j
- Create Mem0 client in TypeScript (`src/sige/knowledge/mem0-client.ts`)
- Verify: add a test memory, search it, check Neo4j has entities

### Phase 2: Replace Zep with Mem0 in SIGE Pipeline (Day 2)
- Replace `zep-client.ts` calls with `mem0-client.ts`
- Adapt `graph-query.ts` to work with Mem0 response format
- Update `entries/sige.ts` to use Mem0 for knowledge construction
- Update config schema (replace Zep config with Mem0/Neo4j config)
- Write session results back to Mem0 after completion
- Verify: run a SIGE session end-to-end with Mem0

### Phase 3: Continuous Ingestion (Day 3)
- Create ingestion cron job (`src/entries/sige-ingestion.ts`)
- Implement per-source ingestion with natural language templates
- Add cursor tracking in `config_overrides`
- Start with reviews (highest priority), then expand
- Verify: check Neo4j for entities extracted from reviews

### Phase 4: Smart Personas + Report Enhancement (Day 4)
- Graph-grounded citizen persona generation
- Enhanced report agent with Mem0-backed tools
- Cross-session result writing
- Verify: run Session 2 and confirm it builds on Session 1 knowledge

### Phase 5: Full Data Ingestion (Days 5-10)
- Gradual ingestion of all 60K+ records
- Monitor Neo4j graph growth
- Tune extraction prompts per source
- Performance optimization

---

## What This Gets You vs Current State

| Capability | Current (Zep) | With Mem0 + Neo4j |
|---|---|---|
| Data capacity | 1K episodes max | Unlimited (self-hosted) |
| External cost | Zep Cloud subscription | Zero (self-hosted) |
| Knowledge persistence | Per-session (discarded) | Permanent, accumulating |
| Cross-session learning | None | Full — each session enriches the graph |
| Data sources ingested | Seed text only | All 60K+ records continuously |
| Entity resolution | Basic | Automatic dedup across all sources |
| Citizen personas | Random templates | Grounded in real user archetypes from data |
| Report evidence | LLM-generated | Cited from actual data via graph queries |
| Graph query | Basic search | Vector similarity + graph traversal + temporal |
| LLM provider | Separate Zep extraction | Uses YOUR Alibaba/Qwen (same provider, no extra cost) |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Neo4j resource usage on server | Medium | Community edition is lightweight; monitor with `docker stats` |
| Mem0 Python dependency on a TypeScript project | Medium | Mem0 runs as REST API server — TypeScript calls it via HTTP, no Python in the main codebase |
| Initial ingestion takes days | Low | Gradual by design; SIGE works immediately with whatever is already ingested |
| LLM cost for extracting 60K records | Medium | Use Qwen 3.5 Plus (cheap on Alibaba); batch processing; skip records with very short content |
| Graph becomes too large over time | Low | Neo4j Community handles millions of nodes; prune old/low-value nodes periodically |
