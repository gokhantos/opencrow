import { Hono } from "hono";
import {
  getIdeas,
  getIdeaById,
  getIdeaStats,
  updateIdeaRating,
  getStageCounts,
  updateIdeaStage,
} from "../../sources/ideas/store";

export function createIdeasRoutes(): Hono {
  const app = new Hono();

  app.get("/ideas", async (c) => {
    const agentId = c.req.query("agent_id");
    const category = c.req.query("category");
    const limitParam = c.req.query("limit");
    const offsetParam = c.req.query("offset");
    const limit = limitParam ? Math.max(1, Number(limitParam) || 50) : undefined;
    const offset = Math.max(0, Number(offsetParam ?? "0") || 0);

    const ideas = await getIdeas({
      agentId: agentId || undefined,
      category: category || undefined,
      limit: limit ?? undefined,
      offset,
    });

    return c.json({ success: true, data: ideas });
  });

  app.get("/ideas/stats", async (c) => {
    const stats = await getIdeaStats();
    return c.json({ success: true, data: stats });
  });

  app.get("/ideas/stage-counts", async (c) => {
    const counts = await getStageCounts();
    return c.json({ success: true, data: counts });
  });

  app.get("/ideas/:id", async (c) => {
    const id = c.req.param("id");
    const idea = await getIdeaById(id);
    if (!idea) {
      return c.json({ success: false, error: "Idea not found" }, 404);
    }
    return c.json({ success: true, data: idea });
  });

  app.patch("/ideas/:id", async (c) => {
    const id = c.req.param("id");

    let body: { rating?: number | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const { rating } = body;
    if (rating !== null && rating !== undefined && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 0 || rating > 5)) {
      return c.json(
        { success: false, error: "rating must be an integer 0-5 or null" },
        400,
      );
    }

    const updated = await updateIdeaRating(id, {
      rating: rating ?? null,
    });

    if (!updated) {
      return c.json({ success: false, error: "Idea not found" }, 404);
    }

    return c.json({ success: true, data: updated });
  });

  app.patch("/ideas/:id/stage", async (c) => {
    const id = c.req.param("id");
    let body: { stage?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    const validStages = [
      "signal",
      "synthesis",
      "idea",
      "validated",
      "archived",
    ];
    if (!body.stage || !validStages.includes(body.stage)) {
      return c.json(
        {
          success: false,
          error: `stage must be one of: ${validStages.join(", ")}`,
        },
        400,
      );
    }

    const updated = await updateIdeaStage(id, body.stage);
    if (!updated) {
      return c.json({ success: false, error: "Idea not found" }, 404);
    }

    return c.json({ success: true, data: updated });
  });

  return app;
}
