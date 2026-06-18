/**
 * Helpers to mock the OpenCrow REST API in Playwright tests.
 *
 * Each helper intercepts a specific URL pattern and returns a deterministic
 * JSON fixture so tests can run without a live database.
 *
 * Usage:
 *   await mockAgentsApi(page);
 *   // page now has /api/agents → deterministic fixture data
 *
 * Design notes:
 * - Fixtures are defined inline as typed constants; no external files.
 * - The helpers use page.route() which scopes intercepts to the current page
 *   and is automatically cleaned up when the page closes.
 * - For tests that verify a real mutation (create / trigger), the mock returns
 *   a success body that reflects the POSTed data; this lets assertions confirm
 *   the UI processed the response correctly.
 */

import type { Page, Route } from "playwright/test";

// ── Fixtures ──────────────────────────────────────────────────────────────────

export const FIXTURE_AGENTS = {
  success: true,
  configHash: "aabbcc1122",
  data: [
    {
      id: "default-agent",
      name: "Default Agent",
      description: "The main reasoning agent",
      provider: "agent-sdk",
      model: "claude-sonnet-4-6",
      default: true,
      toolCount: 12,
      skillCount: 3,
    },
    {
      id: "research-agent",
      name: "Research Agent",
      description: "Specialised for deep research tasks",
      provider: "anthropic",
      model: "claude-opus-4-5",
      default: false,
      toolCount: 8,
      skillCount: 1,
    },
  ],
};

export const FIXTURE_AGENT_TEMPLATES = {
  success: true,
  data: [
    {
      templateId: "general",
      name: "General",
      description: "A capable all-purpose agent",
      provider: "agent-sdk",
      model: "claude-sonnet-4-6",
    },
  ],
};

export const FIXTURE_PIPELINES = {
  success: true,
  data: [
    {
      id: "ideas-pipeline",
      name: "Ideas Pipeline",
      description: "Discovers ideas from all your data sources",
      category: "mobile_app",
      defaultConfig: {},
      latestRun: {
        id: "run-latest-001",
        pipelineId: "ideas-pipeline",
        status: "completed",
        category: "mobile_app",
        config: {},
        resultSummary: {
          totalSourcesQueried: 4,
          totalSignalsFound: 120,
          totalIdeasGenerated: 10,
          totalIdeasKept: 7,
          totalIdeasDuplicate: 3,
          topThemes: ["AI productivity", "mobile UX"],
          ideaIds: ["idea-1", "idea-2"],
          durationMs: 32_000,
        },
        error: null,
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 28_000,
        createdAt: Date.now() - 60_000,
      },
    },
  ],
};

export const FIXTURE_PIPELINE_RUNS = {
  success: true,
  data: [
    {
      id: "run-latest-001",
      pipelineId: "ideas-pipeline",
      status: "completed",
      category: "mobile_app",
      config: {},
      resultSummary: {
        totalSourcesQueried: 4,
        totalSignalsFound: 120,
        totalIdeasGenerated: 10,
        totalIdeasKept: 7,
        totalIdeasDuplicate: 3,
        topThemes: ["AI productivity", "mobile UX"],
        ideaIds: ["idea-1", "idea-2"],
        durationMs: 32_000,
      },
      error: null,
      startedAt: Date.now() - 60_000,
      finishedAt: Date.now() - 28_000,
      createdAt: Date.now() - 60_000,
    },
  ],
};

export const FIXTURE_PIPELINE_RUN_DETAIL = {
  success: true,
  data: {
    id: "run-latest-001",
    pipelineId: "ideas-pipeline",
    status: "completed",
    category: "mobile_app",
    config: {},
    resultSummary: {
      totalSourcesQueried: 4,
      totalSignalsFound: 120,
      totalIdeasGenerated: 10,
      totalIdeasKept: 7,
      totalIdeasDuplicate: 3,
      topThemes: ["AI productivity", "mobile UX"],
      ideaIds: ["idea-1", "idea-2"],
      durationMs: 32_000,
    },
    error: null,
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 28_000,
    createdAt: Date.now() - 60_000,
    steps: [
      {
        id: "step-1",
        runId: "run-latest-001",
        stepName: "landscape",
        status: "completed",
        inputSummary: null,
        outputSummary: "Found 30 apps",
        durationMs: 8_000,
        error: null,
        startedAt: Date.now() - 60_000,
        finishedAt: Date.now() - 52_000,
      },
      {
        id: "step-2",
        runId: "run-latest-001",
        stepName: "synthesis",
        status: "completed",
        inputSummary: null,
        outputSummary: "Generated 10 ideas",
        durationMs: 12_000,
        error: null,
        startedAt: Date.now() - 52_000,
        finishedAt: Date.now() - 40_000,
      },
    ],
  },
};

export const FIXTURE_WORKFLOWS = {
  success: true,
  data: [
    {
      id: "wf-uuid-0001-0002-0003-000400000001",
      name: "Morning Brief",
      description: "Collects and summarises overnight signals",
      enabled: true,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ],
};

export const FIXTURE_WORKFLOW_DETAIL = {
  success: true,
  data: {
    id: "wf-uuid-0001-0002-0003-000400000001",
    name: "Morning Brief",
    description: "Collects and summarises overnight signals",
    enabled: true,
    nodes: [
      {
        id: "trigger-node",
        type: "trigger",
        position: { x: 100, y: 200 },
        data: { label: "Cron Trigger", cronExpression: "0 8 * * *" },
      },
      {
        id: "agent-node",
        type: "agent",
        position: { x: 400, y: 200 },
        data: { label: "Summarise", agentId: "default-agent" },
      },
    ],
    edges: [
      {
        id: "e-trigger-agent",
        source: "trigger-node",
        target: "agent-node",
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
};

export const FIXTURE_WORKFLOW_EXECUTIONS = {
  success: true,
  data: [
    {
      id: "exec-uuid-0001-0002-0003-000400000001",
      workflowId: "wf-uuid-0001-0002-0003-000400000001",
      status: "completed",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      finishedAt: new Date(Date.now() - 3_540_000).toISOString(),
    },
  ],
};

export const FIXTURE_STATUS = {
  uptime: 42_000,
  authEnabled: true,
  version: "1.0.0-e2e",
  sessions: 0,
  channels: {},
  agents: 2,
  cron: { running: true, jobCount: 1, nextDueAt: null },
};

export const FIXTURE_FEATURES = {
  data: {
    scrapers: { enabled: ["hackernews", "reddit", "github", "producthunt", "appstore", "playstore"] },
    qdrant: { enabled: false },
  },
};

// ── Route installers ───────────────────────────────────────────────────────────

function jsonResponse(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/**
 * Install API mocks needed for the Agents page.
 * Call before navigating to the agents tab.
 */
export async function mockAgentsApi(page: Page): Promise<void> {
  // List agents
  await page.route("**/api/agents", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonResponse(FIXTURE_AGENTS));
    } else if (route.request().method() === "POST") {
      // Create agent — reflect back with a generated id
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill(
        jsonResponse({
          success: true,
          configHash: "newcfghash001",
          data: {
            id: body["id"] ?? "new-agent",
            name: body["name"] ?? "New Agent",
            description: body["description"] ?? "",
            provider: body["provider"] ?? "agent-sdk",
            model: body["model"] ?? "claude-sonnet-4-6",
            default: false,
            toolCount: 0,
            skillCount: 0,
          },
        }),
      );
    } else {
      await route.continue();
    }
  });

  // Single agent detail
  await page.route("**/api/agents/*", async (route: Route) => {
    const method = route.request().method();
    const url = route.request().url();
    const id = url.split("/api/agents/")[1]?.split("?")[0] ?? "unknown";

    if (method === "GET") {
      const base = FIXTURE_AGENTS.data.find((a) => a.id === id) ?? FIXTURE_AGENTS.data[0]!;
      await route.fulfill(
        jsonResponse({
          success: true,
          configHash: FIXTURE_AGENTS.configHash,
          data: {
            ...base,
            systemPrompt: "You are a helpful assistant.",
            maxIterations: 10,
            toolFilter: { mode: "all", tools: [] },
          },
        }),
      );
    } else if (method === "PATCH" || method === "PUT") {
      await route.fulfill(
        jsonResponse({ success: true, configHash: "patchedhash001" }),
      );
    } else if (method === "DELETE") {
      await route.fulfill(
        jsonResponse({ success: true, configHash: "deletedhash001" }),
      );
    } else {
      await route.continue();
    }
  });

  // Templates
  await page.route("**/api/agents/templates", async (route: Route) => {
    await route.fulfill(jsonResponse(FIXTURE_AGENT_TEMPLATES));
  });
}

/**
 * Install API mocks needed for the Pipelines page.
 */
export async function mockPipelinesApi(page: Page): Promise<void> {
  // Pipeline list
  await page.route("**/api/pipelines", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill(jsonResponse(FIXTURE_PIPELINES));
    } else {
      await route.continue();
    }
  });

  // Trigger a pipeline run
  await page.route("**/api/pipelines/*/run", async (route: Route) => {
    if (route.request().method() === "POST") {
      await route.fulfill(
        jsonResponse({ success: true, message: "Pipeline started", runId: "run-new-001" }),
      );
    } else {
      await route.continue();
    }
  });

  // Pipeline runs list (polling endpoint)
  await page.route("**/api/pipelines-runs*", async (route: Route) => {
    const url = route.request().url();
    // Single run detail: /api/pipelines-runs/<id>
    const runIdMatch = url.match(/\/api\/pipelines-runs\/([^/?]+)\/ideas/);
    const runDetailMatch = url.match(/\/api\/pipelines-runs\/([^/?]+)$/);

    if (runIdMatch) {
      // Ideas for a run
      await route.fulfill(
        jsonResponse({ success: true, data: [] }),
      );
    } else if (runDetailMatch) {
      await route.fulfill(jsonResponse(FIXTURE_PIPELINE_RUN_DETAIL));
    } else {
      // List
      await route.fulfill(jsonResponse(FIXTURE_PIPELINE_RUNS));
    }
  });

  // Resume endpoints
  await page.route("**/api/pipelines-runs/*/resume", async (route: Route) => {
    await route.fulfill(jsonResponse({ success: true }));
  });
  await page.route("**/api/pipelines-runs/resume-interrupted", async (route: Route) => {
    await route.fulfill(jsonResponse({ success: true, resumed: 0 }));
  });
}

/**
 * Install API mocks needed for the Workflows page.
 */
export async function mockWorkflowsApi(page: Page): Promise<void> {
  const WF_ID = "wf-uuid-0001-0002-0003-000400000001";

  // Workflow list
  await page.route("**/api/workflows", async (route: Route) => {
    const method = route.request().method();
    if (method === "GET") {
      await route.fulfill(jsonResponse(FIXTURE_WORKFLOWS));
    } else if (method === "POST") {
      // Create workflow
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      await route.fulfill(
        jsonResponse({
          success: true,
          data: {
            id: WF_ID,
            name: body["name"] ?? "New Workflow",
            description: body["description"] ?? "",
            enabled: false,
            nodes: body["nodes"] ?? [],
            edges: body["edges"] ?? [],
            viewport: { x: 0, y: 0, zoom: 1 },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      );
    } else {
      await route.continue();
    }
  });

  // Single workflow CRUD
  await page.route("**/api/workflows/*", async (route: Route) => {
    const method = route.request().method();
    const url = route.request().url();

    // executions sub-resource
    if (url.includes("/executions")) {
      if (url.includes("/steps")) {
        await route.fulfill(
          jsonResponse({ success: true, data: [] }),
        );
        return;
      }
      // Single execution detail
      const execIdMatch = url.match(/\/executions\/([^/?]+)$/);
      if (execIdMatch) {
        await route.fulfill(
          jsonResponse({
            success: true,
            data: {
              id: execIdMatch[1],
              workflowId: WF_ID,
              status: "completed",
              startedAt: Date.now() - 3_600_000,
              finishedAt: Date.now() - 3_540_000,
            },
          }),
        );
        return;
      }
      // Execution list for workflow
      await route.fulfill(jsonResponse(FIXTURE_WORKFLOW_EXECUTIONS));
      return;
    }

    // run sub-resource
    if (url.endsWith("/run") && method === "POST") {
      await route.fulfill(
        jsonResponse({
          success: true,
          data: { executionId: "exec-new-001" },
        }),
      );
      return;
    }

    // events SSE (stream) — return empty stream
    if (url.includes("/events")) {
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
        body: "data: {\"type\":\"done\"}\n\n",
      });
      return;
    }

    // Standard GET / PUT / DELETE on /api/workflows/<id>
    if (method === "GET") {
      await route.fulfill(jsonResponse(FIXTURE_WORKFLOW_DETAIL));
    } else if (method === "PUT") {
      await route.fulfill(
        jsonResponse({ success: true, data: FIXTURE_WORKFLOW_DETAIL.data }),
      );
    } else if (method === "DELETE") {
      await route.fulfill(jsonResponse({ success: true }));
    } else {
      await route.continue();
    }
  });
}

/**
 * Install the global API mocks that every test needs: /api/status and
 * /api/features. These are fetched on app init before any tab renders.
 */
export async function mockGlobalApi(page: Page): Promise<void> {
  await page.route("**/api/status", async (route: Route) => {
    await route.fulfill(jsonResponse(FIXTURE_STATUS));
  });

  await page.route("**/api/features", async (route: Route) => {
    await route.fulfill(jsonResponse(FIXTURE_FEATURES));
  });

  // Tools list — referenced by the agent form
  await page.route("**/api/tools", async (route: Route) => {
    await route.fulfill(jsonResponse({ success: true, data: [] }));
  });

  // Skills list — referenced by agent form ToolsTab
  await page.route("**/api/skills", async (route: Route) => {
    await route.fulfill(jsonResponse({ success: true, data: [] }));
  });
}
