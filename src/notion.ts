import type { Env } from "./types.ts";

export const DEFAULT_NOTION_SPACE_ID = "835b528e-c5a8-4a45-896b-ff702fdbc807";
export const DEFAULT_NOTION_COLLECTION_ID = "2c83c88d-5f69-81c5-93d6-000b91d99eae";
export const DEFAULT_NOTION_VIEW_ID = "2c83c88d-5f69-81c2-a200-000c87115fd9";
export const DEFAULT_NOTION_BOARD_PAGE_ID = "2c83c88d-5f69-8043-9847-c5756117cd2d";

const NOTION_API_BASE = "https://www.notion.so/api/v3";
const NOTION_TIMEOUT_MS = 8000;

export interface NotionSchemaOption {
  id?: string;
  value: string;
  color?: string;
}

export interface NotionSchemaProperty {
  key: string;
  name: string;
  type: string;
  options?: string[];
  groups?: Array<{ name: string; options: string[] }>;
}

export interface NotionCollectionSchema {
  space_id: string;
  collection_id: string;
  name: string;
  properties: NotionSchemaProperty[];
}

export interface NotionTask {
  notion_page_id: string;
  url: string;
  title: string;
  properties: Record<string, unknown>;
  status: string | null;
  status_group: string | null;
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
  parent_id: string | null;
  parent_table: string | null;
  properties: Record<string, unknown>;
  blocks: Array<{ id: string; type: string; text: string }>;
  comments: NotionComment[];
}

export interface NotionHealth {
  ok: boolean;
  cookie_status: "ok" | "expired" | "unconfigured";
  error?: string;
}

export interface NotionBlockInput {
  type?: string;
  text?: string;
  checked?: boolean;
}

interface RawRecordEntry {
  role?: string;
  value?: Record<string, unknown>;
}

interface NotionOperation {
  pointer: { table: string; id: string; spaceId: string };
  path: string[];
  command: string;
  args: unknown;
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

function normalizeLookupName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractRichText(prop: unknown): string {
  if (!Array.isArray(prop)) return "";
  return prop
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("")
    .trim();
}

function extractDateValue(prop: unknown): string | null {
  if (!Array.isArray(prop)) return null;
  for (const seg of prop) {
    if (!Array.isArray(seg) || !Array.isArray(seg[1])) continue;
    for (const fmt of seg[1]) {
      if (Array.isArray(fmt) && fmt[0] === "d" && fmt[1] && typeof fmt[1] === "object") {
        const d = fmt[1] as { start_date?: string; end_date?: string };
        if (d.start_date) {
          return d.end_date ? `${d.start_date}..${d.end_date}` : d.start_date;
        }
      }
    }
  }
  return null;
}

function extractRelationIds(prop: unknown): string[] {
  if (!Array.isArray(prop)) return [];
  const ids: string[] = [];
  for (const seg of prop) {
    if (!Array.isArray(seg) || !Array.isArray(seg[1])) continue;
    for (const fmt of seg[1]) {
      if (Array.isArray(fmt) && fmt[0] === "p" && typeof fmt[1] === "string") {
        ids.push(fmt[1]);
      }
    }
  }
  return ids;
}

function extractPersonIds(prop: unknown): string[] {
  if (!Array.isArray(prop)) return [];
  const ids: string[] = [];
  for (const seg of prop) {
    if (!Array.isArray(seg) || !Array.isArray(seg[1])) continue;
    for (const fmt of seg[1]) {
      if (Array.isArray(fmt) && fmt[0] === "u" && typeof fmt[1] === "string") {
        ids.push(fmt[1]);
      }
    }
  }
  return ids;
}

function decodePropertyValue(propType: string, raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (propType === "date") return extractDateValue(raw);
  if (propType === "relation") return extractRelationIds(raw);
  if (propType === "person") return extractPersonIds(raw);
  if (propType === "checkbox") {
    const text = extractRichText(raw).toLowerCase();
    return text === "yes" || text === "true";
  }
  if (propType === "number") {
    const text = extractRichText(raw);
    if (!text) return null;
    const n = Number(text);
    return Number.isNaN(n) ? text : n;
  }
  if (propType === "multi_select") {
    const text = extractRichText(raw);
    return text
      ? text
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }
  const text = extractRichText(raw);
  return text || null;
}

function encodeDateProperty(startDate: string, endDate?: string): unknown[] {
  const payload: Record<string, string> = { type: "date", start_date: startDate };
  if (endDate) payload.end_date = endDate;
  return [["‣", [["d", payload]]]];
}

function encodePropertyValue(propType: string, value: unknown): unknown {
  if (value === null || value === "") return [];
  if (propType === "checkbox") {
    const truthy = value === true || value === "true" || value === "Yes" || value === "yes";
    return [[truthy ? "Yes" : "No"]];
  }
  if (propType === "date") {
    if (typeof value === "string") {
      const [start, end] = value.split("..").map((s) => s.trim());
      return start ? encodeDateProperty(start, end || undefined) : [];
    }
    if (typeof value === "object" && value !== null) {
      const obj = value as { start?: string; end?: string; start_date?: string; end_date?: string };
      const start = obj.start ?? obj.start_date;
      const end = obj.end ?? obj.end_date;
      return start ? encodeDateProperty(start, end) : [];
    }
    return [];
  }
  if (propType === "multi_select") {
    if (Array.isArray(value)) {
      const items = value.map((v) => String(v).trim()).filter(Boolean);
      return items.length > 0 ? [[items.join(",")]] : [];
    }
    const str = String(value).trim();
    return str ? [[str]] : [];
  }
  if (propType === "relation") {
    const ids = (Array.isArray(value) ? value : [value])
      .map((v) => normalizeNotionId(String(v)))
      .filter(Boolean);
    if (ids.length === 0) return [];
    const encoded: unknown[] = [];
    ids.forEach((id, idx) => {
      if (idx > 0) encoded.push([","]);
      encoded.push(["‣", [["p", id]]]);
    });
    return encoded;
  }
  if (propType === "person") {
    const ids = (Array.isArray(value) ? value : [value])
      .map((v) => normalizeNotionId(String(v)))
      .filter(Boolean);
    if (ids.length === 0) return [];
    const encoded: unknown[] = [];
    ids.forEach((id, idx) => {
      if (idx > 0) encoded.push([","]);
      encoded.push(["‣", [["u", id]]]);
    });
    return encoded;
  }
  if (propType === "url") {
    const url = String(value).trim();
    return url ? [[url, [["a", url]]]] : [];
  }
  return [[String(value)]];
}

function parseCollectionSchema(
  spaceId: string,
  collectionId: string,
  rawCollection: Record<string, unknown>,
): NotionCollectionSchema {
  const name = extractRichText(rawCollection.name) || collectionId;
  const rawSchema = (rawCollection.schema ?? {}) as Record<
    string,
    {
      name?: string;
      type?: string;
      options?: Array<{ id?: string; value?: string; color?: string }>;
      groups?: Array<{ name?: string; optionIds?: string[] }>;
    }
  >;

  const properties: NotionSchemaProperty[] = [];
  for (const [key, def] of Object.entries(rawSchema)) {
    const propName = def?.name || key;
    const propType = def?.type || "text";
    const entry: NotionSchemaProperty = {
      key,
      name: propName,
      type: propType,
    };
    if (Array.isArray(def?.options)) {
      entry.options = def.options
        .map((o) => (typeof o?.value === "string" ? o.value : ""))
        .filter(Boolean);
      if (Array.isArray(def?.groups)) {
        const idToVal = new Map<string, string>();
        for (const o of def.options) {
          if (o?.id && o?.value) idToVal.set(o.id, o.value);
        }
        entry.groups = def.groups.map((g) => ({
          name: g.name || "",
          options: (g.optionIds ?? []).map((id) => idToVal.get(id) ?? id).filter(Boolean),
        }));
      }
    }
    properties.push(entry);
  }

  return { space_id: spaceId, collection_id: collectionId, name, properties };
}

function findSchemaProperty(
  schema: NotionCollectionSchema,
  nameOrKey: string,
): NotionSchemaProperty | undefined {
  const exactKey = schema.properties.find((p) => p.key === nameOrKey);
  if (exactKey) return exactKey;
  const exactName = schema.properties.find(
    (p) => p.name.toLowerCase() === nameOrKey.trim().toLowerCase(),
  );
  if (exactName) return exactName;
  const norm = normalizeLookupName(nameOrKey);
  return schema.properties.find((p) => normalizeLookupName(p.name) === norm);
}

function findStatusGroup(schema: NotionCollectionSchema, statusVal: string | null): string | null {
  if (!statusVal) return null;
  const statusProp = schema.properties.find((p) => p.type === "status");
  if (!statusProp?.groups) return null;
  const target = statusVal.toLowerCase();
  for (const g of statusProp.groups) {
    if (g.options.some((o) => o.toLowerCase() === target)) {
      return g.name;
    }
  }
  return null;
}

async function notionPost<T>(
  path: string,
  payload: unknown,
  cookieHeader: string,
  fetchImpl: typeof fetch = fetch,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${NOTION_API_BASE}/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        "User-Agent": "Mozilla/5.0 (compatible; hubos/1.0)",
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let formatted = text.slice(0, 1200) || `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const clientData =
            parsed.clientData && typeof parsed.clientData === "object"
              ? ({ ...(parsed.clientData as Record<string, unknown>) } as Record<string, unknown>)
              : undefined;
          if (clientData && "rollbackRecordMap" in clientData) {
            delete clientData.rollbackRecordMap;
          }
          formatted = JSON.stringify({
            name: parsed.name,
            message: parsed.message,
            debugMessage: parsed.debugMessage,
            errorId: parsed.errorId,
            clientData,
          });
        }
      } catch {
        // non-JSON error body
      }
      return {
        ok: false,
        status: res.status,
        error: formatted,
      };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCollectionSchema(
  spaceId: string,
  collectionId: string,
  cookieHeader: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; schema: NotionCollectionSchema } | { ok: false; error: string }> {
  const res = await notionPost<{ recordMap?: { collection?: Record<string, unknown> } }>(
    "syncRecordValues",
    {
      requests: [{ pointer: { table: "collection", id: collectionId, spaceId }, version: -1 }],
    },
    cookieHeader,
    fetchImpl,
  );
  if (!res.ok) return { ok: false, error: res.error };
  const colMap = res.data.recordMap?.collection ?? {};
  const rawCol = unwrapRecord(colMap[collectionId] ?? Object.values(colMap)[0]);
  if (!rawCol.schema) {
    return { ok: false, error: `Collection ${collectionId} schema not found` };
  }
  return { ok: true, schema: parseCollectionSchema(spaceId, collectionId, rawCol) };
}

const notionUserIdCache = new Map<string, string>();

function extractCookieValue(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1]?.trim() || null;
}

async function fetchNotionUserId(
  cookieHeader: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const fromCookie = extractCookieValue(cookieHeader, "notion_user_id");
  if (fromCookie) return normalizeNotionId(fromCookie);
  const cached = notionUserIdCache.get(cookieHeader);
  if (cached) return cached;
  const res = await notionPost<Record<string, unknown>>("getSpaces", {}, cookieHeader, fetchImpl);
  if (!res.ok) return null;
  const keys = Object.keys(res.data);
  const userId = keys.find((k) => /^[0-9a-f-]{32,36}$/i.test(k));
  if (userId) {
    notionUserIdCache.set(cookieHeader, userId);
    return userId;
  }
  return null;
}

async function saveNotionTransactions(
  spaceId: string,
  operations: NotionOperation[],
  cookieHeader: string,
  fetchImpl: typeof fetch = fetch,
  userId?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const extraHeaders: Record<string, string> = {};
  if (spaceId) extraHeaders["x-notion-space-id"] = spaceId;
  if (userId) extraHeaders["x-notion-active-user-header"] = userId;
  const res = await notionPost<Record<string, unknown>>(
    "saveTransactionsFanout",
    {
      requestId: crypto.randomUUID(),
      transactions: [
        {
          id: crypto.randomUUID(),
          spaceId,
          debug: { userAction: "hubos" },
          operations,
        },
      ],
    },
    cookieHeader,
    fetchImpl,
    extraHeaders,
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true };
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
  const hasSpaces = Object.keys(res.data).length > 0;
  return hasSpaces
    ? { ok: true, cookie_status: "ok" }
    : { ok: false, cookie_status: "expired", error: "getSpaces returned empty payload" };
}

export async function getNotionSchema(
  env: Env,
  opts: { collectionId?: string; spaceId?: string; boardPageId?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; schema: NotionCollectionSchema } | { ok: false; error: string }> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  let spaceId = opts.spaceId
    ? normalizeNotionId(opts.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  let collectionId = opts.collectionId
    ? normalizeNotionId(opts.collectionId)
    : env.NOTION_COLLECTION_ID || DEFAULT_NOTION_COLLECTION_ID;

  if (opts.boardPageId) {
    const pageId = normalizeNotionId(opts.boardPageId);
    const chunk = await notionPost<{ recordMap?: { block?: Record<string, unknown> } }>(
      "loadPageChunk",
      { pageId, limit: 5, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
      cookieHeader,
      fetchImpl,
    );
    if (chunk.ok) {
      const blk = unwrapRecord(chunk.data.recordMap?.block?.[pageId]);
      if (typeof blk.collection_id === "string") collectionId = blk.collection_id;
      if (typeof blk.space_id === "string") spaceId = blk.space_id;
    }
  }

  return fetchCollectionSchema(spaceId, collectionId, cookieHeader, fetchImpl);
}

export async function searchNotion(
  env: Env,
  opts: { query: string; spaceId?: string; limit?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<
  | {
      ok: true;
      results: Array<{ id: string; url: string; title: string; type: string; highlight: string }>;
    }
  | { ok: false; error: string }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = opts.spaceId
    ? normalizeNotionId(opts.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);

  const res = await notionPost<{
    results?: Array<{ id: string; highlight?: { title?: string; text?: string } }>;
    recordMap?: { block?: Record<string, unknown> };
  }>(
    "search",
    {
      type: "BlocksInSpace",
      query: opts.query,
      spaceId,
      limit,
      filters: {
        isDeletedOnly: false,
        excludeTemplates: false,
        navigableBlockContentOnly: false,
        requireEditPermissions: false,
        includePublicPagesWithoutExplicitAccess: false,
        ancestors: [],
        createdBy: [],
        editedBy: [],
        lastEditedTime: {},
        createdTime: {},
      },
      sort: { field: "relevance" },
      source: "quick_find",
    },
    cookieHeader,
    fetchImpl,
  );
  if (!res.ok) return { ok: false, error: res.error };

  const blocks = res.data.recordMap?.block ?? {};
  const results = (res.data.results ?? []).map((r) => {
    const blk = unwrapRecord(blocks[r.id]);
    const props = (blk.properties ?? {}) as Record<string, unknown>;
    const title =
      extractRichText(props.title) || r.highlight?.title?.replace(/<[^>]+>/g, "") || "(untitled)";
    return {
      id: r.id,
      url: `https://www.notion.so/${r.id.replace(/-/g, "")}`,
      title,
      type: typeof blk.type === "string" ? blk.type : "block",
      highlight: (r.highlight?.text ?? "").replace(/<[^>]+>/g, ""),
    };
  });
  return { ok: true, results };
}

export async function listNotionTasks(
  env: Env,
  opts: {
    pageId?: string;
    channel?: string;
    status?: string;
    filters?: Record<string, string | string[]>;
    search?: string;
    openOnly?: boolean;
    onlyWithComments?: boolean;
    limit?: number;
    collectionId?: string;
    viewId?: string;
    spaceId?: string;
  } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; schema: NotionCollectionSchema; tasks: NotionTask[] }
  | { ok: false; error: string; tasks: NotionTask[] }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) {
    return { ok: false, error: "NOTION_COOKIE not configured", tasks: [] };
  }

  const spaceId = opts.spaceId
    ? normalizeNotionId(opts.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const collectionId = opts.collectionId
    ? normalizeNotionId(opts.collectionId)
    : env.NOTION_COLLECTION_ID || DEFAULT_NOTION_COLLECTION_ID;
  const viewId = opts.viewId
    ? normalizeNotionId(opts.viewId)
    : env.NOTION_VIEW_ID || DEFAULT_NOTION_VIEW_ID;
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const res = await notionPost<{
    result?: { reducerResults?: { collection_group_results?: { blockIds?: string[] } } };
    recordMap?: {
      block?: Record<string, unknown>;
      collection?: Record<string, unknown>;
    };
  }>(
    "queryCollection",
    {
      collection: { id: collectionId, spaceId },
      collectionView: { id: viewId, spaceId },
      loader: {
        type: "reducer",
        reducers: {
          collection_group_results: { type: "results", limit: 200 },
        },
        sort: [{ property: "last_edited_time", direction: "descending" }],
        searchQuery: "",
        userTimeZone: "Asia/Calcutta",
      },
    },
    cookieHeader,
    fetchImpl,
  );

  if (!res.ok) {
    return { ok: false, error: res.error, tasks: [] };
  }

  const colMap = res.data.recordMap?.collection ?? {};
  const rawCol = unwrapRecord(colMap[collectionId] ?? Object.values(colMap)[0]);
  let schema: NotionCollectionSchema;
  if (rawCol.schema) {
    schema = parseCollectionSchema(spaceId, collectionId, rawCol);
  } else {
    const fetched = await fetchCollectionSchema(spaceId, collectionId, cookieHeader, fetchImpl);
    schema = fetched.ok
      ? fetched.schema
      : { space_id: spaceId, collection_id: collectionId, name: collectionId, properties: [] };
  }

  const blockIds = res.data.result?.reducerResults?.collection_group_results?.blockIds ?? [];
  const blockMap = res.data.recordMap?.block ?? {};
  const statusProp = schema.properties.find((p) => p.type === "status");

  const tasks: NotionTask[] = [];
  for (const bid of blockIds) {
    const b = unwrapRecord(blockMap[bid]);
    if (!b.id || b.alive === false) continue;
    const rawProps = (b.properties ?? {}) as Record<string, unknown>;
    const title = extractRichText(rawProps.title);

    const decoded: Record<string, unknown> = {};
    for (const col of schema.properties) {
      if (col.key === "title") continue;
      decoded[col.name] = decodePropertyValue(col.type, rawProps[col.key]);
    }
    // Preserve any raw property keys not in schema so nothing is ever lost.
    const knownKeys = new Set(schema.properties.map((p) => p.key));
    for (const [k, v] of Object.entries(rawProps)) {
      if (k === "title" || knownKeys.has(k)) continue;
      decoded[k] = extractRichText(v) || null;
    }

    const status = statusProp
      ? (decodePropertyValue(statusProp.type, rawProps[statusProp.key]) as string | null)
      : null;
    const statusGroup = findStatusGroup(schema, status);
    const discussions = Array.isArray(b.discussions) ? b.discussions : [];

    tasks.push({
      notion_page_id: String(b.id),
      url: `https://www.notion.so/${String(b.id).replace(/-/g, "")}`,
      title,
      properties: decoded,
      status,
      status_group: statusGroup,
      discussion_count: discussions.length,
      last_edited_time: typeof b.last_edited_time === "number" ? b.last_edited_time : null,
    });
  }

  let filtered = tasks;

  if (opts.openOnly) {
    filtered = filtered.filter((t) => {
      if (t.status_group) {
        return t.status_group.toLowerCase() !== "complete";
      }
      return true;
    });
  }

  if (opts.status) {
    const want = opts.status.toLowerCase().trim();
    filtered = filtered.filter((t) => (t.status ?? "").toLowerCase() === want);
  }

  if (opts.channel) {
    const want = normalizeLookupName(opts.channel);
    filtered = filtered.filter((t) =>
      Object.values(t.properties).some(
        (v) => typeof v === "string" && normalizeLookupName(v).includes(want),
      ),
    );
  }

  if (opts.pageId) {
    const want = normalizeLookupName(opts.pageId);
    filtered = filtered.filter((t) =>
      Object.values(t.properties).some((v) => {
        if (typeof v !== "string") return false;
        const norm = normalizeLookupName(v);
        return norm === want || norm.includes(want) || want.includes(norm);
      }),
    );
  }

  if (opts.filters) {
    for (const [propName, expected] of Object.entries(opts.filters)) {
      const col = findSchemaProperty(schema, propName);
      const keyName = col?.name ?? propName;
      const wants = (Array.isArray(expected) ? expected : [expected]).map((s) =>
        s.toLowerCase().trim(),
      );
      filtered = filtered.filter((t) => {
        const val = t.properties[keyName];
        if (Array.isArray(val)) {
          return val.some((item) => wants.includes(String(item).toLowerCase().trim()));
        }
        return (
          val !== null && val !== undefined && wants.includes(String(val).toLowerCase().trim())
        );
      });
    }
  }

  if (opts.search) {
    const q = opts.search.toLowerCase().trim();
    filtered = filtered.filter((t) => {
      if (t.title.toLowerCase().includes(q)) return true;
      return Object.values(t.properties).some((v) =>
        Array.isArray(v)
          ? v.some((x) => String(x).toLowerCase().includes(q))
          : v !== null && v !== undefined && String(v).toLowerCase().includes(q),
      );
    });
  }

  if (opts.onlyWithComments) {
    filtered = filtered.filter((t) => t.discussion_count > 0);
  }

  return { ok: true, schema, tasks: filtered.slice(0, limit) };
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
      collection?: Record<string, unknown>;
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
  const parentId = typeof root.parent_id === "string" ? root.parent_id : null;
  const parentTable = typeof root.parent_table === "string" ? root.parent_table : null;
  const spaceId =
    typeof root.space_id === "string"
      ? root.space_id
      : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;

  // Decode page properties dynamically using its parent collection schema if available.
  const decodedProps: Record<string, unknown> = {};
  if (parentTable === "collection" && parentId) {
    const colMap = res.data.recordMap?.collection ?? {};
    const rawCol = unwrapRecord(colMap[parentId]);
    let schema: NotionCollectionSchema | null = null;
    if (rawCol.schema) {
      schema = parseCollectionSchema(spaceId, parentId, rawCol);
    } else {
      const fetched = await fetchCollectionSchema(spaceId, parentId, cookieHeader, fetchImpl);
      if (fetched.ok) schema = fetched.schema;
    }
    if (schema) {
      for (const col of schema.properties) {
        if (col.key === "title") continue;
        decodedProps[col.name] = decodePropertyValue(col.type, rootProps[col.key]);
      }
    }
  }
  if (Object.keys(decodedProps).length === 0) {
    for (const [k, v] of Object.entries(rootProps)) {
      if (k === "title") continue;
      decodedProps[k] = extractRichText(v) || null;
    }
  }

  const contentIds = Array.isArray(root.content) ? (root.content as string[]) : [];
  const blocks: Array<{ id: string; type: string; text: string }> = [];
  for (const cid of contentIds) {
    const blk = unwrapRecord(blockMap[cid]);
    if (!blk.id || blk.alive === false) continue;
    const props = (blk.properties ?? {}) as Record<string, unknown>;
    blocks.push({
      id: String(blk.id),
      type: typeof blk.type === "string" ? blk.type : "text",
      text: extractRichText(props.title),
    });
  }

  const discussionMap = res.data.recordMap?.discussion ?? {};
  const commentMap = res.data.recordMap?.comment ?? {};
  const comments: NotionComment[] = [];
  const seenCommentIds = new Set<string>();

  for (const [did, rawDisc] of Object.entries(discussionMap)) {
    const disc = unwrapRecord(rawDisc);
    const resolved = Boolean(disc.resolved);
    const commentIds = Array.isArray(disc.comments) ? (disc.comments as string[]) : [];
    for (const cid of commentIds) {
      const c = unwrapRecord(commentMap[cid]);
      if (!c.id) continue;
      seenCommentIds.add(String(c.id));
      comments.push({
        discussion_id: did,
        comment_id: String(c.id),
        resolved,
        text: extractRichText(c.text),
        created_time: typeof c.created_time === "number" ? c.created_time : null,
        created_by_id: typeof c.created_by_id === "string" ? c.created_by_id : null,
      });
    }
  }

  for (const [cid, rawComment] of Object.entries(commentMap)) {
    const c = unwrapRecord(rawComment);
    const id = typeof c.id === "string" ? c.id : cid;
    if (seenCommentIds.has(id) || c.alive === false) continue;
    const did = typeof c.parent_id === "string" ? c.parent_id : "";
    const disc = did ? unwrapRecord(discussionMap[did]) : {};
    comments.push({
      discussion_id: did,
      comment_id: id,
      resolved: Boolean(disc.resolved),
      text: extractRichText(c.text),
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
      parent_id: parentId,
      parent_table: parentTable,
      properties: decodedProps,
      blocks,
      comments,
    },
  };
}

export function markdownToNotionBlocks(markdown: string): NotionBlockInput[] {
  const blocks: NotionBlockInput[] = [];
  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: "divider", text: "" });
    } else if (trimmed.startsWith("### ")) {
      blocks.push({ type: "sub_sub_header", text: trimmed.slice(4).trim() });
    } else if (trimmed.startsWith("## ")) {
      blocks.push({ type: "sub_header", text: trimmed.slice(3).trim() });
    } else if (trimmed.startsWith("# ")) {
      blocks.push({ type: "header", text: trimmed.slice(2).trim() });
    } else if (/^-\s+\[(x|X| )\]\s+/.test(trimmed)) {
      const checked = /^-\s+\[(x|X)\]/.test(trimmed);
      blocks.push({
        type: "to_do",
        text: trimmed.replace(/^-\s+\[(x|X| )\]\s+/, ""),
        checked,
      });
    } else if (/^[-*]\s+/.test(trimmed)) {
      blocks.push({ type: "bulleted_list", text: trimmed.replace(/^[-*]\s+/, "") });
    } else if (/^\d+\.\s+/.test(trimmed)) {
      blocks.push({ type: "numbered_list", text: trimmed.replace(/^\d+\.\s+/, "") });
    } else if (trimmed.startsWith("> ")) {
      blocks.push({ type: "quote", text: trimmed.slice(2).trim() });
    } else {
      blocks.push({ type: "text", text: trimmed });
    }
  }
  return blocks;
}

function buildBlockCreateOps(
  spaceId: string,
  parentPageId: string,
  inputs: NotionBlockInput[],
  now: number,
  afterBlockId?: string,
): { ops: NotionOperation[]; blockIds: string[] } {
  const ops: NotionOperation[] = [];
  const blockIds: string[] = [];
  let cursorAfter = afterBlockId;

  for (const item of inputs) {
    const bid = crypto.randomUUID();
    const btype = item.type || "text";
    const text = item.text ?? "";
    const record: Record<string, unknown> = {
      id: bid,
      version: 1,
      type: btype,
      parent_id: parentPageId,
      parent_table: "block",
      alive: true,
      space_id: spaceId,
      created_time: now,
      last_edited_time: now,
    };
    if (btype !== "divider") {
      const props: Record<string, unknown> = { title: [[text]] };
      if (btype === "to_do" && item.checked !== undefined) {
        props.checked = [[item.checked ? "Yes" : "No"]];
      }
      record.properties = props;
    }
    ops.push({
      pointer: { table: "block", id: bid, spaceId },
      path: [],
      command: "set",
      args: record,
    });
    ops.push({
      pointer: { table: "block", id: parentPageId, spaceId },
      path: ["content"],
      command: "listAfter",
      args: cursorAfter ? { after: cursorAfter, id: bid } : { id: bid },
    });
    cursorAfter = bid;
    blockIds.push(bid);
  }
  return { ops, blockIds };
}

export interface CreateNotionTaskInput {
  title: string;
  properties?: Record<string, unknown>;
  markdown?: string;
  blocks?: NotionBlockInput[];
  collectionId?: string;
  spaceId?: string;
}

export async function createNotionTask(
  env: Env,
  input: CreateNotionTaskInput,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; notion_page_id: string; url: string; added_block_ids: string[] }
  | { ok: false; error: string }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const collectionId = input.collectionId
    ? normalizeNotionId(input.collectionId)
    : env.NOTION_COLLECTION_ID || DEFAULT_NOTION_COLLECTION_ID;

  const schemaRes = await fetchCollectionSchema(spaceId, collectionId, cookieHeader, fetchImpl);
  if (!schemaRes.ok) return schemaRes;
  const schema = schemaRes.schema;

  const now = Date.now();
  const pageId = crypto.randomUUID();
  let titleValue: unknown = [[input.title]];
  const extraProperties: Record<string, unknown> = {};

  if (input.properties) {
    for (const [propName, val] of Object.entries(input.properties)) {
      if (val === undefined) continue;
      if (propName.toLowerCase() === "title") {
        titleValue = [[String(val ?? "")]];
        continue;
      }
      const col = findSchemaProperty(schema, propName);
      if (!col) {
        const available = schema.properties.map((p) => p.name).join(", ");
        return {
          ok: false,
          error: `Unknown property "${propName}". Available columns: ${available}`,
        };
      }
      extraProperties[col.key] = encodePropertyValue(col.type, val);
    }
  }

  const blockInputs =
    input.blocks && input.blocks.length > 0
      ? input.blocks
      : input.markdown
        ? markdownToNotionBlocks(input.markdown)
        : [];
  const { ops: childOps, blockIds } = buildBlockCreateOps(spaceId, pageId, blockInputs, now);
  const pagePointer = { table: "block", id: pageId, spaceId };

  const ops: NotionOperation[] = [
    {
      pointer: pagePointer,
      path: [],
      command: "set",
      args: {
        id: pageId,
        version: 1,
        type: "page",
        parent_id: collectionId,
        parent_table: "collection",
        alive: true,
        space_id: spaceId,
        properties: { title: titleValue },
        content: [],
        created_time: now,
        last_edited_time: now,
      },
    },
    ...(Object.keys(extraProperties).length > 0
      ? [
          {
            pointer: pagePointer,
            path: ["properties"],
            command: "updateBlockPropertyValue",
            args: {
              primitiveOp: {
                command: "update",
                args: extraProperties,
              },
            },
          },
        ]
      : []),
    ...childOps,
  ];

  const userId = await fetchNotionUserId(cookieHeader, fetchImpl);
  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl, userId);
  if (!saved.ok) return saved;

  return {
    ok: true,
    notion_page_id: pageId,
    url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
    added_block_ids: blockIds,
  };
}

export interface UpdateNotionTaskInput {
  pageId: string;
  title?: string;
  properties?: Record<string, unknown>;
  collectionId?: string;
  spaceId?: string;
}

export async function updateNotionTask(
  env: Env,
  input: UpdateNotionTaskInput,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; notion_page_id: string; url: string; updated_fields: string[] }
  | { ok: false; error: string }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const pageId = normalizeNotionId(input.pageId);
  let spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  let collectionId = input.collectionId ? normalizeNotionId(input.collectionId) : "";

  // Auto-detect the page's actual space_id and parent collection_id if updating properties.
  if (input.properties && Object.keys(input.properties).length > 0 && !collectionId) {
    const syncRes = await notionPost<{ recordMap?: { block?: Record<string, unknown> } }>(
      "syncRecordValues",
      {
        requests: [{ pointer: { table: "block", id: pageId, spaceId }, version: -1 }],
      },
      cookieHeader,
      fetchImpl,
    );
    if (syncRes.ok) {
      const blk = unwrapRecord(syncRes.data.recordMap?.block?.[pageId]);
      if (typeof blk.space_id === "string") spaceId = blk.space_id;
      if (blk.parent_table === "collection" && typeof blk.parent_id === "string") {
        collectionId = blk.parent_id;
      }
    }
    if (!collectionId) {
      collectionId = env.NOTION_COLLECTION_ID || DEFAULT_NOTION_COLLECTION_ID;
    }
  }

  let schema: NotionCollectionSchema | null = null;
  if (input.properties && Object.keys(input.properties).length > 0) {
    const schemaRes = await fetchCollectionSchema(spaceId, collectionId, cookieHeader, fetchImpl);
    if (!schemaRes.ok) return schemaRes;
    schema = schemaRes.schema;
  }

  const pointer = { table: "block", id: pageId, spaceId };
  const ops: NotionOperation[] = [];
  const updatedFields: string[] = [];

  if (input.title !== undefined) {
    ops.push({
      pointer,
      path: ["properties", "title"],
      command: "set",
      args: input.title ? [[input.title]] : [],
    });
    updatedFields.push("title");
  }

  if (input.properties && schema) {
    const propUpdates: Record<string, unknown> = {};
    for (const [propName, val] of Object.entries(input.properties)) {
      if (val === undefined) continue;
      if (propName.toLowerCase() === "title") {
        ops.push({
          pointer,
          path: ["properties", "title"],
          command: "set",
          args: val ? [[String(val)]] : [],
        });
        updatedFields.push("title");
        continue;
      }
      const col = findSchemaProperty(schema, propName);
      if (!col) {
        const available = schema.properties.map((p) => p.name).join(", ");
        return {
          ok: false,
          error: `Unknown property "${propName}". Available columns: ${available}`,
        };
      }
      propUpdates[col.key] = encodePropertyValue(col.type, val);
      updatedFields.push(col.name);
    }
    if (Object.keys(propUpdates).length > 0) {
      ops.push({
        pointer,
        path: ["properties"],
        command: "updateBlockPropertyValue",
        args: {
          primitiveOp: {
            command: "update",
            args: propUpdates,
          },
        },
      });
    }
  }

  if (ops.length === 0) {
    return { ok: false, error: "No fields provided to update" };
  }

  ops.push({
    pointer,
    path: [],
    command: "update",
    args: { last_edited_time: Date.now() },
  });

  const userId = await fetchNotionUserId(cookieHeader, fetchImpl);
  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl, userId);
  if (!saved.ok) return saved;

  return {
    ok: true,
    notion_page_id: pageId,
    url: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
    updated_fields: updatedFields,
  };
}

export async function appendNotionBlocks(
  env: Env,
  input: {
    pageId: string;
    markdown?: string;
    blocks?: NotionBlockInput[];
    afterBlockId?: string;
    spaceId?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<
  { ok: true; notion_page_id: string; added_block_ids: string[] } | { ok: false; error: string }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const pageId = normalizeNotionId(input.pageId);
  const blockInputs =
    input.blocks && input.blocks.length > 0
      ? input.blocks
      : input.markdown
        ? markdownToNotionBlocks(input.markdown)
        : [];
  if (blockInputs.length === 0) {
    return { ok: false, error: "Provide markdown or non-empty blocks" };
  }

  const now = Date.now();
  const { ops, blockIds } = buildBlockCreateOps(
    spaceId,
    pageId,
    blockInputs,
    now,
    input.afterBlockId ? normalizeNotionId(input.afterBlockId) : undefined,
  );
  ops.push({
    pointer: { table: "block", id: pageId, spaceId },
    path: [],
    command: "update",
    args: { last_edited_time: now },
  });

  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl);
  if (!saved.ok) return saved;

  return { ok: true, notion_page_id: pageId, added_block_ids: blockIds };
}

export async function replaceNotionBlocks(
  env: Env,
  input: {
    pageId: string;
    markdown?: string;
    blocks?: NotionBlockInput[];
    spaceId?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<
  | {
      ok: true;
      notion_page_id: string;
      removed_block_ids: string[];
      added_block_ids: string[];
    }
  | { ok: false; error: string }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const pageId = normalizeNotionId(input.pageId);
  const existing = await getNotionPage(env, pageId, fetchImpl);
  if (!existing.ok) return existing;

  const blockInputs =
    input.blocks !== undefined
      ? input.blocks
      : input.markdown !== undefined
        ? markdownToNotionBlocks(input.markdown)
        : [];

  const now = Date.now();
  const ops: NotionOperation[] = [];
  const removedIds: string[] = [];

  for (const blk of existing.page.blocks) {
    ops.push({
      pointer: { table: "block", id: pageId, spaceId },
      path: ["content"],
      command: "listRemove",
      args: { id: blk.id },
    });
    ops.push({
      pointer: { table: "block", id: blk.id, spaceId },
      path: [],
      command: "update",
      args: { alive: false, last_edited_time: now },
    });
    removedIds.push(blk.id);
  }

  const { ops: addOps, blockIds } = buildBlockCreateOps(spaceId, pageId, blockInputs, now);
  ops.push(...addOps);
  ops.push({
    pointer: { table: "block", id: pageId, spaceId },
    path: [],
    command: "update",
    args: { last_edited_time: now },
  });

  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl);
  if (!saved.ok) return saved;

  return {
    ok: true,
    notion_page_id: pageId,
    removed_block_ids: removedIds,
    added_block_ids: blockIds,
  };
}

export async function updateNotionBlock(
  env: Env,
  input: {
    blockId: string;
    text?: string;
    type?: string;
    checked?: boolean;
    alive?: boolean;
    spaceId?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; block_id: string } | { ok: false; error: string }> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const blockId = normalizeNotionId(input.blockId);
  const pointer = { table: "block", id: blockId, spaceId };
  const ops: NotionOperation[] = [];

  if (input.text !== undefined) {
    ops.push({
      pointer,
      path: ["properties", "title"],
      command: "set",
      args: input.text ? [[input.text]] : [],
    });
  }
  if (input.checked !== undefined) {
    ops.push({
      pointer,
      path: ["properties", "checked"],
      command: "set",
      args: [[input.checked ? "Yes" : "No"]],
    });
  }
  const updates: Record<string, unknown> = {};
  if (input.type !== undefined) updates.type = input.type;
  if (input.alive !== undefined) updates.alive = input.alive;
  if (Object.keys(updates).length > 0 || ops.length > 0) {
    updates.last_edited_time = Date.now();
    ops.push({ pointer, path: [], command: "update", args: updates });
  }
  if (ops.length === 0) {
    return { ok: false, error: "Provide text, type, checked, or alive to update" };
  }

  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl);
  if (!saved.ok) return saved;
  return { ok: true, block_id: blockId };
}

export async function commentOnNotionPage(
  env: Env,
  input: {
    pageId?: string;
    discussionId?: string;
    text?: string;
    resolve?: boolean;
    spaceId?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; discussion_id: string; comment_id: string | null; resolved?: boolean }
  | { ok: false; error: string }
> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const now = Date.now();
  const ops: NotionOperation[] = [];

  if (input.resolve !== undefined && !input.text) {
    if (!input.discussionId) {
      return { ok: false, error: "discussion_id is required to resolve/reopen a discussion" };
    }
    const discId = normalizeNotionId(input.discussionId);
    ops.push({
      pointer: { table: "discussion", id: discId, spaceId },
      path: [],
      command: "update",
      args: { resolved: input.resolve },
    });
    const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl);
    if (!saved.ok) return saved;
    return { ok: true, discussion_id: discId, comment_id: null, resolved: input.resolve };
  }

  const text = (input.text ?? "").trim();
  if (!text) return { ok: false, error: "text is required to post a comment" };

  const userId = await fetchNotionUserId(cookieHeader, fetchImpl);
  const commentId = crypto.randomUUID();
  let discId: string;

  const commentArgs: Record<string, unknown> = {
    id: commentId,
    version: 1,
    parent_id: "",
    parent_table: "discussion",
    text: [[text]],
    alive: true,
    created_time: now,
    last_edited_time: now,
    space_id: spaceId,
  };
  if (userId) {
    commentArgs.created_by_table = "notion_user";
    commentArgs.created_by_id = userId;
    commentArgs.last_edited_by_table = "notion_user";
    commentArgs.last_edited_by_id = userId;
  }

  if (input.discussionId) {
    discId = normalizeNotionId(input.discussionId);
    commentArgs.parent_id = discId;
    ops.push({
      pointer: { table: "comment", id: commentId, spaceId },
      path: [],
      command: "set",
      args: commentArgs,
    });
    ops.push({
      pointer: { table: "discussion", id: discId, spaceId },
      path: ["comments"],
      command: "listAfter",
      args: { id: commentId },
    });
    if (input.resolve !== undefined) {
      ops.push({
        pointer: { table: "discussion", id: discId, spaceId },
        path: [],
        command: "update",
        args: { resolved: input.resolve },
      });
    }
  } else {
    if (!input.pageId) {
      return { ok: false, error: "page_id is required to start a new comment thread" };
    }
    const pageId = normalizeNotionId(input.pageId);
    discId = crypto.randomUUID();
    commentArgs.parent_id = discId;
    ops.push({
      pointer: { table: "comment", id: commentId, spaceId },
      path: [],
      command: "set",
      args: commentArgs,
    });
    ops.push({
      pointer: { table: "discussion", id: discId, spaceId },
      path: [],
      command: "set",
      args: {
        id: discId,
        version: 1,
        parent_id: pageId,
        parent_table: "block",
        comments: [commentId],
        resolved: Boolean(input.resolve),
        space_id: spaceId,
        type: "default",
      },
    });
    ops.push({
      pointer: { table: "block", id: pageId, spaceId },
      path: ["discussions"],
      command: "listAfter",
      args: { id: discId },
    });
    ops.push({
      pointer: { table: "block", id: pageId, spaceId },
      path: [],
      command: "update",
      args: { last_edited_time: now },
    });
  }

  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl, userId);
  if (!saved.ok) return saved;
  return { ok: true, discussion_id: discId, comment_id: commentId, resolved: input.resolve };
}

export async function archiveNotionTask(
  env: Env,
  input: { pageId: string; archive?: boolean; spaceId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; notion_page_id: string; archived: boolean } | { ok: false; error: string }> {
  const cookieHeader = buildNotionCookieHeader(env.NOTION_COOKIE);
  if (!cookieHeader) return { ok: false, error: "NOTION_COOKIE not configured" };

  const spaceId = input.spaceId
    ? normalizeNotionId(input.spaceId)
    : env.NOTION_SPACE_ID || DEFAULT_NOTION_SPACE_ID;
  const pageId = normalizeNotionId(input.pageId);
  const archive = input.archive ?? true;
  const ops: NotionOperation[] = [
    {
      pointer: { table: "block", id: pageId, spaceId },
      path: [],
      command: "update",
      args: { alive: !archive, last_edited_time: Date.now() },
    },
  ];
  const saved = await saveNotionTransactions(spaceId, ops, cookieHeader, fetchImpl);
  if (!saved.ok) return saved;
  return { ok: true, notion_page_id: pageId, archived: archive };
}
