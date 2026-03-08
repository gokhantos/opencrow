import type { AgentOptions, ProgressEvent } from "../agent/types";
import type { Channel } from "../channels/types";
import type { ChannelRegistry } from "../channels/registry";
import type { ChannelManager } from "../channels/manager";
import type { AgentRegistry } from "../agents/registry";
import type { CronStore } from "../cron/store";
import type { CronScheduler } from "../cron/scheduler";
import type { ResolvedAgent } from "../agents/types";
import type { MemoryManager } from "../memory/types";
import type { MarketPipeline } from "../sources/markets/pipeline";
import type { MarketType } from "../sources/markets/types";
import type { MessageHandler } from "../channels/types";
import type { BookmarkProcessor } from "../sources/x/bookmarks/processor";
import type { AutolikeProcessor } from "../sources/x/interactions/processor";
import type { AutofollowProcessor } from "../sources/x/follow/processor";
import type { TimelineScrapeProcessor } from "../sources/x/timeline/processor";
import type { HNScraper } from "../sources/hackernews/scraper";
import type { HFScraper } from "../sources/huggingface/scraper";
import type { RedditScraper } from "../sources/reddit/scraper";
import type { GithubScraper } from "../sources/github/scraper";
import type { ArxivScraper } from "../sources/arxiv/scraper";
import type { PHScraper } from "../sources/producthunt/scraper";
import type { NewsProcessor } from "../sources/news/processor";
import type { ObservationHook } from "../memory/observation-hook";
import type { Orchestrator } from "../process/orchestrator";

export interface InternalApiDeps {
  readonly agentRegistry: AgentRegistry;
  readonly orchestrator?: Orchestrator;
  // Everything below is optional — only set in monolith mode (gateway.ts)
  readonly channels?: ReadonlyMap<string, Channel>;
  readonly channelRegistry?: ChannelRegistry;
  readonly channelManager?: ChannelManager;
  readonly getDefaultAgentOptions?: () => Promise<AgentOptions>;
  readonly cronStore?: CronStore;
  readonly cronScheduler?: CronScheduler;
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
  readonly hfScraper?: HFScraper;
  readonly redditScraper?: RedditScraper;
  readonly githubScraper?: GithubScraper;
  readonly arxivScraper?: ArxivScraper;
  readonly phScraper?: PHScraper;
  readonly newsProcessor?: NewsProcessor;
  readonly observationHook?: ObservationHook;
}

export interface InternalStatusResponse {
  readonly channels: Record<string, { status: string; type: string }>;
  readonly cron: {
    readonly running: boolean;
    readonly jobCount: number;
    readonly nextDueAt: number | null;
  } | null;
  readonly market: unknown | null;
}

export interface InternalChatRequest {
  readonly message: string;
  readonly chatId?: string;
  readonly agentId?: string;
}

export interface InternalChatResponse {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
}
