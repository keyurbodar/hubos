import { getDoomscrollHealth, syncDoomscroll } from "./doomscroll.ts";
import { getGoldExamples, getRecentHooks, getTopPerformingHooks } from "./metrics.ts";
import { listActivePartners, upsertPartner } from "./partners.ts";
import { rankProjectsForSeries, recordPickDecision } from "./picker.ts";
import type { Env, PageConfig } from "./types.ts";
import { runVibeCheck } from "./vibe-check.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "hub_briefing",
    description:
      "One-call daily briefing for one page or all 5 pages: page voice, top signals, pending drafts, gold examples, 14d top hooks, and isolated active partner deliverables.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          enum: ["basehub", "aionbase", "robinhub", "robinhoodhub", "elysiumhub"],
        },
      },
    },
  },
  {
    name: "picker_rank",
    description:
      "Rank candidate projects for a page and series using momentum, ship score, tier+fit, cooldowns, and learned outcomes. Logs selection history unless replay=true.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        series: { type: "string" },
        limit: { type: "number", default: 5 },
        replay: { type: "boolean", default: false },
      },
      required: ["page_id", "series"],
    },
  },
  {
    name: "picker_decide",
    description:
      "Record human approval, skip, or 7d performance metrics for a pick_id so the picker learns over time.",
    inputSchema: {
      type: "object",
      properties: {
        pick_id: { type: "string" },
        decision: { type: "string", enum: ["approved", "skipped"] },
        note: { type: "string" },
        post_views: { type: "number" },
        post_likes: { type: "number" },
        post_bookmarks: { type: "number" },
        page_median_views: { type: "number" },
      },
      required: ["pick_id", "decision"],
    },
  },
  {
    name: "vibe_check",
    description:
      "Run deterministic writing and structure checks (zero em dashes, no slop, no progressive-tense chains, no chain-name echo, no empty wrap-ups, source URLs required).",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        body: { type: "string" },
        source_urls: { type: "array", items: { type: "string" } },
      },
      required: ["body", "source_urls"],
    },
  },
  {
    name: "hub_draft_save",
    description:
      "Validate a draft through vibe-check + cross-draft hook deduplication and store it in pending approval queue.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        series: { type: "string" },
        target_handle: { type: "string" },
        body: { type: "string" },
        source_urls: { type: "array", items: { type: "string" } },
      },
      required: ["page_id", "series", "body", "source_urls"],
    },
  },
  {
    name: "hub_draft_decide",
    description:
      "Approve, reject, or save an edited draft. Edited approvals are stored as gold examples so future runs match the user's exact voice.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        status: { type: "string", enum: ["approved", "rejected"] },
        edited_body: { type: "string" },
        save_as_gold: { type: "boolean", default: true },
      },
      required: ["draft_id", "status"],
    },
  },
  {
    name: "hub_partners",
    description:
      "List or upsert isolated partner briefs and deliverables (kept separate from organic signals).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "upsert"], default: "list" },
        page_id: { type: "string" },
        partner: { type: "object" },
      },
    },
  },
  {
    name: "doomscroll_sync",
    description:
      "Pull fresh X posts from the general xeffect MCP for tracked Hub projects, score shipping events, compute 72h cross-mentions, and store normalized signals in D1.",
    inputSchema: {
      type: "object",
      properties: {
        ecosystem: { type: "string", enum: ["base", "robinhood", "elysium"] },
        hours: { type: "number", default: 72 },
      },
    },
  },
  {
    name: "doomscroll_health",
    description: "Check upstream xeffect MCP health, cookie validity, and 429 rate-limit status.",
    inputSchema: { type: "object", properties: {} },
  },
];

function okRpc(id: string | number | null | undefined, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function errRpc(id: string | number | null | undefined, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

export async function handleHubMcp(
  req: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!env.HUB_MCP_TOKEN) {
    return new Response("HUB_MCP_TOKEN not configured", { status: 503 });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${env.HUB_MCP_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return errRpc(null, -32700, "Invalid JSON");
  }

  if (body.method === "initialize") {
    return okRpc(body.id, {
      protocolVersion: "2024-11-05",
      serverInfo: { name: "hubos", version: "1.0.0" },
      capabilities: { tools: {} },
    });
  }

  if (body.method === "tools/list") {
    return okRpc(body.id, { tools: TOOLS });
  }

  if (body.method === "tools/call") {
    const name = String(body.params?.name ?? "");
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

    if (name === "hub_briefing") {
      const pageId = typeof args.page_id === "string" ? args.page_id : undefined;
      const pagesRes = pageId
        ? await env.DB.prepare("SELECT * FROM pages WHERE page_id = ?")
            .bind(pageId)
            .all<PageConfig>()
        : await env.DB.prepare("SELECT * FROM pages ORDER BY page_id ASC").all<PageConfig>();
      const pages = pagesRes.results ?? [];

      const now = Math.floor(Date.now() / 1000);
      const signalCutoff = now - 72 * 3600;
      const briefings = await Promise.all(
        pages.map(async (p) => {
          const [partners, topHooks, goldExamples, pending, signalsRes, latestSig] =
            await Promise.all([
              listActivePartners(env.DB, p.page_id),
              getTopPerformingHooks(env.DB, p.page_id, 14),
              getGoldExamples(env.DB, p.page_id),
              env.DB.prepare(
                `SELECT draft_id, series, target_handle, body, edited_body, source_urls_json, vibe_passed, vibe_issues_json, status, created_at
                 FROM drafts
                 WHERE page_id = ? AND status = 'pending'
                 ORDER BY created_at DESC
                 LIMIT 10`,
              )
                .bind(p.page_id)
                .all<{
                  draft_id: string;
                  series: string;
                  target_handle: string | null;
                  body: string;
                  edited_body: string | null;
                  source_urls_json: string;
                  vibe_passed: number;
                  vibe_issues_json: string;
                  status: string;
                  created_at: number;
                }>(),
              env.DB.prepare(
                `SELECT s.signal_id, s.handle, s.text, s.source_url, s.created_at, s.likes, s.reposts, s.bookmarks, s.views, s.ship_score, s.ship_tags_json
                 FROM signals s
                 LEFT JOIN projects pr ON pr.handle = s.handle AND pr.active = 1
                 WHERE s.created_at >= ?
                   AND (
                     s.ecosystem = ?
                     OR (
                       pr.handle IS NOT NULL
                       AND EXISTS (
                         SELECT 1
                         FROM json_each(COALESCE(NULLIF(pr.pages_json, ''), '[]'))
                         WHERE value = ?
                       )
                     )
                   )
                 ORDER BY s.ship_score DESC, s.created_at DESC
                 LIMIT 15`,
              )
                .bind(signalCutoff, p.ecosystem, p.page_id)
                .all<{
                  signal_id: string;
                  handle: string;
                  text: string;
                  source_url: string;
                  created_at: number;
                  likes: number;
                  reposts: number;
                  bookmarks: number;
                  views: number;
                  ship_score: number;
                  ship_tags_json: string;
                }>(),
              env.DB.prepare(
                `SELECT MAX(s.created_at) as latest
                 FROM signals s
                 LEFT JOIN projects pr ON pr.handle = s.handle AND pr.active = 1
                 WHERE s.ecosystem = ?
                   OR (
                     pr.handle IS NOT NULL
                     AND EXISTS (
                       SELECT 1
                       FROM json_each(COALESCE(NULLIF(pr.pages_json, ''), '[]'))
                       WHERE value = ?
                     )
                   )`,
              )
                .bind(p.ecosystem, p.page_id)
                .first<{ latest: number | null }>(),
            ]);
          return {
            page_id: p.page_id,
            name: p.name,
            ecosystem: p.ecosystem,
            voice_rules: p.voice_rules,
            latest_signal_at: latestSig?.latest ?? null,
            top_signals: (signalsRes.results ?? []).map((s) => ({
              signal_id: s.signal_id,
              handle: s.handle,
              text: s.text,
              source_url: s.source_url,
              created_at: s.created_at,
              likes: s.likes,
              reposts: s.reposts,
              bookmarks: s.bookmarks,
              views: s.views,
              ship_score: s.ship_score,
              ship_tags: JSON.parse(s.ship_tags_json || "[]") as string[],
            })),
            pending_drafts: (pending.results ?? []).map((d) => ({
              draft_id: d.draft_id,
              series: d.series,
              target_handle: d.target_handle,
              body: d.body,
              edited_body: d.edited_body,
              source_urls: JSON.parse(d.source_urls_json || "[]") as string[],
              vibe_passed: Boolean(d.vibe_passed),
              vibe_issues: JSON.parse(d.vibe_issues_json || "[]") as unknown[],
              status: d.status,
              created_at: d.created_at,
            })),
            active_partners: partners,
            top_hooks_14d: topHooks,
            gold_examples: goldExamples,
          };
        }),
      );

      return okRpc(body.id, toolResult({ pages: briefings }));
    }

    if (name === "picker_rank") {
      const res = await rankProjectsForSeries(env.DB, {
        pageId: String(args.page_id ?? ""),
        series: String(args.series ?? "spotlight"),
        limit: Number(args.limit ?? 5),
        replay: Boolean(args.replay),
      });
      return okRpc(body.id, toolResult(res));
    }

    if (name === "picker_decide") {
      await recordPickDecision(env.DB, {
        pickId: String(args.pick_id ?? ""),
        decision: args.decision === "skipped" ? "skipped" : "approved",
        note: typeof args.note === "string" ? args.note : undefined,
        postViews: typeof args.post_views === "number" ? args.post_views : undefined,
        postLikes: typeof args.post_likes === "number" ? args.post_likes : undefined,
        postBookmarks: typeof args.post_bookmarks === "number" ? args.post_bookmarks : undefined,
        pageMedianViews:
          typeof args.page_median_views === "number" ? args.page_median_views : undefined,
      });
      return okRpc(body.id, toolResult({ ok: true, pick_id: args.pick_id }));
    }

    if (name === "vibe_check") {
      const pageId = typeof args.page_id === "string" ? args.page_id : undefined;
      const page = pageId
        ? await env.DB.prepare("SELECT * FROM pages WHERE page_id = ?")
            .bind(pageId)
            .first<PageConfig>()
        : null;
      const recentHooks = pageId ? await getRecentHooks(env.DB, pageId, 14) : [];
      const check = runVibeCheck({
        body: String(args.body ?? ""),
        pageName: page?.name,
        chainName:
          page?.ecosystem === "elysium"
            ? "Elysium"
            : page?.ecosystem === "base"
              ? "Base"
              : undefined,
        sourceUrls: (args.source_urls as string[]) ?? [],
        recentHooks,
      });
      return okRpc(body.id, toolResult(check));
    }

    if (name === "hub_draft_save") {
      const pageId = String(args.page_id ?? "");
      const series = String(args.series ?? "");
      const draftBody = String(args.body ?? "");
      const sourceUrls = (args.source_urls as string[]) ?? [];
      const page = await env.DB.prepare("SELECT * FROM pages WHERE page_id = ?")
        .bind(pageId)
        .first<PageConfig>();
      const recentHooks = await getRecentHooks(env.DB, pageId, 14);
      const check = runVibeCheck({
        body: draftBody,
        pageName: page?.name,
        chainName:
          page?.ecosystem === "elysium"
            ? "Elysium"
            : page?.ecosystem === "base"
              ? "Base"
              : undefined,
        sourceUrls,
        recentHooks,
      });

      const now = Math.floor(Date.now() / 1000);
      const draftId = `draft_${now}_${crypto.randomUUID().slice(0, 8)}_${pageId}`;
      await env.DB.prepare(`
        INSERT INTO drafts (
          draft_id, page_id, series, target_handle, body, source_urls_json,
          vibe_passed, vibe_issues_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `)
        .bind(
          draftId,
          pageId,
          series,
          typeof args.target_handle === "string" ? args.target_handle : null,
          draftBody,
          JSON.stringify(sourceUrls),
          check.passed ? 1 : 0,
          JSON.stringify([...check.errors, ...check.warnings]),
          now,
        )
        .run();

      return okRpc(body.id, toolResult({ draft_id: draftId, vibe_check: check }, !check.passed));
    }

    if (name === "hub_draft_decide") {
      const now = Math.floor(Date.now() / 1000);
      const status = args.status === "rejected" ? "rejected" : "approved";
      const editedBody = typeof args.edited_body === "string" ? args.edited_body : null;
      const isGold = status === "approved" && args.save_as_gold !== false ? 1 : 0;
      await env.DB.prepare(
        "UPDATE drafts SET status = ?, edited_body = COALESCE(?, edited_body), is_gold_example = ?, decided_at = ? WHERE draft_id = ?",
      )
        .bind(status, editedBody, isGold, now, String(args.draft_id ?? ""))
        .run();
      return okRpc(
        body.id,
        toolResult({ ok: true, draft_id: args.draft_id, status, is_gold_example: Boolean(isGold) }),
      );
    }

    if (name === "hub_partners") {
      const action = String(args.action ?? "list");
      if (action === "upsert" && args.partner && typeof args.partner === "object") {
        await upsertPartner(env.DB, args.partner as Parameters<typeof upsertPartner>[1]);
        return okRpc(body.id, toolResult({ ok: true }));
      }
      const partners = await listActivePartners(
        env.DB,
        typeof args.page_id === "string" ? args.page_id : undefined,
      );
      return okRpc(body.id, toolResult({ count: partners.length, partners }));
    }

    if (name === "doomscroll_sync") {
      const res = await syncDoomscroll(env, {
        ecosystem: typeof args.ecosystem === "string" ? args.ecosystem : undefined,
        hours: typeof args.hours === "number" ? args.hours : 72,
        fetchImpl,
      });
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "doomscroll_health") {
      const res = await getDoomscrollHealth(env, fetchImpl);
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    return errRpc(body.id, -32601, `Unknown tool: ${name}`);
  }

  return errRpc(body.id, -32601, `Unsupported method: ${body.method}`);
}
