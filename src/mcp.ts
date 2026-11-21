import { getDoomscrollHealth, syncDoomscroll } from "./doomscroll.ts";
import { getGoldExamples, getRecentHooks, getTopPerformingHooks } from "./metrics.ts";
import {
  appendNotionBlocks,
  archiveNotionTask,
  checkNotionHealth,
  commentOnNotionPage,
  createNotionTask,
  getNotionPage,
  getNotionSchema,
  listNotionTasks,
  type NotionBlockInput,
  type NotionTask,
  replaceNotionBlocks,
  searchNotion,
  updateNotionBlock,
  updateNotionTask,
} from "./notion.ts";
import { listActivePartners, syncPartnersFromCsv, upsertPartner } from "./partners.ts";
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
      "List, sync from the partner CSV sheet, or upsert isolated partner briefs and deliverables (kept separate from organic signals).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "sync", "upsert"], default: "list" },
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
  {
    name: "notion_schema",
    description:
      "Inspect the live Notion database schema (all columns, types, status groups, and select/multi_select options). Call this whenever you need current column names or valid options; never assume fixed statuses or mappings.",
    inputSchema: {
      type: "object",
      properties: {
        board_page_id: {
          type: "string",
          description:
            "Optional Notion database/board page ID or URL to inspect instead of default",
        },
        collection_id: { type: "string", description: "Optional Notion collection ID" },
        space_id: { type: "string", description: "Optional Notion space ID" },
      },
    },
  },
  {
    name: "notion_search",
    description:
      "Search across the Notion workspace for any page, database, or card (useful when new pages or boards are added).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        space_id: { type: "string" },
        limit: { type: "number", default: 20 },
      },
      required: ["query"],
    },
  },
  {
    name: "notion_tasks",
    description:
      "Query Notion tasks/rows dynamically from the live database schema. Filter by status, channel, search text, arbitrary column filters, open_only, or only_with_comments. Works on any database via optional collection_id/view_id/space_id.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "Optional fuzzy match against any text property (e.g. page/channel name)",
        },
        channel: { type: "string" },
        status: { type: "string" },
        search: { type: "string", description: "Substring search across title and properties" },
        filters: {
          type: "object",
          description: "Arbitrary map of column name (or key) -> expected value or array of values",
        },
        open_only: { type: "boolean", default: true },
        only_with_comments: { type: "boolean", default: false },
        limit: { type: "number", default: 100 },
        collection_id: { type: "string" },
        view_id: { type: "string" },
        space_id: { type: "string" },
      },
    },
  },
  {
    name: "notion_page",
    description:
      "Fetch any Notion page's live decoded properties, body blocks, and discussion comments (accepts page ID or Notion URL).",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_health",
    description: "Check whether the Notion session cookie (NOTION_COOKIE) is configured and valid.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notion_create_task",
    description:
      "Create a new card/row in any Notion database using live schema column names (or raw property keys) and optional Markdown/block content. Executes immediately with no approval gate.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        properties: {
          type: "object",
          description:
            "Map of live Notion column name (e.g. Status, Channel, Priority, Date, Type, Note, or any newly added column) -> value. Call notion_schema to see all columns and options.",
        },
        markdown: { type: "string", description: "Optional initial page body in Markdown" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
        collection_id: { type: "string" },
        space_id: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "notion_update_task",
    description:
      "Update title and/or any properties on an existing Notion card/page by live column name or property key (automatically resolves the page's parent database schema; pass null to clear a field). Executes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page ID or URL" },
        title: { type: "string" },
        properties: {
          type: "object",
          description:
            "Map of live column name or key -> value (or null to clear). Works with any existing or newly added column/status.",
        },
        collection_id: { type: "string" },
        space_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_append_blocks",
    description:
      "Append Markdown or structured blocks to any Notion page body (optionally after a specific block ID). Executes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page ID or URL" },
        markdown: { type: "string" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
        after_block_id: { type: "string" },
        space_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_replace_blocks",
    description:
      "Replace all child content blocks on a Notion page with new Markdown or structured blocks in one atomic transaction. Executes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page ID or URL" },
        markdown: { type: "string" },
        blocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              text: { type: "string" },
              checked: { type: "boolean" },
            },
          },
        },
        space_id: { type: "string" },
      },
      required: ["page_id"],
    },
  },
  {
    name: "notion_update_block",
    description:
      "Update a single Notion block's text, type, or alive flag (set alive=false to delete a block). Executes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: { type: "string" },
        text: { type: "string" },
        type: { type: "string" },
        alive: { type: "boolean" },
        space_id: { type: "string" },
      },
      required: ["block_id"],
    },
  },
  {
    name: "notion_comment",
    description:
      "Create a new comment thread on a Notion page, reply to an existing discussion_id, or resolve/reopen a discussion. Executes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Required when starting a new comment thread" },
        discussion_id: {
          type: "string",
          description: "Existing discussion ID to reply to or resolve",
        },
        text: { type: "string" },
        resolve: {
          type: "boolean",
          description: "Set true to resolve or false to reopen discussion_id",
        },
        space_id: { type: "string" },
      },
    },
  },
  {
    name: "notion_archive_task",
    description:
      "Archive (or restore with archive=false) a Notion task card/page. Executes immediately.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string", description: "Notion page ID or URL" },
        archive: { type: "boolean", default: true },
        space_id: { type: "string" },
      },
      required: ["page_id"],
    },
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
  fetchImpl?: typeof fetch,
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
      let notionStatus: "ok" | "expired" | "unconfigured" = env.NOTION_COOKIE
        ? "ok"
        : "unconfigured";
      let notionError: string | undefined;
      let allNotionTasks: NotionTask[] = [];
      if (env.NOTION_COOKIE) {
        const notionRes = await listNotionTasks(
          env,
          { pageId, openOnly: true, limit: 100 },
          fetchImpl,
        );
        if (notionRes.ok) {
          allNotionTasks = notionRes.tasks;
        } else {
          notionStatus = "expired";
          notionError = notionRes.error;
        }
      }
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
            notion_tasks: allNotionTasks
              .filter((t) => {
                const wantId = p.page_id.toLowerCase().replace(/[^a-z0-9]/g, "");
                const wantName = p.name.toLowerCase().replace(/[^a-z0-9]/g, "");
                return Object.values(t.properties).some((v) => {
                  if (typeof v !== "string") return false;
                  const norm = v.toLowerCase().replace(/[^a-z0-9]/g, "");
                  return norm === wantId || norm === wantName || norm.includes(wantId);
                });
              })
              .slice(0, 15),
            top_hooks_14d: topHooks,
            gold_examples: goldExamples,
          };
        }),
      );

      return okRpc(
        body.id,
        toolResult({
          notion_status: notionStatus,
          ...(notionError ? { notion_error: notionError } : {}),
          pages: briefings,
        }),
      );
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
      if (action === "sync") {
        if (!env.PARTNER_SHEET_CSV_URL) {
          return okRpc(
            body.id,
            toolResult(
              { ok: false, synced: 0, error: "PARTNER_SHEET_CSV_URL not configured" },
              true,
            ),
          );
        }
        const res = await syncPartnersFromCsv(env.DB, env.PARTNER_SHEET_CSV_URL, fetchImpl);
        const partners = await listActivePartners(
          env.DB,
          typeof args.page_id === "string" ? args.page_id : undefined,
        );
        return okRpc(
          body.id,
          toolResult({ ...res, active_count: partners.length, partners }, !res.ok),
        );
      }
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

    if (name === "notion_schema") {
      const res = await getNotionSchema(
        env,
        {
          boardPageId: typeof args.board_page_id === "string" ? args.board_page_id : undefined,
          collectionId: typeof args.collection_id === "string" ? args.collection_id : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_search") {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        return okRpc(body.id, toolResult({ ok: false, error: "query is required" }, true));
      }
      const res = await searchNotion(
        env,
        {
          query,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
          limit: typeof args.limit === "number" ? args.limit : 20,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_tasks") {
      const res = await listNotionTasks(
        env,
        {
          pageId: typeof args.page_id === "string" ? args.page_id : undefined,
          channel: typeof args.channel === "string" ? args.channel : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          search: typeof args.search === "string" ? args.search : undefined,
          filters:
            args.filters && typeof args.filters === "object"
              ? (args.filters as Record<string, string | string[]>)
              : undefined,
          openOnly: args.open_only === undefined ? true : Boolean(args.open_only),
          onlyWithComments: Boolean(args.only_with_comments),
          limit: typeof args.limit === "number" ? args.limit : 100,
          collectionId: typeof args.collection_id === "string" ? args.collection_id : undefined,
          viewId: typeof args.view_id === "string" ? args.view_id : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(
        body.id,
        toolResult(
          res.ok
            ? { ok: true, schema: res.schema, count: res.tasks.length, tasks: res.tasks }
            : res,
          !res.ok,
        ),
      );
    }

    if (name === "notion_page") {
      const target = String(args.page_id ?? "");
      if (!target) {
        return okRpc(body.id, toolResult({ ok: false, error: "page_id is required" }, true));
      }
      const res = await getNotionPage(env, target, fetchImpl);
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_health") {
      const res = await checkNotionHealth(env, fetchImpl);
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_create_task") {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) {
        return okRpc(body.id, toolResult({ ok: false, error: "title is required" }, true));
      }
      const res = await createNotionTask(
        env,
        {
          title,
          properties:
            args.properties && typeof args.properties === "object"
              ? (args.properties as Record<string, unknown>)
              : undefined,
          markdown: typeof args.markdown === "string" ? args.markdown : undefined,
          blocks: Array.isArray(args.blocks) ? (args.blocks as NotionBlockInput[]) : undefined,
          collectionId: typeof args.collection_id === "string" ? args.collection_id : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_update_task") {
      const target = typeof args.page_id === "string" ? args.page_id.trim() : "";
      if (!target) {
        return okRpc(body.id, toolResult({ ok: false, error: "page_id is required" }, true));
      }
      const res = await updateNotionTask(
        env,
        {
          pageId: target,
          title: typeof args.title === "string" ? args.title : undefined,
          properties:
            args.properties && typeof args.properties === "object"
              ? (args.properties as Record<string, unknown>)
              : undefined,
          collectionId: typeof args.collection_id === "string" ? args.collection_id : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_append_blocks") {
      const target = typeof args.page_id === "string" ? args.page_id.trim() : "";
      if (!target) {
        return okRpc(body.id, toolResult({ ok: false, error: "page_id is required" }, true));
      }
      const res = await appendNotionBlocks(
        env,
        {
          pageId: target,
          markdown: typeof args.markdown === "string" ? args.markdown : undefined,
          blocks: Array.isArray(args.blocks) ? (args.blocks as NotionBlockInput[]) : undefined,
          afterBlockId: typeof args.after_block_id === "string" ? args.after_block_id : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_replace_blocks") {
      const target = typeof args.page_id === "string" ? args.page_id.trim() : "";
      if (!target) {
        return okRpc(body.id, toolResult({ ok: false, error: "page_id is required" }, true));
      }
      const res = await replaceNotionBlocks(
        env,
        {
          pageId: target,
          markdown: typeof args.markdown === "string" ? args.markdown : undefined,
          blocks: Array.isArray(args.blocks) ? (args.blocks as NotionBlockInput[]) : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_update_block") {
      const target = typeof args.block_id === "string" ? args.block_id.trim() : "";
      if (!target) {
        return okRpc(body.id, toolResult({ ok: false, error: "block_id is required" }, true));
      }
      const res = await updateNotionBlock(
        env,
        {
          blockId: target,
          text: typeof args.text === "string" ? args.text : undefined,
          type: typeof args.type === "string" ? args.type : undefined,
          alive: typeof args.alive === "boolean" ? args.alive : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_comment") {
      const res = await commentOnNotionPage(
        env,
        {
          pageId: typeof args.page_id === "string" ? args.page_id : undefined,
          discussionId: typeof args.discussion_id === "string" ? args.discussion_id : undefined,
          text: typeof args.text === "string" ? args.text : undefined,
          resolve: typeof args.resolve === "boolean" ? args.resolve : undefined,
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    if (name === "notion_archive_task") {
      const target = typeof args.page_id === "string" ? args.page_id.trim() : "";
      if (!target) {
        return okRpc(body.id, toolResult({ ok: false, error: "page_id is required" }, true));
      }
      const res = await archiveNotionTask(
        env,
        {
          pageId: target,
          archive: args.archive === undefined ? true : Boolean(args.archive),
          spaceId: typeof args.space_id === "string" ? args.space_id : undefined,
        },
        fetchImpl,
      );
      return okRpc(body.id, toolResult(res, !res.ok));
    }

    return errRpc(body.id, -32601, `Unknown tool: ${name}`);
  }

  return errRpc(body.id, -32601, `Unsupported method: ${body.method}`);
}
