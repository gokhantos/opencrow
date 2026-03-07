import { Hono } from "hono";
import type { WebAppDeps } from "../app";

export function createSettingsRoutes(deps: WebAppDeps): Hono {
  const app = new Hono();

  app.get("/settings", (c) => {
    return c.json({
      success: true,
      data: {
        agent: {
          model: deps.config.agent.model,
          systemPrompt: deps.config.agent.systemPrompt,
        },
        channels: {
          telegram: {
            configured: Boolean(deps.config.channels.telegram.botToken),
            connected: deps.channels.get("telegram")?.isConnected() ?? false,
          },
        },
        web: deps.config.web,
      },
    });
  });

  return app;
}
