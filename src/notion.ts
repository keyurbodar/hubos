import type { Env } from "./types.ts";

export const DEFAULT_NOTION_SPACE_ID = "835b528e-c5a8-4a45-896b-ff702fdbc807";
export const DEFAULT_NOTION_COLLECTION_ID = "2c83c88d-5f69-81c5-93d6-000b91d99eae";
export const DEFAULT_NOTION_VIEW_ID = "2c83c88d-5f69-81c2-a200-000c87115fd9";
export const DEFAULT_NOTION_BOARD_PAGE_ID = "2c83c88d-5f69-8043-9847-c5756117cd2d";

const NOTION_API_BASE = "https://www.notion.so/api/v3";
const NOTION_TIMEOUT_MS = 8000;

const CHANNEL_TO_PAGE_ID: Record<string, string> = {
  "base hub": "basehub",
  "ai on base": "aionbase",
  robinhub: "robinhub",
  "robinhood hub": "robinhoodhub",
  "elysium hub": "elysiumhub",
};

const CLOSED_STATUSES = new Set(["posted", "cancelled"]);

export interface NotionTask {
  notion_page_id: string;
  url: string;
  title: string;
  channel: string | null;
  page_id: string | null;
  status: string | null;
  types: string[];
  priority: string | null;
  date: string | null;
  note: string | null;
  result_url: string | null;
  visual_url: string | null;
  discussion_count: number;
  last_edited_time: number | null;
}

export interface NotionComment {
  discussion_id: string;
  comment_id: string;
  resolved: boolean;
  text: string;
  created_time: number | null;
  created_by_id: string | null;
}

export interface NotionPageDetail {
  notion_page_id: string;
  url: string;
  title: string;
  blocks: Array<{ id: string; type: string; text: string }>;
  comments: NotionComment[];
}

export interface NotionHealth {
  ok: boolean;
  cookie_status: "ok" | "expired" | "unconfigured";
  error?: string;
}

interface RawRecordEntry {
  role?: string;
  value?: Record<string, unknown>;
}

function unwrapRecord(entry: unknown): Record<string, unknown> {
  if (!entry || typeof entry !== "object") return {};
  const outer = entry as RawRecordEntry;
  const val = outer.value;
  if (!val || typeof val !== "object") return {};
  if (val.value && typeof val.value === "object") {
    return val.value as Record<string, unknown>;
  }
  return val;
}

export function buildNotionCookieHeader(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ name?: unknown; value?: unknown }>;
      if (Array.isArray(parsed)) {
        const pairs = parsed
          .filter((c) => typeof c?.name === "string" && typeof c?.value === "string")
          .map((c) => `${c.name}=${c.value}`);
        return pairs.length > 0 ? pairs.join("; ") : null;
      }
    } catch {
      return null;
    }
  }
  if (trimmed.includes("=")) {
    return trimmed;
  }
  return `token_v2=${trimmed}`;
}

export function normalizeNotionId(input: string): string {
  const match = input.match(
    /([0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12})/,
  );
  const hex = (match ? match[1] : input).replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) return input.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function extractRichText(prop: unknown): string {
  if (!Array.isArray(prop)) return "";
  return prop
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("")
    .trim();
}

function extractDateProp(prop: unknown): string | null {
  if (!Array.isArray(prop)) return null;
  for (const seg of prop) {
    if (!Array.isArray(seg) || seg.length < 2 || !Array.isArray(seg[1])) continue;
    for (const dec of seg[1]) {
      if (Array.isArray(dec) && dec[0] === "d" && dec[1] && typeof dec[1] === "object") {
        const start = (dec[1] as { start_date?: unknown }).start_date;
        if (typeof start === "string" && start) return start;
      }
    }
  }
  const fallback = extractRichText(prop);
  return fallback || null;
}

function mapChannelToPageId(channel: string | null): string | null {
  if (!channel) return null;
  return CHANNEL_TO_PAGE_ID[channel.trim().toLowerCase()] ?? null;
}

async function notionPost<T>(
  path: string,
  payload: unknown,
  cookieHeader: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetchImpl(`${NOTION_API_BASE}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(NOTION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkNotionHealth(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<NotionHealth> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) {
    return { ok: false, cookie_status: "unconfigured", error: "NOTION_COOKIE not configured" };
  }
  const res = await notionPost<Record<string, unknown>>("getSpaces", {}, cookieHeader, fetchImpl);
  if (!res.ok) {
    return {
      ok: false,
      cookie_status: res.status === 401 || res.status === 403 ? "expired" : "expired",
      error: res.error,
    };
  }
  const hasSpaces = Object.keys(res.data ?? {}).length > 0;
  return hasSpaces
    ? { ok: true, cookie_status: "ok" }
    : { ok: false, cookie_status: "expired", error: "Notion getSpaces returned no user spaces" };
}

export interface ListNotionTasksOptions {
  pageId?: string;
  channel?: string;
  status?: string;
  openOnly?: boolean;
  onlyWithComments?: boolean;
  limit?: number;
}

export async function listNotionTasks(
  env: Env,
  opts: ListNotionTasksOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; tasks: NotionTask[] } | { ok: false; error: string }> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) {
    return { ok: false, error: "NOTION_COOKIE not configured" };
  }

  const spaceId = env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const collectionId = env.NOTION_COLLECTION_ID || DEFAULT_NOTION_COLLECTION_ID;
  const viewId = env.NOTION_VIEW_ID || DEFAULT_NOTION_VIEW_ID;
  const fetchLimit = Math.min(Math.max(Number(opts.limit ?? 100), 1), 200);

  const res = await notionPost<{
    result?: {
      reducerResults?: {
        collection_group_results?: { blockIds?: string[] };
      };
    };
    recordMap?: {
      block?: Record<string, unknown>;
      collection?: Record<string, unknown>;
    };
  }>(
    "queryCollection",
    {
      collection: { id: collectionId, spaceId },
      collectionView: { id: viewId, spaceId },
      query: { sort: [{ property: "last_edited_time", direction: "descending" }] },
      loader: {
        type: "reducer",
        reducers: {
          collection_group_results: {
            type: "results",
            limit: fetchLimit,
          },
        },
        searchQuery: "",
        userTimeZone: "Asia/Calcutta",
      },
    },
    cookieHeader,
    fetchImpl,
  );

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  const blockIds = res.data.result?.reducerResults?.collection_group_results?.blockIds ?? [];
  const blocks = res.data.recordMap?.block ?? {};
  const col = unwrapRecord(res.data.recordMap?.collection?.[collectionId]);
  const schema = (col.schema ?? {}) as Record<string, { name?: string; type?: string }>;

  const findPropKey = (targetName: string, fallbackKey: string): string => {
    const norm = targetName.trim().toLowerCase();
    for (const [k, v] of Object.entries(schema)) {
      if ((v?.name ?? "").trim().toLowerCase() === norm) return k;
    }
    return fallbackKey;
  };

  const kChannel = findPropKey("channel", "{XpB");
  const kStatus = findPropKey("status", ":vF}");
  const kType = findPropKey("type", "[A?a");
  const kPriority = findPropKey("priority", "HR;A");
  const kDate = findPropKey("date", "l{?I");
  const kNote = findPropKey("note", "F_pz");
  const kResult = findPropKey("result (x link)", ":_ZW");
  const kVisual = findPropKey("visual link", "I:\\;");

  const tasks: NotionTask[] = [];
  for (const bid of blockIds) {
    const b = unwrapRecord(blocks[bid]);
    if (!b?.id) continue;
    const props = (b.properties ?? {}) as Record<string, unknown>;
    const title = extractRichText(props.title);
    const channel = extractRichText(props[kChannel]) || null;
    const mappedPageId = mapChannelToPageId(channel);
    const status = extractRichText(props[kStatus]) || null;
    const rawTypes = extractRichText(props[kType]);
    const types = rawTypes
      ? rawTypes
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    const priority = extractRichText(props[kPriority]) || null;
    const date = extractDateProp(props[kDate]);
    const note = extractRichText(props[kNote]) || null;
    const resultUrl = extractRichText(props[kResult]) || null;
    const visualUrl = extractRichText(props[kVisual]) || null;
    const discussions = Array.isArray(b.discussions) ? b.discussions : [];
    const lastEdited = typeof b.last_edited_time === "number" ? b.last_edited_time : null;

    if (opts.pageId && mappedPageId !== opts.pageId) continue;
    if (opts.channel && (channel ?? "").toLowerCase() !== opts.channel.trim().toLowerCase()) {
      continue;
    }
    if (opts.status && (status ?? "").toLowerCase() !== opts.status.trim().toLowerCase()) {
      continue;
    }
    if (opts.openOnly && status && CLOSED_STATUSES.has(status.trim().toLowerCase())) {
      continue;
    }
    if (opts.onlyWithComments && discussions.length === 0) continue;

    tasks.push({
      notion_page_id: bid,
      url: `https://www.notion.so/${bid.replace(/-/g, "")}`,
      title,
      channel,
      page_id: mappedPageId,
      status,
      types,
      priority,
      date,
      note,
      result_url: resultUrl,
      visual_url: visualUrl,
      discussion_count: discussions.length,
      last_edited_time: lastEdited,
    });
  }

  return { ok: true, tasks };
}

export async function getNotionPage(
  env: Env,
  pageIdOrUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; page: NotionPageDetail } | { ok: false; error: string }> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) {
    return { ok: false, error: "NOTION_COOKIE not configured" };
  }

  const pageId = normalizeNotionId(pageIdOrUrl);
  const res = await notionPost<{
    recordMap?: {
      block?: Record<string, unknown>;
      discussion?: Record<string, unknown>;
      comment?: Record<string, unknown>;
    };
  }>(
    "loadPageChunk",
    {
      pageId,
      limit: 100,
      cursor: { stack: [] },
      chunkNumber: 0,
      verticalColumns: false,
    },
    cookieHeader,
    fetchImpl,
  );

  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  const blockMap = res.data.recordMap?.block ?? {};
  const root = unwrapRecord(blockMap[pageId]);
  const rootProps = (root.properties ?? {}) as Record<string, unknown>;
  const title = extractRichText(rootProps.title);

  const childIds = Array.isArray(root.content) ? (root.content as string[]) : [];
  const blocks: Array<{ id: string; type: string; text: string }> = [];
  for (const cid of childIds) {
    const cb = unwrapRecord(blockMap[cid]);
    const ctype = typeof cb.type === "string" ? cb.type : "unknown";
    const cprops = (cb.properties ?? {}) as Record<string, unknown>;
    const text = extractRichText(cprops.title);
    if (text) {
      blocks.push({ id: cid, type: ctype, text });
    }
  }

  const discussionMap = res.data.recordMap?.discussion ?? {};
  const commentMap = res.data.recordMap?.comment ?? {};
  const comments: NotionComment[] = [];

  const seenComments = new Set<string>();
  for (const [did, dentry] of Object.entries(discussionMap)) {
    const disc = unwrapRecord(dentry);
    const resolved = Boolean(disc.resolved);
    const commentIds = Array.isArray(disc.comments) ? (disc.comments as string[]) : [];
    for (const cid of commentIds) {
      if (seenComments.has(cid)) continue;
      const c = unwrapRecord(commentMap[cid]);
      const text = extractRichText(c.text);
      if (!text) continue;
      seenComments.add(cid);
      comments.push({
        discussion_id: did,
        comment_id: cid,
        resolved,
        text,
        created_time: typeof c.created_time === "number" ? c.created_time : null,
        created_by_id: typeof c.created_by_id === "string" ? c.created_by_id : null,
      });
    }
  }
  for (const [cid, centry] of Object.entries(commentMap)) {
    if (seenComments.has(cid)) continue;
    const c = unwrapRecord(centry);
    const text = extractRichText(c.text);
    if (!text) continue;
    const did = typeof c.parent_id === "string" ? c.parent_id : "";
    const disc = did ? unwrapRecord(discussionMap[did]) : {};
    seenComments.add(cid);
    comments.push({
      discussion_id: did,
      comment_id: cid,
      resolved: Boolean(disc.resolved),
      text,
      created_time: typeof c.created_time === "number" ? c.created_time : null,
      created_by_id: typeof c.created_by_id === "string" ? c.created_by_id : null,
    });
  }

  return {
    ok: true,
    page: {
      notion_page_id: pageId,
      url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
      title,
      blocks,
      comments,
    },
  };
}
