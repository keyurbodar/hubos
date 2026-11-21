import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { callXeffectTool, scoreShipText, syncDoomscroll } from "../src/doomscroll.ts";
import { app } from "../src/index.ts";
import { handleHubMcp } from "../src/mcp.ts";
import { rankProjectsForSeries, recordPickDecision } from "../src/picker.ts";
import type { Env } from "../src/types.ts";
import { runVibeCheck } from "../src/vibe-check.ts";

function createMockD1(): D1Database {
  const sqlite = new Database(":memory:");
  const migrationSql = readFileSync(resolve("migrations/0001_init.sql"), "utf8");
  sqlite.exec(migrationSql);

  const db = {
    prepare(query: string) {
      const makeStmt = (params: unknown[]) => ({
        bind(...args: unknown[]) {
          return makeStmt(args);
        },
        async first<T = unknown>(): Promise<T | null> {
          const row = sqlite.query(query).get(...(params as [])) as T | null;
          return row ?? null;
        },
        async all<T = unknown>(): Promise<{ results: T[]; success: boolean }> {
          const rows = sqlite.query(query).all(...(params as [])) as T[];
          return { results: rows, success: true };
        },
        async run(): Promise<{ success: boolean }> {
          sqlite.query(query).run(...(params as []));
          return { success: true };
        },
      });
      return makeStmt([]);
    },
    async batch(stmts: Array<{ run(): Promise<unknown> }>) {
      const results = [];
      for (const s of stmts) {
        results.push(await s.run());
      }
      return results;
    },
  };
  return db as unknown as D1Database;
}

function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".wrangler-dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

test("vibe-check rejects real slop patterns and passes clean source-grounded drafts", () => {
  const sloppy = [
    "Base Daily Recap - Nov 21",
    "",
    "- @alpha is launching v2 on Base — something big is cooking",
    "- @beta is opening vaults on Base",
    "- @gamma is offering rewards on Base",
    "- @alpha is adding pools with @alpha on Base",
    "",
    "In summary, Base is heating up and only going higher.",
  ].join("\n");

  const bad = runVibeCheck({
    body: sloppy,
    chainName: "Base",
    sourceUrls: [],
  });
  expect(bad.passed).toBe(false);
  const rules = new Set([...bad.errors, ...bad.warnings].map((i) => i.rule));
  expect(rules.has("no_em_dash")).toBe(true);
  expect(rules.has("banned_slop_phrase")).toBe(true);
  expect(rules.has("progressive_tense_chain")).toBe(true);
  expect(rules.has("chain_name_echo")).toBe(true);
  expect(rules.has("repeated_handle")).toBe(true);
  expect(rules.has("empty_closer")).toBe(true);
  expect(rules.has("missing_source_urls")).toBe(true);

  const clean = [
    "Base Daily Recap (Nov 21)",
    "",
    "- @alpha shipped v2 pools with $18M first-day volume.",
    "- @beta opened USDC lending vaults at 6.4% APY.",
    "- @gamma published its Trail of Bits audit report.",
  ].join("\n");

  const good = runVibeCheck({
    body: clean,
    chainName: "Base",
    sourceUrls: ["https://x.com/alpha/status/1", "https://x.com/beta/status/2"],
  });
  expect(good.passed).toBe(true);
  expect(good.errors).toHaveLength(0);
});

test("doomscroll syncs from xeffect, retries transient 5xx with Effect v4, and picker ranks with cooldown + learning", async () => {
  const db = createMockD1();
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      `INSERT INTO projects (handle, name, ecosystem, pages_json, category, tier, followers_count, posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      "risebuilder",
      "Rise Builder",
      "base",
      '["basehub","aionbase"]',
      "infra",
      1,
      8000,
      1,
      2,
      10,
      0,
      now,
    )
    .run();

  await db
    .prepare(
      `INSERT INTO projects (handle, name, ecosystem, pages_json, category, tier, followers_count, posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind("oldgiant", "Old Giant", "base", '["basehub"]', "defi", 1, 200000, 1, 10, 20, 0, now)
    .run();

  const env: Env = {
    DB: db,
    HUB_MCP_TOKEN: "hub-secret",
    XEFFECT_URL: "https://xeffect.example/mcp",
    XEFFECT_TOKEN: "xeffect-secret",
  };

  expect(
    scoreShipText("We launched v2 mainnet on Base and crossed $50M TVL").score,
  ).toBeGreaterThanOrEqual(20);

  let attempts = 0;
  const flakyXeffect = (async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("upstream hiccup", { status: 502 });
    }
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            text: JSON.stringify({
              posts: [
                {
                  post_id: "1001",
                  handle: "risebuilder",
                  text: "Shipped v2 mainnet on Base and crossed $25M volume",
                  url: "https://x.com/risebuilder/status/1001",
                  created_at: now - 3600,
                  likes: 300,
                  reposts: 80,
                  bookmarks: 90,
                  views: 45000,
                },
                {
                  post_id: "1002",
                  handle: "oldgiant",
                  text: "Integrated cross-chain bridge routing and shoutout to @risebuilder",
                  url: "https://x.com/oldgiant/status/1002",
                  created_at: now - 1800,
                  likes: 90,
                  reposts: 20,
                  bookmarks: 15,
                  views: 12000,
                },
              ],
            }),
          },
        ],
      },
    });
  }) as unknown as typeof fetch;

  const syncRes = await syncDoomscroll(env, {
    ecosystem: "base",
    hours: 72,
    fetchImpl: flakyXeffect,
  });
  expect(syncRes.ok).toBe(true);
  expect(attempts).toBe(2);
  expect(syncRes.signals_upserted).toBe(2);
  expect(syncRes.projects_updated).toBe(2);

  const ranked = await rankProjectsForSeries(db, {
    pageId: "basehub",
    series: "spotlight",
    limit: 5,
  });
  const [first, second] = ranked.candidates;
  expect(first?.handle).toBe("risebuilder");
  expect(first?.scores.total).toBeGreaterThan(second?.scores.total ?? 0);

  const firstPickId = ranked.pickIds[0];
  expect(firstPickId).toBeDefined();
  await recordPickDecision(db, {
    pickId: firstPickId ?? "",
    decision: "approved",
  });

  const afterCooldown = await rankProjectsForSeries(db, {
    pageId: "basehub",
    series: "spotlight",
    limit: 5,
  });
  expect(afterCooldown.candidates[0]?.handle).toBe("oldgiant");

  const siblingRanked = await rankProjectsForSeries(db, {
    pageId: "aionbase",
    series: "spotlight",
    limit: 5,
  });
  const riseInSibling = siblingRanked.candidates.find((c) => c.handle === "risebuilder");
  expect(riseInSibling?.sibling_angle_note).toContain("basehub");

  // Config error returns clean ok: false via Effect v4
  const noConfig = await callXeffectTool({ DB: db }, "health", {});
  expect(noConfig.ok).toBe(false);
});

test("Hono routes and hubos MCP fail closed without token and serve core tools", async () => {
  const db = createMockD1();
  const env: Env = { DB: db, HUB_MCP_TOKEN: "hub-secret" };

  const healthRes = await app.fetch(new Request("https://hubos/health"), env);
  expect(healthRes.status).toBe(200);
  const healthJson = (await healthRes.json()) as { ok: boolean; pages: number };
  expect(healthJson.ok).toBe(true);
  expect(healthJson.pages).toBe(5);

  const missingTokenRes = await handleHubMcp(
    new Request("https://hubos/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
    { DB: db },
  );
  expect(missingTokenRes.status).toBe(503);

  const unauthRes = await handleHubMcp(
    new Request("https://hubos/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  expect(unauthRes.status).toBe(401);

  const listRes = await app.fetch(
    new Request("https://hubos/mcp", {
      method: "POST",
      headers: { authorization: "Bearer hub-secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    env,
  );
  expect(listRes.status).toBe(200);
  const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
  const names = listJson.result.tools.map((t) => t.name);
  expect(names).toContain("hub_briefing");
  expect(names).toContain("picker_rank");
  expect(names).toContain("vibe_check");
  expect(names).toContain("doomscroll_sync");
  expect(names).toContain("doomscroll_health");
});

test("all markdown and skill files in hubos contain zero em dashes", () => {
  const mdFiles = collectMarkdownFiles(resolve("."));
  expect(mdFiles.length).toBeGreaterThanOrEqual(5);
  for (const file of mdFiles) {
    const content = readFileSync(file, "utf8");
    expect(/[—–]/.test(content)).toBe(false);
  }
});
