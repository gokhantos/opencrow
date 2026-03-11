import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createChatRoutes } from "./routes/chat";
import { createSettingsRoutes } from "./routes/settings";
import { createStatusRoutes } from "./routes/status";
import { createAgentRoutes } from "./routes/agents";
import { createCronRoutes } from "./routes/cron";
import { createChannelRoutes } from "./routes/channels";
import { createMemoryRoutes, createMemoryDebugRoutes } from "./routes/memory";
import { createMarketRoutes } from "./routes/market";
import { systemRoutes } from "./routes/system";
import { createXAccountRoutes } from "./routes/x-accounts";
import { createPHAccountRoutes } from "./routes/ph-accounts";
import { createBookmarkSharingRoutes } from "./routes/x-bookmark-sharing";
import { createInteractionRoutes } from "./routes/x-interactions";
import { createFollowRoutes } from "./routes/x-follow";
import { createTimelineRoutes } from "./routes/x-timeline";
import { createHNRoutes } from "./routes/hn";
import { createRedditAccountRoutes } from "./routes/reddit-accounts";
import { createRedditRoutes } from "./routes/reddit";
import { createGithubRoutes } from "./routes/github";
import { createPHProductRoutes } from "./routes/ph-products";
import { createNewsRoutes } from "./routes/news";
import { createIdeasRoutes } from "./routes/ideas";
import { createSignalsRoutes } from "./routes/signals";
import { createSkillRoutes } from "./routes/skills";
import { createUsageRoutes } from "./routes/usage";
import { createToolsRoutes } from "./routes/tools";
import { createFeaturesRoutes } from "./routes/features";
import { createSecretsRoutes } from "./routes/secrets";
import { createRoutingRulesRoutes } from "./routes/routing-rules";
import { createAppStoreRoutes } from "./routes/appstore";
import { createPlayStoreRoutes } from "./routes/playstore";
import type { BookmarkProcessor } from "../sources/x/bookmarks/processor";
import type { AutolikeProcessor } from "../sources/x/interactions/processor";
import type { AutofollowProcessor } from "../sources/x/follow/processor";
import type { TimelineScrapeProcessor } from "../sources/x/timeline/processor";
import type { HNScraper } from "../sources/hackernews/scraper";
import type { RedditScraper } from "../sources/reddit/scraper";
import type { GithubScraper } from "../sources/github/scraper";
import type { PHScraper } from "../sources/producthunt/scraper";
import type { NewsProcessor } from "../sources/news/processor";
import type { MarketPipeline } from "../sources/markets/pipeline";
import type { MarketType } from "../sources/markets/types";
import { getRecentLogs, type StoredLogEntry } from "../logger";
import { getDb } from "../store/db";
import type { OpenCrowConfig } from "../config/schema";
import type { Channel, MessageHandler } from "../channels/types";
import type { ChannelRegistry } from "../channels/registry";
import type { ChannelManager } from "../channels/manager";
import type { AgentOptions } from "../agent/types";
import type { AgentRegistry } from "../agents/registry";
import type { CronStore } from "../cron/store";
import type { CronScheduler } from "../cron/scheduler";
import type { SubAgentTracker } from "../agents/tracker";
import type { ResolvedAgent } from "../agents/types";
import type { MemoryManager } from "../memory/types";
import type { ObservationHook } from "../memory/observation-hook";
import type { CoreClient } from "./core-client";
import { createLogger } from "../logger";

const log = createLogger("web");

export interface WebAppDeps {
  readonly config: OpenCrowConfig;
  readonly channels: ReadonlyMap<string, Channel>;
  readonly channelRegistry?: ChannelRegistry;
  readonly channelManager?: ChannelManager;
  readonly getDefaultAgentOptions: () => Promise<AgentOptions>;
  readonly agentRegistry: AgentRegistry;
  readonly cronStore?: CronStore;
  readonly cronScheduler?: CronScheduler;
  readonly subAgentTracker?: SubAgentTracker;
  readonly buildAgentOptions?: (agent: ResolvedAgent) => Promise<AgentOptions>;
  readonly messageHandler?: MessageHandler;
  readonly memoryManager?: MemoryManager;
  readonly marketPipeline?: MarketPipeline;
  readonly marketSymbols?: readonly string[];
  readonly marketTypes?: readonly MarketType[];
  readonly bookmarkProcessor?: BookmarkProcessor;
  readonly autolikeProcessor?: AutolikeProcessor;
  readonly autofollowProcessor?: AutofollowProcessor;
  readonly timelineScrapeProcessor?: TimelineScrapeProcessor;
  readonly hnScraper?: HNScraper;
  readonly redditScraper?: RedditScraper;
  readonly githubScraper?: GithubScraper;
  readonly phScraper?: PHScraper;
  readonly newsProcessor?: NewsProcessor;
  readonly coreClient?: CoreClient;
  readonly observationHook?: ObservationHook;
}

export function createWebApp(deps: WebAppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // Log auth status at startup (best-effort check against env only)
  if (process.env.OPENCROW_WEB_TOKEN) {
    log.info("Web API authentication enabled (env)");
  } else {
    log.warn("OPENCROW_WEB_TOKEN not in env — checking DB per request");
  }

  // Auth middleware: resolve token from DB secrets first, then env.
  // This runs per-request so changes take effect without restart.
  app.use("/api/*", async (c, next) => {
    const { getSecret } = await import("../config/secrets");
    const token = await getSecret("OPENCROW_WEB_TOKEN");
    if (token) {
      return bearerAuth({ token })(c, next);
    }
    return next();
  });

  const chat = createChatRoutes(deps);
  const settings = createSettingsRoutes(deps);
  const status = createStatusRoutes(deps);
  const agents = createAgentRoutes(deps);
  const cron = createCronRoutes(deps);
  const channels = createChannelRoutes(deps);

  app.get("/api/logs", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(
      1,
      Math.min(Number(limitParam ?? "200") || 200, 500),
    );
    const processFilter = c.req.query("process") || "";
    const levelFilter = c.req.query("level") || "";
    const contextFilter = c.req.query("context") || "";
    const searchFilter = c.req.query("search") || "";

    try {
      const db = getDb();
      const params: unknown[] = [];
      let idx = 1;

      const conditions: string[] = [];
      if (processFilter) {
        conditions.push(`process_name = $${idx}`);
        params.push(processFilter);
        idx++;
      }
      if (levelFilter) {
        conditions.push(`level = $${idx}`);
        params.push(levelFilter);
        idx++;
      }
      if (contextFilter) {
        conditions.push(`context = $${idx}`);
        params.push(contextFilter);
        idx++;
      }
      if (searchFilter) {
        const term = `%${searchFilter}%`;
        conditions.push(
          `(message ILIKE $${idx} OR context ILIKE $${idx} OR COALESCE(data_json, '') ILIKE $${idx})`,
        );
        params.push(term);
        idx++;
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);
      const query = `SELECT process_name, level, context, message, data_json, created_at
               FROM process_logs ${where}
               ORDER BY id DESC LIMIT $${idx}`;

      const rows = (await db.unsafe(query, params)) as Array<
        Record<string, unknown>
      >;

      const entries: StoredLogEntry[] = rows.reverse().map((r) => {
        const ts = Number(r.created_at);
        const dataJson = r.data_json as string | null;
        return {
          processName: r.process_name as string,
          timestamp: new Date(ts * 1000).toISOString(),
          level: r.level as StoredLogEntry["level"],
          context: r.context as string,
          message: r.message as string,
          data: dataJson ? JSON.parse(dataJson) : undefined,
        };
      });

      return c.json({ success: true, data: entries });
    } catch {
      // Fallback to in-process ring buffer if DB query fails
      const logs = getRecentLogs(limit);
      return c.json({ success: true, data: logs });
    }
  });

  app.get("/api/logs/processes", async (c) => {
    try {
      const db = getDb();
      const rows = (await db.unsafe(
        `SELECT DISTINCT process_name FROM process_logs ORDER BY process_name`,
      )) as Array<Record<string, unknown>>;
      const names = rows.map((r) => r.process_name as string);
      return c.json({ success: true, data: names });
    } catch {
      return c.json({ success: true, data: [] });
    }
  });

  app.get("/api/logs/contexts", async (c) => {
    const processFilter = c.req.query("process") || "";
    try {
      const db = getDb();
      const params: unknown[] = [];
      let where = "";
      if (processFilter) {
        where = "WHERE process_name = $1";
        params.push(processFilter);
      }
      const rows = (await db.unsafe(
        `SELECT DISTINCT context FROM process_logs ${where} ORDER BY context`,
        params,
      )) as Array<Record<string, unknown>>;
      const contexts = rows.map((r) => r.context as string);
      return c.json({ success: true, data: contexts });
    } catch {
      return c.json({ success: true, data: [] });
    }
  });

  app.route("/api", chat);
  app.route("/api", settings);
  app.route("/api", status);
  app.route("/api", agents);
  app.route("/api", cron);
  app.route("/api", channels);
  app.route("/api", createRoutingRulesRoutes(deps));
  app.route("/api/system", systemRoutes);

  const xAccounts = createXAccountRoutes();
  app.route("/api/x", xAccounts);

  const phAccounts = createPHAccountRoutes();
  app.route("/api/ph", phAccounts);

  const redditAccounts = createRedditAccountRoutes();
  app.route("/api/reddit", redditAccounts);

  const cc = deps.coreClient;

  if (deps.bookmarkProcessor || cc) {
    const bookmarkSharing = createBookmarkSharingRoutes({
      processor: deps.bookmarkProcessor,
      coreClient: cc,
    });
    app.route("/api/x", bookmarkSharing);
  }

  if (deps.autolikeProcessor || cc) {
    const interactions = createInteractionRoutes({
      processor: deps.autolikeProcessor,
      coreClient: cc,
    });
    app.route("/api/x", interactions);
  }

  if (deps.autofollowProcessor || cc) {
    const follow = createFollowRoutes({
      processor: deps.autofollowProcessor,
      coreClient: cc,
    });
    app.route("/api/x", follow);
  }

  if (deps.timelineScrapeProcessor || cc) {
    const timeline = createTimelineRoutes({
      processor: deps.timelineScrapeProcessor,
      coreClient: cc,
    });
    app.route("/api/x", timeline);
  }

  // Debug routes (stats, chunks, agent-memory) always available — they only need PostgreSQL
  const memoryDebug = createMemoryDebugRoutes();
  app.route("/api", memoryDebug);

  if (deps.memoryManager) {
    const memory = createMemoryRoutes(deps.memoryManager);
    app.route("/api", memory);
  }

  if (deps.phScraper || cc) {
    const phProducts = createPHProductRoutes({
      scraper: deps.phScraper,
      coreClient: cc,
    });
    app.route("/api", phProducts);
  }

  if (deps.hnScraper || cc) {
    const hn = createHNRoutes({ scraper: deps.hnScraper, coreClient: cc, memoryManager: deps.memoryManager });
    app.route("/api", hn);
  }

  if (deps.redditScraper || cc || deps.memoryManager) {
    const reddit = createRedditRoutes({
      scraper: deps.redditScraper,
      coreClient: cc,
      memoryManager: deps.memoryManager,
    });
    app.route("/api", reddit);
  }

  if (deps.githubScraper || cc) {
    const github = createGithubRoutes({
      scraper: deps.githubScraper,
      coreClient: cc,
      memoryManager: deps.memoryManager,
    });
    app.route("/api", github);
  }

  if (deps.newsProcessor || cc) {
    const news = createNewsRoutes({
      processor: deps.newsProcessor,
      coreClient: cc,
    });
    app.route("/api", news);
  }

  const ideas = createIdeasRoutes();
  app.route("/api", ideas);

  const signals = createSignalsRoutes();
  app.route("/api", signals);

  const appStore = createAppStoreRoutes({ coreClient: cc });
  app.route("/api", appStore);

  const playStore = createPlayStoreRoutes({ coreClient: cc });
  app.route("/api", playStore);



  const skills = createSkillRoutes();
  app.route("/api", skills);

  const usage = createUsageRoutes();
  app.route("/api", usage);

  const tools = createToolsRoutes();
  app.route("/api", tools);

  const features = createFeaturesRoutes();
  app.route("/api", features);

  const secrets = createSecretsRoutes();
  app.route("/api", secrets);

  {
    const market = createMarketRoutes(
      deps.marketPipeline,
      deps.marketSymbols ?? [],
      deps.marketTypes ?? ["spot"],
      { coreClient: deps.coreClient },
    );
    app.route("/api", market);
  }

  return app;
}
