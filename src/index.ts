import { Hono } from "hono";
import { syncDoomscroll } from "./doomscroll.ts";
import { handleHubMcp } from "./mcp.ts";
import type { Env } from "./types.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.json({
    service: "hubos",
    version: "1.0.0",
    endpoints: ["GET /health", "POST /mcp"],
  }),
);

app.get("/health", async (c) => {
  const pages = await c.env.DB.prepare("SELECT COUNT(*) as c FROM pages").first<{ c: number }>();
  return c.json({ ok: true, service: "hubos", pages: pages?.c ?? 0 });
});

app.post("/mcp", (c) => handleHubMcp(c.req.raw, c.env));

export { app };

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (env.XEFFECT_URL && env.XEFFECT_TOKEN) {
      await syncDoomscroll(env, { hours: 72 });
    }
  },
};
