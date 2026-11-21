import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  callXeffectTool,
  parseXeffectTsvPosts,
  scoreShipText,
  syncDoomscroll,
} from "../src/doomscroll.ts";
import { app } from "../src/index.ts";
import { handleHubMcp } from "../src/mcp.ts";
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
});
