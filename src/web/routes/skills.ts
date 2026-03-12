import { Hono } from "hono";
import { z } from "zod";
import {
  loadSkills,
  readSkillDetail,
  createSkill,
  updateSkill,
  deleteSkill,
} from "../../skills/loader";

const skillInputSchema = z.object({
  name: z.string().min(1, "Name is required").max(100).trim(),
  description: z.string().min(1, "Description is required").max(500).trim(),
  content: z.string().max(100_000).default(""),
});

export function createSkillRoutes(): Hono {
  const app = new Hono();

  app.get("/skills", async (c) => {
    const skills = await loadSkills();
    return c.json({
      success: true,
      data: skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      })),
    });
  });

  app.get("/skills/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await readSkillDetail(id);
    if (!detail) {
      return c.json({ success: false, error: "Skill not found" }, 404);
    }
    return c.json({ success: true, data: detail });
  });

  app.post("/skills", async (c) => {
    const parsed = skillInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    const result = await createSkill(parsed.data);
    if (result.error) {
      return c.json({ success: false, error: result.error }, 409);
    }

    return c.json({ success: true, data: { id: result.id } }, 201);
  });

  app.put("/skills/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = skillInputSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        400,
      );
    }

    const result = await updateSkill(id, parsed.data);
    if (result.error) {
      return c.json({ success: false, error: result.error }, 404);
    }

    return c.json({ success: true });
  });

  app.delete("/skills/:id", async (c) => {
    const id = c.req.param("id");
    const result = await deleteSkill(id);

    if (result.error) {
      return c.json({ success: false, error: result.error }, 404);
    }

    return c.json({ success: true });
  });

  return app;
}
