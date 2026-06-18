/**
 * Integration tests for the routing-rules HTTP routes.
 *
 * Strategy: mount only the route sub-app (no auth middleware) against a real
 * Postgres database so the full request→DB→response cycle is exercised.
 *
 * Lane: *.integration.test.ts — run with `bun run test:integration`
 * Requires: docker compose up -d postgres
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { createRoutingRulesRoutes } from "./routing-rules";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = "http://localhost";

function makeApp() {
  return createRoutingRulesRoutes();
}

async function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

async function post(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function put(app: ReturnType<typeof makeApp>, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function get(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`)));
}

async function del(app: ReturnType<typeof makeApp>, path: string): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`${BASE}${path}`, { method: "DELETE" })));
}

const TEST_CHANNEL = "route-test-channel";

const baseRuleBody = () => ({
  channel: TEST_CHANNEL,
  matchType: "chat" as const,
  matchValue: "chat-123",
  agentId: "agent-alpha",
  priority: 10,
  enabled: true,
});

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await initDb(process.env.DATABASE_URL);
  const db = getDb();
  await db.unsafe(`DELETE FROM routing_rules WHERE channel = '${TEST_CHANNEL}'`);
});

afterEach(async () => {
  const db = getDb();
  await db.unsafe(`DELETE FROM routing_rules WHERE channel = '${TEST_CHANNEL}'`);
  await closeDb();
});

// ---------------------------------------------------------------------------
// POST /routing/rules — create
// ---------------------------------------------------------------------------

describe("POST /routing/rules", () => {
  it("201 + rule on valid body", async () => {
    const app = makeApp();
    const res = await post(app, "/routing/rules", baseRuleBody());

    expect(res.status).toBe(201);
    const body = await json<{
      success: boolean;
      data: { id: string; channel: string; agentId: string; enabled: boolean };
    }>(res);
    expect(body.success).toBe(true);
    expect(body.data.channel).toBe(TEST_CHANNEL);
    expect(body.data.agentId).toBe("agent-alpha");
    expect(body.data.enabled).toBe(true);
    expect(typeof body.data.id).toBe("string");
  });

  it("400 on missing required field (channel)", async () => {
    const app = makeApp();
    const { channel: _channel, ...withoutChannel } = baseRuleBody();
    const res = await post(app, "/routing/rules", withoutChannel);

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid matchType enum value", async () => {
    const app = makeApp();
    const res = await post(app, "/routing/rules", {
      ...baseRuleBody(),
      matchType: "invalid_type",
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid regex when matchType=pattern", async () => {
    const app = makeApp();
    const res = await post(app, "/routing/rules", {
      ...baseRuleBody(),
      matchType: "pattern",
      matchValue: "[invalid-regex(",
    });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/routing/rules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{{not-json",
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("accepts valid regex pattern matchType", async () => {
    const app = makeApp();
    const res = await post(app, "/routing/rules", {
      ...baseRuleBody(),
      matchType: "pattern",
      matchValue: "^hello.*$",
    });

    expect(res.status).toBe(201);
    const body = await json<{ success: boolean; data: { matchType: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.matchType).toBe("pattern");
  });
});

// ---------------------------------------------------------------------------
// GET /routing/rules — list
// ---------------------------------------------------------------------------

describe("GET /routing/rules", () => {
  it("200 + array containing created rules", async () => {
    const app = makeApp();
    await post(app, "/routing/rules", { ...baseRuleBody(), matchValue: "list-a" });
    await post(app, "/routing/rules", { ...baseRuleBody(), matchValue: "list-b" });

    const res = await get(app, "/routing/rules");
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: Array<{ matchValue: string }> }>(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const values = body.data.map((r) => r.matchValue);
    expect(values).toContain("list-a");
    expect(values).toContain("list-b");
  });
});

// ---------------------------------------------------------------------------
// PUT /routing/rules/:id — update
// ---------------------------------------------------------------------------

describe("PUT /routing/rules/:id", () => {
  it("200 + updated agentId", async () => {
    const app = makeApp();
    const created = await post(app, "/routing/rules", baseRuleBody());
    const { data: rule } = await json<{ data: { id: string } }>(created);

    const res = await put(app, `/routing/rules/${rule.id}`, { agentId: "agent-beta" });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: { agentId: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.agentId).toBe("agent-beta");
  });

  it("200 + updated priority and enabled", async () => {
    const app = makeApp();
    const created = await post(app, "/routing/rules", baseRuleBody());
    const { data: rule } = await json<{ data: { id: string } }>(created);

    const res = await put(app, `/routing/rules/${rule.id}`, { priority: 99, enabled: false });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: { priority: number; enabled: boolean } }>(res);
    expect(body.data.priority).toBe(99);
    expect(body.data.enabled).toBe(false);
  });

  it("404 for nonexistent rule id", async () => {
    const app = makeApp();
    const res = await put(app, "/routing/rules/00000000-0000-0000-0000-000000000099", {
      agentId: "nobody",
    });

    expect(res.status).toBe(404);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on invalid body (agentId empty string)", async () => {
    const app = makeApp();
    const created = await post(app, "/routing/rules", baseRuleBody());
    const { data: rule } = await json<{ data: { id: string } }>(created);

    const res = await put(app, `/routing/rules/${rule.id}`, { agentId: "" });
    expect(res.status).toBe(400);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/routing/rules/some-id`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /routing/rules/:id
// ---------------------------------------------------------------------------

describe("DELETE /routing/rules/:id", () => {
  it("200 on first delete, then 404 on second", async () => {
    const app = makeApp();
    const created = await post(app, "/routing/rules", baseRuleBody());
    const { data: rule } = await json<{ data: { id: string } }>(created);

    const first = await del(app, `/routing/rules/${rule.id}`);
    expect(first.status).toBe(200);
    const firstBody = await json<{ success: boolean }>(first);
    expect(firstBody.success).toBe(true);

    const second = await del(app, `/routing/rules/${rule.id}`);
    expect(second.status).toBe(404);
    const secondBody = await json<{ success: boolean }>(second);
    expect(secondBody.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /routing/rules/resolve
// ---------------------------------------------------------------------------

describe("POST /routing/rules/resolve", () => {
  it("returns matched agentId when a rule matches", async () => {
    const app = makeApp();
    await post(app, "/routing/rules", {
      ...baseRuleBody(),
      matchType: "chat",
      matchValue: "resolve-chat-id",
      agentId: "agent-resolved",
      enabled: true,
    });

    const res = await post(app, "/routing/rules/resolve", {
      channel: TEST_CHANNEL,
      chatId: "resolve-chat-id",
      senderId: "user-x",
    });
    expect(res.status).toBe(200);

    const body = await json<{ success: boolean; data: string | null }>(res);
    expect(body.success).toBe(true);
    expect(body.data).toBe("agent-resolved");
  });

  it("returns null when no rule matches", async () => {
    const app = makeApp();
    const res = await post(app, "/routing/rules/resolve", {
      channel: TEST_CHANNEL,
      chatId: "no-match-chat-id",
      senderId: "no-match-user",
    });

    expect(res.status).toBe(200);
    const body = await json<{ success: boolean; data: unknown }>(res);
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();
  });

  it("400 when required fields are missing", async () => {
    const app = makeApp();
    const res = await post(app, "/routing/rules/resolve", { channel: TEST_CHANNEL });

    expect(res.status).toBe(400);
    const body = await json<{ success: boolean }>(res);
    expect(body.success).toBe(false);
  });

  it("400 on malformed JSON body", async () => {
    const app = makeApp();
    const res = await Promise.resolve(
      app.fetch(
        new Request(`${BASE}/routing/rules/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{{broken",
        }),
      ),
    );
    expect(res.status).toBe(400);
  });
});
