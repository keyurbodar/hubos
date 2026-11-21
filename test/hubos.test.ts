import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  callXeffectTool,
  getDoomscrollHealth,
  parseXeffectTsvPosts,
  scoreShipText,
  syncDoomscroll,
} from "../src/doomscroll.ts";
import { app } from "../src/index.ts";
import { handleHubMcp } from "../src/mcp.ts";
import {
  buildNotionCookieHeader,
  checkNotionHealth,
  getNotionPage,
  listNotionTasks,
  normalizeNotionId,
} from "../src/notion.ts";
import { listActivePartners, syncPartnersFromCsv, upsertPartner } from "../src/partners.ts";
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
  expect(names).toContain("notion_tasks");
  expect(names).toContain("notion_page");
  expect(names).toContain("notion_health");
});

test("all markdown and skill files in hubos contain zero em dashes", () => {
  const mdFiles = collectMarkdownFiles(resolve("."));
  expect(mdFiles.length).toBeGreaterThanOrEqual(5);
  for (const file of mdFiles) {
    const content = readFileSync(file, "utf8");
    expect(/[—–]/.test(content)).toBe(false);
  }
});

test("review regressions: briefings, drafts, gold opt-out, windowed doomscroll, and proposal-proof cooldowns", async () => {
  const db = createMockD1();
  const now = Math.floor(Date.now() / 1000);
  const env: Env = {
    DB: db,
    HUB_MCP_TOKEN: "hub-secret",
    XEFFECT_URL: "https://xeffect.example/mcp",
    XEFFECT_TOKEN: "xeffect-secret",
  };

  const callMcp = async (name: string, args: Record<string, unknown>) => {
    const res = await handleHubMcp(
      new Request("https://hubos/mcp", {
        method: "POST",
        headers: { authorization: "Bearer hub-secret", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
    return JSON.parse(json.result.content[0]?.text ?? "{}");
  };

  // 1 & 6 & 7: Same-second draft saves succeed, pending_drafts expose full body/sources/vibe, and save_as_gold=false is honored
  const draft1 = await callMcp("hub_draft_save", {
    page_id: "basehub",
    series: "daily_recap",
    body: "Base Daily Recap (Nov 21)\n\n- @alpha shipped v2 pools with $18M volume.",
    source_urls: ["https://x.com/alpha/status/1"],
  });
  const draft2 = await callMcp("hub_draft_save", {
    page_id: "basehub",
    series: "spotlight",
    body: "Builder Spotlight: @beta\n\n@beta opened USDC vaults at 6.4% APY.",
    source_urls: ["https://x.com/beta/status/2"],
  });
  expect(draft1.draft_id).toBeDefined();
  expect(draft2.draft_id).toBeDefined();
  expect(draft1.draft_id).not.toBe(draft2.draft_id);

  // 2 & 3 & 4: Seed an active project + a silent project with stale momentum + older 15d signal
  await db
    .prepare(
      `INSERT INTO projects (handle, name, ecosystem, pages_json, category, tier, followers_count, posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h, active, updated_at)
       VALUES (?, ?, 'base', '["basehub"]', 'infra', 1, 10000, 9, 20, 500, 5, 1, ?)`,
    )
    .bind("silentproj", "Silent Proj", now - 86400)
    .run();
  await db
    .prepare(
      `INSERT INTO projects (handle, name, ecosystem, pages_json, category, tier, followers_count, posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h, active, updated_at)
       VALUES (?, ?, 'base', '["basehub","aionbase"]', 'defi', 1, 10000, 1, 1, 10, 0, 1, ?)`,
    )
    .bind("activeproj", "Active Proj", now - 86400)
    .run();
  await db
    .prepare(
      `INSERT INTO signals (signal_id, handle, ecosystem, text, source_url, created_at, likes, reposts, bookmarks, views, ship_score, ship_tags_json, covered_pages_json)
       VALUES ('old-15d', 'activeproj', 'base', 'Earlier v2 upgrade live on Base', 'https://x.com/activeproj/status/old', ?, 50, 10, 5, 1000, 10, '["launch"]', '[]')`,
    )
    .bind(now - 15 * 86400)
    .run();
  await db
    .prepare(
      `INSERT INTO signals (signal_id, handle, ecosystem, text, source_url, created_at, likes, reposts, bookmarks, views, ship_score, ship_tags_json, covered_pages_json)
       VALUES ('mid-5d', 'activeproj', 'base', 'Audit completed on Base', 'https://x.com/activeproj/status/mid', ?, 100, 0, 0, 2000, 7, '["funding_audit"]', '[]')`,
    )
    .bind(now - 5 * 86400)
    .run();

  const syncFetch = (async () =>
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          {
            text: JSON.stringify({
              posts: [
                {
                  post_id: "fresh-1",
                  handle: "activeproj",
                  text: "Shipped mainnet v3 with @silentproj integration",
                  url: "https://x.com/activeproj/status/fresh",
                  created_at: now - 3600,
                  likes: 200,
                  reposts: 0,
                  bookmarks: 0,
                  views: 5000,
                },
              ],
            }),
          },
        ],
      },
    })) as unknown as typeof fetch;

  const syncRes = await syncDoomscroll(env, {
    ecosystem: "base",
    hours: 24,
    fetchImpl: syncFetch,
  });
  expect(syncRes.ok).toBe(true);
  expect(syncRes.projects_updated).toBe(2);

  const silentRow = await db
    .prepare(
      "SELECT posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h FROM projects WHERE handle = 'silentproj'",
    )
    .first<{
      posts_7d: number;
      posts_30d: number;
      avg_eng_7d: number;
      cross_mentions_72h: number;
    }>();
  expect(silentRow).toEqual({ posts_7d: 0, posts_30d: 0, avg_eng_7d: 0, cross_mentions_72h: 1 });

  const activeRow = await db
    .prepare(
      "SELECT posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h FROM projects WHERE handle = 'activeproj'",
    )
    .first<{
      posts_7d: number;
      posts_30d: number;
      avg_eng_7d: number;
      cross_mentions_72h: number;
    }>();
  expect(activeRow).toEqual({ posts_7d: 2, posts_30d: 3, avg_eng_7d: 150, cross_mentions_72h: 0 });

  // Briefing includes synced top_signals, latest_signal_at, and full pending_drafts
  const briefing = await callMcp("hub_briefing", { page_id: "basehub" });
  const basePage = briefing.pages[0];
  expect(basePage.latest_signal_at).toBe(now - 3600);
  expect(basePage.top_signals.length).toBeGreaterThanOrEqual(1);
  expect(basePage.top_signals[0].text).toContain("mainnet v3");
  expect(basePage.pending_drafts.length).toBe(2);
  expect(basePage.pending_drafts[0].body).toContain("@");
  expect(Array.isArray(basePage.pending_drafts[0].source_urls)).toBe(true);
  expect(typeof basePage.pending_drafts[0].vibe_passed).toBe("boolean");

  // AIonBase (ecosystem='base-ai') also receives signals from Base projects assigned to pages_json
  const aiBriefing = await callMcp("hub_briefing", { page_id: "aionbase" });
  const aiPage = aiBriefing.pages[0];
  expect(aiPage.latest_signal_at).toBe(now - 3600);
  expect(aiPage.top_signals.length).toBeGreaterThanOrEqual(1);
  expect(aiPage.top_signals[0].handle).toBe("activeproj");

  // Gold opt-out honored even with edited_body
  const decideRes = await callMcp("hub_draft_decide", {
    draft_id: draft1.draft_id,
    status: "approved",
    edited_body: "Edited clean copy",
    save_as_gold: false,
  });
  expect(decideRes.is_gold_example).toBe(false);
  const briefingAfter = await callMcp("hub_briefing", { page_id: "basehub" });
  expect(briefingAfter.pages[0].gold_examples).toHaveLength(0);

  // 5: 35 newer 'proposed' rows do not erase an active 21d spotlight cooldown
  await db
    .prepare(
      `INSERT INTO selection_history (pick_id, page_id, series, handle, category, total_score, momentum_score, ship_score, tier_fit_score, cooldown_score, learned_score, evidence_urls_json, decision, created_at)
       VALUES ('approved-spotlight', 'basehub', 'spotlight', 'activeproj', 'defi', 50, 15, 15, 15, 5, 0, '[]', 'approved', ?)`,
    )
    .bind(now - 2 * 86400)
    .run();
  for (let i = 0; i < 35; i++) {
    await db
      .prepare(
        `INSERT INTO selection_history (pick_id, page_id, series, handle, category, total_score, momentum_score, ship_score, tier_fit_score, cooldown_score, learned_score, evidence_urls_json, decision, created_at)
         VALUES (?, 'basehub', 'spotlight', 'activeproj', 'defi', 40, 10, 10, 15, 5, 0, '[]', 'proposed', ?)`,
      )
      .bind(`prop-${i}`, now - 3600 + i)
      .run();
  }
  const ranked = await rankProjectsForSeries(db, {
    pageId: "basehub",
    series: "spotlight",
    replay: true,
  });
  const activeCandidate = ranked.candidates.find((c) => c.handle === "activeproj");
  expect(activeCandidate?.scores.cooldown).toBeLessThanOrEqual(-40);
});

test("live integration helpers: SSE+TSV parsing, Host header, and partner CSV sync", async () => {
  const tsv = [
    "#OK ok=1 err=0 ms=42 posts=1",
    "id\t@user\ttime\tkind\tthread\ttext\timages\tlinks\tquote\tlikes\treplies\treposts\tquotes\tbookmarks\tviews\turl\tquote_url\tretweeted_by\treply_to",
    "123\t@UseOttoAI\t2026-11-20T10:00:00Z\tpost\t-\tShipped mainnet v2\\nLive now\t-\t-\t-\t12\t1\t3\t0\t5\t900\thttps://x.com/useottoai/status/123\t-\t-\t-",
  ].join("\n");
  const parsed = parseXeffectTsvPosts(tsv);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.handle).toBe("useottoai");
  expect(parsed[0]?.text).toBe("Shipped mainnet v2\nLive now");
  expect(parsed[0]?.likes).toBe(12);

  let seenHost = "";
  const sseFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenHost = headers.get("host") ?? "";
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: tsv }] },
    });
    return new Response(`event: message\ndata: ${payload}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;

  const res = await callXeffectTool<{ posts?: unknown[] }>(
    {
      DB: createMockD1(),
      XEFFECT_URL: "https://xeffect.example.workers.dev/mcp",
      XEFFECT_TOKEN: "tok",
    },
    "posts",
    { targets: [{ handle: "useottoai", since: "72h", last: 5 }] },
    sseFetch,
  );
  expect(res.ok).toBe(true);
  expect(seenHost).toBe("xeffect.example.workers.dev");
  expect(res.data?.posts).toHaveLength(1);

  const db = createMockD1();
  const csv = [
    ",Freq,Active partners,Expired Partner ,Blacklist",
    'Base,"HIGH, weekly",https://x.com/Uptopia_xyz,https://x.com/Wach_AI,https://x.com/Stonxfun',
    "Robinhood,MEDIUM,https://x.com/DogestarOnRH,,",
  ].join("\n");
  const csvFetch = (async () => new Response(csv, { status: 200 })) as unknown as typeof fetch;
  const synced = await syncPartnersFromCsv(db, "https://sheets.example/partners.csv", csvFetch);
  expect(synced.ok).toBe(true);
  expect(synced.synced).toBe(4);
  const activeBase = await listActivePartners(db, "basehub");
  expect(activeBase.map((p) => p.handle)).toEqual(["uptopia_xyz"]);
  const activeRh = await listActivePartners(db, "robinhub");
  expect(activeRh.map((p) => p.handle)).toEqual(["dogestaronrh"]);

  // Custom obligations survive subsequent CSV syncs
  await upsertPartner(db, {
    partner_id: "base_uptopia_xyz",
    name: "Uptopia",
    handle: "uptopia_xyz",
    pages: ["basehub", "aionbase"],
    deliverable: "2 spotlight threads",
    due_date: "2026-11-28",
    brief_url: "https://notion.so/uptopia-brief",
    status: "active",
  });
  await syncPartnersFromCsv(db, "https://sheets.example/partners.csv", csvFetch);
  const afterResync = (await listActivePartners(db, "basehub")).find(
    (p) => p.partner_id === "base_uptopia_xyz",
  );
  expect(afterResync?.deliverable).toBe("2 spotlight threads");
  expect(afterResync?.due_date).toBe("2026-11-28");
  expect(afterResync?.brief_url).toBe("https://notion.so/uptopia-brief");

  // Partial legacy batch failure reports ok=false and preserves failed batch project stats
  const partialDb = createMockD1();
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 21; i += 1) {
    await partialDb
      .prepare(
        `INSERT INTO projects (handle, name, ecosystem, pages_json, category, tier, followers_count, posts_7d, posts_30d, avg_eng_7d, cross_mentions_72h, active, updated_at)
         VALUES (?, ?, 'base', '["basehub"]', 'app', 2, 1000, 9, 12, 50, 0, 1, ?)`,
      )
      .bind(`proj${i}`, `Proj ${i}`, nowSec)
      .run();
  }
  let legacyBatchCall = 0;
  const partialFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      params?: { arguments?: { accounts?: string[]; targets?: Array<{ handle: string }> } };
    };
    if (body.params?.arguments?.accounts) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "targets required" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    legacyBatchCall += 1;
    if (legacyBatchCall === 1) {
      const batchTsv = [
        "#OK ok=1 err=0 ms=10 posts=1",
        "id\t@user\ttime\tkind\tthread\ttext\timages\tlinks\tquote\tlikes\treplies\treposts\tquotes\tbookmarks\tviews\turl\tquote_url\tretweeted_by\treply_to",
        `p0\t@proj0\t2026-11-20T10:00:00Z\tpost\t-\tShipped mainnet\t-\t-\t-\t5\t0\t1\t0\t2\t100\thttps://x.com/proj0/status/p0\t-\t-\t-`,
      ].join("\n");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: batchTsv }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("upstream down", { status: 400 });
  }) as unknown as typeof fetch;

  const partialSync = await syncDoomscroll(
    {
      DB: partialDb,
      XEFFECT_URL: "https://xeffect.example.workers.dev/mcp",
      XEFFECT_TOKEN: "tok",
    },
    { ecosystem: "base", hours: 72, fetchImpl: partialFetch },
  );
  expect(partialSync.ok).toBe(false);
  expect(partialSync.error).toContain("HTTP 400");
  expect(partialSync.signals_upserted).toBe(1);
  expect(partialSync.projects_updated).toBe(20);
  const untouched = await partialDb
    .prepare("SELECT posts_7d, posts_30d FROM projects WHERE handle = 'proj20'")
    .first<{ posts_7d: number; posts_30d: number }>();
  expect(untouched?.posts_7d).toBe(9);
  expect(untouched?.posts_30d).toBe(12);

  // getDoomscrollHealth must not mask real upstream health failures via tools/list
  const realErrorFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "posts" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "X cookies expired" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const failedHealth = await getDoomscrollHealth(
    {
      DB: db,
      XEFFECT_URL: "https://xeffect.example.workers.dev/mcp",
      XEFFECT_TOKEN: "tok",
    },
    realErrorFetch,
  );
  expect(failedHealth.ok).toBe(false);
  expect(failedHealth.error).toContain("X cookies expired");

  // Legacy xeffect without a `health` tool still reports legacy capability mode
  const legacyMissingHealthFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string };
    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "posts" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "Tool health not found" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const legacyHealth = await getDoomscrollHealth(
    {
      DB: db,
      XEFFECT_URL: "https://xeffect.example.workers.dev/mcp",
      XEFFECT_TOKEN: "tok",
    },
    legacyMissingHealthFetch,
  );
  expect(legacyHealth.ok).toBe(true);
  expect((legacyHealth.status as { mode?: string }).mode).toBe("xeffect-mcp-legacy");
});

test("notion v3 client: cookie parsing, health, tasks, page body/comments, and hub_briefing integration", async () => {
  expect(buildNotionCookieHeader(undefined)).toBeNull();
  expect(buildNotionCookieHeader("v03%3Aabc")).toBe("token_v2=v03%3Aabc");
  expect(
    buildNotionCookieHeader(
      JSON.stringify([
        { name: "token_v2", value: "v03%3Aabc" },
        { name: "notion_user_id", value: "u-1" },
      ]),
    ),
  ).toBe("token_v2=v03%3Aabc; notion_user_id=u-1");
  expect(
    normalizeNotionId("https://app.notion.com/p/hb2023/2c83c88d5f6980439847c5756117cd2d?v=abc"),
  ).toBe("2c83c88d-5f69-8043-9847-c5756117cd2d");

  const db = createMockD1();
  const unconfigured = await checkNotionHealth({ DB: db });
  expect(unconfigured.ok).toBe(false);
  expect(unconfigured.cookie_status).toBe("unconfigured");

  const notionFetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.endsWith("/getSpaces")) {
      return new Response(
        JSON.stringify({
          "user-1": {
            space: {
              "835b528e-c5a8-4a45-896b-ff702fdbc807": { value: { name: "HB Block" } },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.endsWith("/queryCollection")) {
      return new Response(
        JSON.stringify({
          result: {
            reducerResults: {
              collection_group_results: {
                blockIds: ["row-open", "row-posted"],
              },
            },
          },
          recordMap: {
            collection: {
              "2c83c88d-5f69-81c5-93d6-000b91d99eae": {
                value: {
                  schema: {
                    title: { name: "Title", type: "title" },
                    ch: { name: "Channel", type: "select" },
                    st: {
                      name: "Status",
                      type: "status",
                      options: [
                        { id: "opt-1", value: "Done Content" },
                        { id: "opt-2", value: "Posted" },
                      ],
                      groups: [
                        { id: "grp-1", name: "In progress", optionIds: ["opt-1"] },
                        { id: "grp-2", name: "Complete", optionIds: ["opt-2"] },
                      ],
                    },
                    dt: { name: "Date", type: "date" },
                    nt: { name: "Note", type: "text" },
                  },
                },
              },
            },
            block: {
              "row-open": {
                value: {
                  id: "row-open",
                  last_edited_time: 1795200000000,
                  discussions: ["disc-1"],
                  properties: {
                    title: [["State of Base Agents"]],
                    ch: [["Base Hub"]],
                    st: [["Done Content"]],
                    dt: [["‣", [["d", { start_date: "2026-11-21" }]]]],
                    nt: [["Check comment thread"]],
                  },
                },
              },
              "row-posted": {
                value: {
                  id: "row-posted",
                  last_edited_time: 1795100000000,
                  properties: {
                    title: [["Already Posted Recap"]],
                    ch: [["Base Hub"]],
                    st: [["Posted"]],
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.endsWith("/loadPageChunk")) {
      return new Response(
        JSON.stringify({
          recordMap: {
            block: {
              "2c83c88d-5f69-8043-9847-c5756117cd2d": {
                value: {
                  id: "2c83c88d-5f69-8043-9847-c5756117cd2d",
                  content: ["child-1"],
                  properties: { title: [["State of Base Agents"]] },
                },
              },
              "child-1": {
                value: {
                  id: "child-1",
                  type: "bulleted_list",
                  properties: { title: [["Include Aerodrome and Virtuals metrics."]] },
                },
              },
            },
            discussion: {
              "disc-1": { value: { id: "disc-1", resolved: false } },
            },
            comment: {
              "c-1": {
                value: {
                  id: "c-1",
                  parent_id: "disc-1",
                  text: [["Please double check TVL figures."]],
                  created_time: 1795200000000,
                  created_by_id: "user-2",
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const env: Env = {
    DB: db,
    HUB_MCP_TOKEN: "hub-secret",
    NOTION_COOKIE: "token_v2=test-cookie",
  };

  const health = await checkNotionHealth(env, notionFetch);
  expect(health.ok).toBe(true);
  expect(health.cookie_status).toBe("ok");

  const tasks = await listNotionTasks(env, { pageId: "basehub", openOnly: true }, notionFetch);
  expect(tasks.ok).toBe(true);
  if (tasks.ok) {
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.tasks[0]?.title).toBe("State of Base Agents");
    expect(tasks.tasks[0]?.properties.Channel).toBe("Base Hub");
    expect(tasks.tasks[0]?.properties.Date).toBe("2026-11-21");
    expect(tasks.tasks[0]?.status_group).toBe("In progress");
    expect(tasks.tasks[0]?.discussion_count).toBe(1);
  }

  const page = await getNotionPage(env, "2c83c88d5f6980439847c5756117cd2d", notionFetch);
  expect(page.ok).toBe(true);
  if (page.ok) {
    expect(page.page.blocks).toHaveLength(1);
    expect(page.page.comments).toHaveLength(1);
    expect(page.page.comments[0]?.text).toContain("TVL figures");
  }

  const briefRes = await handleHubMcp(
    new Request("https://hubos/mcp", {
      method: "POST",
      headers: { authorization: "Bearer hub-secret", "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "hub_briefing", arguments: { page_id: "basehub" } },
      }),
    }),
    env,
    notionFetch,
  );
  const briefJson = (await briefRes.json()) as { result: { content: Array<{ text: string }> } };
  const brief = JSON.parse(briefJson.result.content[0]?.text ?? "{}") as {
    notion_status: string;
    pages: Array<{ page_id: string; notion_tasks: Array<{ title: string }> }>;
  };
  expect(brief.notion_status).toBe("ok");
  expect(brief.pages[0]?.notion_tasks[0]?.title).toBe("State of Base Agents");
});

test("Notion v3 root write tools execute directly with no approval gate", async () => {
  const db = createMockD1();
  const capturedOps: Array<{ path: string; body: Record<string, unknown> }> = [];
  const pageId = "2c83c88d-5f69-8043-9847-c5756117cd2d";
  const colId = "2c83c88d-5f69-81c5-93d6-000b91d99eae";

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.split("/api/v3/")[1] ?? "";
    const parsed = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    capturedOps.push({ path, body: parsed });

    if (path === "syncRecordValues") {
      return new Response(
        JSON.stringify({
          recordMap: {
            collection: {
              [colId]: {
                value: {
                  schema: {
                    "{XpB": { name: "Channel", type: "select" },
                    ":vF}": { name: "Status", type: "status" },
                    "[A?a": { name: "Type", type: "multi_select" },
                    "HR;A": { name: "Priority", type: "select" },
                    "l{?I": { name: "Date", type: "date" },
                    F_pz: { name: "Note ", type: "text" },
                    ":_ZW": { name: "Result (X Link) ", type: "url" },
                    "I:\\;": { name: "Visual link", type: "url" },
                    newCol: { name: "Custom Flag", type: "checkbox" },
                  },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path === "loadPageChunk") {
      return new Response(
        JSON.stringify({
          recordMap: {
            block: {
              [pageId]: {
                value: {
                  id: pageId,
                  type: "page",
                  properties: { title: [["Old Card"]] },
                  content: ["old-blk-1"],
                },
              },
              "old-blk-1": {
                value: {
                  id: "old-blk-1",
                  type: "text",
                  properties: { title: [["Old paragraph"]] },
                },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path === "getSpaces") {
      return new Response(
        JSON.stringify({ "11111111-1111-1111-1111-111111111111": { space: {} } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (path === "saveTransactionsFanout") {
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const env: Env = {
    DB: db,
    HUB_MCP_TOKEN: "hub-secret",
    NOTION_COOKIE: "token_v2=test-cookie",
  };

  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await handleHubMcp(
      new Request("https://hubos/mcp", {
        method: "POST",
        headers: { authorization: "Bearer hub-secret", "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
      mockFetch,
    );
    const json = (await res.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    return {
      isError: json.result.isError,
      data: JSON.parse(json.result.content[0]?.text ?? "{}") as Record<string, unknown>,
    };
  };

  // Verify tools/list exposes all 7 root write tools with no approval parameter
  const listRes = await handleHubMcp(
    new Request("https://hubos/mcp", {
      method: "POST",
      headers: { authorization: "Bearer hub-secret", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    }),
    env,
    mockFetch,
  );
  const listJson = (await listRes.json()) as {
    result: {
      tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>;
    };
  };
  const writeToolNames = [
    "notion_schema",
    "notion_search",
    "notion_create_task",
    "notion_update_task",
    "notion_append_blocks",
    "notion_replace_blocks",
    "notion_update_block",
    "notion_comment",
    "notion_archive_task",
  ];
  for (const toolName of writeToolNames) {
    const found = listJson.result.tools.find((t) => t.name === toolName);
    expect(found).toBeDefined();
    expect(found?.inputSchema.properties?.approved).toBeUndefined();
  }

  // 0. Discover live schema (including newly added custom columns)
  const schemaRes = await callTool("notion_schema", {});
  expect(schemaRes.isError).toBe(false);
  expect(schemaRes.data.ok).toBe(true);

  // 1. Create task with dynamic properties (no hardcoded mappings) + markdown body
  const created = await callTool("notion_create_task", {
    title: "Base Daily Recap",
    properties: {
      Channel: "Brand New Page",
      Status: "Brand New Status",
      Type: ["Recap", "Insights"],
      Date: "2026-11-22",
      "Custom Flag": true,
    },
    markdown: "# Hook\n- Bullet one\n---",
  });
  expect(created.isError).toBe(false);
  expect(created.data.ok).toBe(true);
  expect((created.data.added_block_ids as string[]).length).toBe(3);

  // 2. Update task using arbitrary live property names
  const updated = await callTool("notion_update_task", {
    page_id: pageId,
    properties: {
      Status: "Brand New Status",
      Note: "Ready for visual",
      "Result (X Link)": "https://x.com/basehub/status/123",
      "Custom Flag": false,
    },
  });
  expect(updated.isError).toBe(false);
  expect(updated.data.updated_fields).toEqual([
    "Status",
    "Note ",
    "Result (X Link) ",
    "Custom Flag",
  ]);

  // 3. Append blocks
  const appended = await callTool("notion_append_blocks", {
    page_id: pageId,
    markdown: "## Draft\nLine 1\n- Item A",
  });
  expect(appended.isError).toBe(false);
  expect((appended.data.added_block_ids as string[]).length).toBe(3);

  // 4. Replace blocks
  const replaced = await callTool("notion_replace_blocks", {
    page_id: pageId,
    markdown: "Fresh single paragraph",
  });
  expect(replaced.isError).toBe(false);
  expect(replaced.data.removed_block_ids).toEqual(["old-blk-1"]);
  expect((replaced.data.added_block_ids as string[]).length).toBe(1);

  // 5. Update single block
  const blkUpdated = await callTool("notion_update_block", {
    block_id: "old-blk-1",
    text: "Edited line",
  });
  expect(blkUpdated.isError).toBe(false);
  expect(blkUpdated.data.ok).toBe(true);

  // 6. Comment & resolve
  const commented = await callTool("notion_comment", {
    page_id: pageId,
    text: "Draft updated and marked Done Content",
  });
  expect(commented.isError).toBe(false);
  expect(typeof commented.data.discussion_id).toBe("string");
  const resolved = await callTool("notion_comment", {
    discussion_id: String(commented.data.discussion_id),
    resolve: true,
  });
  expect(resolved.isError).toBe(false);
  expect(resolved.data.resolved).toBe(true);

  // 7. Archive & restore
  const archived = await callTool("notion_archive_task", { page_id: pageId, archive: true });
  expect(archived.isError).toBe(false);
  expect(archived.data.archived).toBe(true);

  // Verify saveTransactionsFanout calls were issued and non-title properties use updateBlockPropertyValue
  const txCalls = capturedOps.filter((c) => c.path === "saveTransactionsFanout");
  expect(txCalls.length).toBe(8);
  const allOps = txCalls.flatMap((c) => {
    const txs =
      (c.body.transactions as Array<{ operations?: Array<Record<string, unknown>> }>) ?? [];
    return txs.flatMap((t) => t.operations ?? []);
  });
  const hlops = allOps.filter((op) => op.command === "updateBlockPropertyValue");
  expect(hlops.length).toBe(2);
  expect(hlops[0]?.path).toEqual(["properties"]);
  expect(hlops[1]?.path).toEqual(["properties"]);
});
