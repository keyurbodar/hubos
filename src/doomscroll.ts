import { Data, Effect, Schedule } from "effect";
import type { Env, ProjectRecord } from "./types.ts";

interface XeffectPost {
  post_id: string;
  handle: string;
  text: string;
  url: string;
  created_at: number;
  likes?: number;
  reposts?: number;
  bookmarks?: number;
  views?: number;
}

class XeffectConfigError extends Data.TaggedError("XeffectConfigError")<{
  readonly message: string;
}> {}

class XeffectHttpError extends Data.TaggedError("XeffectHttpError")<{
  readonly status: number;
  readonly message: string;
}> {}

class XeffectRpcError extends Data.TaggedError("XeffectRpcError")<{
  readonly message: string;
}> {}

const SHIP_PATTERNS: Array<{ tag: string; points: number; pattern: RegExp }> = [
  {
    tag: "mainnet",
    points: 10,
    pattern: /\b(mainnet|live on base|live on elysium|deployed on)\b/i,
  },
  { tag: "launch", points: 8, pattern: /\b(launch(?:ed|ing)?|shipped|released|v2|v3|upgrade)\b/i },
  {
    tag: "milestone",
    points: 8,
    pattern: /\b(\$\d+[kmb]\+?|\d+[kmb]\+?\s+(users|wallets|txs|volume|tvl)|tvl|milestone)\b/i,
  },
  {
    tag: "integration",
    points: 6,
    pattern: /\b(integrat(?:ed|ion)|partner(?:ed|ship)?|listed on|listing|supports?)\b/i,
  },
  {
    tag: "funding_audit",
    points: 7,
    pattern: /\b(raised|seed round|series [a-z]|grant|audit(?:ed)?)\b/i,
  },
];

export function scoreShipText(text: string): { score: number; tags: string[] } {
  let score = 0;
  const tags: string[] = [];
  for (const rule of SHIP_PATTERNS) {
    if (rule.pattern.test(text)) {
      score += rule.points;
      tags.push(rule.tag);
    }
  }
  return { score: Math.min(25, score), tags };
}

function parseRpcBody(rawText: string): {
  result?: {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    tools?: Array<{ name: string }>;
  };
  error?: { message?: string };
} {
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as {
      result?: {
        content?: Array<{ text?: string }>;
        isError?: boolean;
        tools?: Array<{ name: string }>;
      };
      error?: { message?: string };
    };
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    const candidate = dataLines[i];
    if (candidate?.startsWith("{")) {
      return JSON.parse(candidate) as {
        result?: {
          content?: Array<{ text?: string }>;
          isError?: boolean;
          tools?: Array<{ name: string }>;
        };
        error?: { message?: string };
      };
    }
  }
  throw new XeffectRpcError({ message: "Unparseable xeffect response" });
}

function parseIntOrZero(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseXeffectTsvPosts(tsv: string): XeffectPost[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headerIdx = lines.findIndex((l) => l.startsWith("id\t@user\t"));
  if (headerIdx < 0) return [];
  const cols = lines[headerIdx]?.split("\t") ?? [];
  const colIdx = new Map(cols.map((name, i) => [name.trim(), i]));
  const posts: XeffectPost[] = [];

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.startsWith("ERR\t") || line.startsWith("#")) continue;
    const parts = line.split("\t");
    const postId = parts[colIdx.get("id") ?? 0] ?? "";
    const rawUser = parts[colIdx.get("@user") ?? 1] ?? "";
    const timeStr = parts[colIdx.get("time") ?? 2] ?? "";
    const text = (parts[colIdx.get("text") ?? 5] ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const url = parts[colIdx.get("url") ?? 15] ?? "";
    if (!postId || !rawUser || !url || url === "-") continue;
    const ms = Date.parse(timeStr);
    const createdAt = Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
    posts.push({
      post_id: postId,
      handle: rawUser.replace(/^@+/, "").toLowerCase(),
      text,
      url,
      created_at: createdAt,
      likes: parseIntOrZero(parts[colIdx.get("likes") ?? 9]),
      reposts: parseIntOrZero(parts[colIdx.get("reposts") ?? 11]),
      bookmarks: parseIntOrZero(parts[colIdx.get("bookmarks") ?? 13]),
      views: parseIntOrZero(parts[colIdx.get("views") ?? 14]),
    });
  }
  return posts;
}

function resolveXeffectFetch(env: Env, fetchImpl?: typeof fetch): typeof fetch {
  if (fetchImpl) return fetchImpl;
  if (env.XEFFECT) {
    const service = env.XEFFECT;
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      service.fetch(input, init)) as typeof fetch;
  }
  return fetch;
}

export function callXeffectEffect<T>(
  env: Env,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Effect.Effect<T, XeffectConfigError | XeffectHttpError | XeffectRpcError> {
  const url = env.XEFFECT_URL;
  const token = env.XEFFECT_TOKEN;
  if (!url || !token) {
    return Effect.fail(
      new XeffectConfigError({ message: "XEFFECT_URL or XEFFECT_TOKEN not configured" }),
    );
  }
  const doFetch = resolveXeffectFetch(env, fetchImpl);

  const requestOnce = Effect.tryPromise({
    try: async () => {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: new URL(url).host,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        const detail = errBody ? `: ${errBody.slice(0, 200)}` : "";
        throw new XeffectHttpError({
          status: res.status,
          message: `xeffect HTTP ${res.status}${detail}`,
        });
      }
      const rpc = parseRpcBody(await res.text());
      if (rpc.error) {
        throw new XeffectRpcError({ message: rpc.error.message ?? "xeffect RPC error" });
      }
      if (rpc.result?.isError) {
        throw new XeffectRpcError({
          message: rpc.result.content?.[0]?.text ?? "xeffect tool returned error",
        });
      }
      const raw = rpc.result?.content?.[0]?.text ?? "{}";
      const trimmed = raw.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed) as T;
      }
      return { raw, posts: parseXeffectTsvPosts(raw) } as T;
    },
    catch: (err) => {
      if (err instanceof XeffectHttpError || err instanceof XeffectRpcError) return err;
      return new XeffectRpcError({
        message: err instanceof Error ? err.message : "xeffect call failed",
      });
    },
  });

  // Retry once on transient 5xx responses
  return requestOnce.pipe(
    Effect.retry({
      times: 1,
      schedule: Schedule.spaced("200 millis"),
      while: (err) => err._tag === "XeffectHttpError" && err.status >= 500,
    }),
  );
}

export async function callXeffectTool<T>(
  env: Env,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const result = await Effect.runPromise(
    callXeffectEffect<T>(env, toolName, args, fetchImpl).pipe(
      Effect.map((data) => ({ ok: true as const, data })),
      Effect.catch((err) => Effect.succeed({ ok: false as const, error: err.message })),
    ),
  );
  return result;
}

export async function getDoomscrollHealth(
  env: Env,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; status?: unknown; error?: string }> {
  const res = await callXeffectTool<Record<string, unknown>>(env, "health", {}, fetchImpl);
  if (res.ok) return { ok: true, status: res.data };

  // Only fall back to tools/list when legacy xeffect has no `health` tool; never mask real health errors
  if (!res.error || !/tool\s+health\s+not\s+found|unknown\s+tool|not\s+found/i.test(res.error)) {
    return { ok: false, error: res.error };
  }
  if (!env.XEFFECT_URL || !env.XEFFECT_TOKEN) {
    return { ok: false, error: res.error };
  }
  try {
    const doFetch = resolveXeffectFetch(env, fetchImpl);
    const listRes = await doFetch(env.XEFFECT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: new URL(env.XEFFECT_URL).host,
        authorization: `Bearer ${env.XEFFECT_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!listRes.ok) {
      return { ok: false, error: res.error ?? `xeffect HTTP ${listRes.status}` };
    }
    const rpc = parseRpcBody(await listRes.text());
    const toolNames = (rpc.result?.tools ?? []).map((t) => t.name);
    if (toolNames.length > 0 && !toolNames.includes("health")) {
      return {
        ok: true,
        status: { mode: "xeffect-mcp-legacy", health_tool: "missing", tools: toolNames },
      };
    }
  } catch {
    // keep original error
  }
  return { ok: false, error: res.error };
}

export async function syncDoomscroll(
  env: Env,
  opts: { ecosystem?: string; hours?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; signals_upserted: number; projects_updated: number; error?: string }> {
  const hours = opts.hours ?? 72;

  const projectsRes = opts.ecosystem
    ? await env.DB.prepare("SELECT * FROM projects WHERE active = 1 AND ecosystem = ?")
        .bind(opts.ecosystem)
        .all<ProjectRecord>()
    : await env.DB.prepare("SELECT * FROM projects WHERE active = 1").all<ProjectRecord>();

  const projects = projectsRes.results ?? [];
  if (projects.length === 0) {
    return { ok: true, signals_upserted: 0, projects_updated: 0 };
  }

  const byHandle = new Map(projects.map((p) => [p.handle.toLowerCase(), p]));
  const handles = projects.map((p) => p.handle);

  let posts: XeffectPost[] = [];
  const syncedHandles = new Set<string>();
  const batchErrors: string[] = [];
  const postsRes = await callXeffectTool<{ posts?: XeffectPost[] }>(
    env,
    "posts",
    { accounts: handles, hours, limit: 200 },
    opts.fetchImpl,
  );
  if (postsRes.ok) {
    posts = postsRes.data?.posts ?? [];
    for (const h of handles) syncedHandles.add(h.toLowerCase());
  } else if (postsRes.error && /targets|invalid_type|required/i.test(postsRes.error)) {
    // Legacy xeffect `posts` schema: `{ targets: [{ handle, since, last }] }` (max 50 per call)
    const chunkSize = 20;
    for (let i = 0; i < handles.length; i += chunkSize) {
      const batch = handles.slice(i, i + chunkSize);
      const batchRes = await callXeffectTool<{ posts?: XeffectPost[] }>(
        env,
        "posts",
        {
          targets: batch.map((handle) => ({ handle, since: `${hours}h`, last: 5 })),
        },
        opts.fetchImpl,
      );
      if (batchRes.ok) {
        if (batchRes.data?.posts) {
          posts.push(...batchRes.data.posts);
        }
        for (const h of batch) syncedHandles.add(h.toLowerCase());
      } else {
        batchErrors.push(batchRes.error ?? "xeffect batch failed");
      }
    }
    if (syncedHandles.size === 0 && batchErrors.length > 0) {
      return { ok: false, signals_upserted: 0, projects_updated: 0, error: batchErrors.join("; ") };
    }
  } else {
    return { ok: false, signals_upserted: 0, projects_updated: 0, error: postsRes.error };
  }

  let upserted = 0;
  for (const post of posts) {
    const h = post.handle.toLowerCase();
    const project = byHandle.get(h);
    const ecosystem = project?.ecosystem ?? opts.ecosystem ?? "base";
    const { score, tags } = scoreShipText(post.text);

    await env.DB.prepare(`
      INSERT INTO signals (
        signal_id, handle, ecosystem, text, source_url, created_at,
        likes, reposts, bookmarks, views, ship_score, ship_tags_json, covered_pages_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
      ON CONFLICT(signal_id) DO UPDATE SET
        likes = MAX(signals.likes, excluded.likes),
        reposts = MAX(signals.reposts, excluded.reposts),
        bookmarks = MAX(signals.bookmarks, excluded.bookmarks),
        views = MAX(signals.views, excluded.views),
        ship_score = excluded.ship_score,
        ship_tags_json = excluded.ship_tags_json
    `)
      .bind(
        post.post_id,
        h,
        ecosystem,
        post.text,
        post.url,
        post.created_at,
        post.likes ?? 0,
        post.reposts ?? 0,
        post.bookmarks ?? 0,
        post.views ?? 0,
        score,
        JSON.stringify(tags),
      )
      .run();
    upserted += 1;
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoff30d = now - 30 * 86400;
  const cutoff7d = now - 7 * 86400;
  const cutoff72h = now - 72 * 3600;

  const recentSignalsRes = opts.ecosystem
    ? await env.DB.prepare(
        `SELECT handle, text, created_at, likes, reposts, bookmarks
         FROM signals
         WHERE ecosystem = ? AND created_at >= ?`,
      )
        .bind(opts.ecosystem, cutoff30d)
        .all<{
          handle: string;
          text: string;
          created_at: number;
          likes: number;
          reposts: number;
          bookmarks: number;
        }>()
    : await env.DB.prepare(
        `SELECT handle, text, created_at, likes, reposts, bookmarks
         FROM signals
         WHERE created_at >= ?`,
      )
        .bind(cutoff30d)
        .all<{
          handle: string;
          text: string;
          created_at: number;
          likes: number;
          reposts: number;
          bookmarks: number;
        }>();

  const statsByHandle = new Map<
    string,
    { posts30d: number; posts7d: number; engSum7d: number; crossMentions72h: number }
  >();
  for (const h of byHandle.keys()) {
    statsByHandle.set(h, { posts30d: 0, posts7d: 0, engSum7d: 0, crossMentions72h: 0 });
  }

  for (const sig of recentSignalsRes.results ?? []) {
    const h = sig.handle.toLowerCase();
    const entry = statsByHandle.get(h);
    if (entry) {
      entry.posts30d += 1;
      if (sig.created_at >= cutoff7d) {
        entry.posts7d += 1;
        entry.engSum7d += (sig.likes ?? 0) + (sig.reposts ?? 0) * 2 + (sig.bookmarks ?? 0) * 3;
      }
    }
    if (sig.created_at >= cutoff72h) {
      for (const [target, targetStats] of statsByHandle.entries()) {
        if (target !== h && new RegExp(`@${target}\\b`, "i").test(sig.text)) {
          targetStats.crossMentions72h += 1;
        }
      }
    }
  }

  let updated = 0;
  for (const p of projects) {
    const h = p.handle.toLowerCase();
    if (!syncedHandles.has(h)) continue;
    const stats = statsByHandle.get(h) ?? {
      posts30d: 0,
      posts7d: 0,
      engSum7d: 0,
      crossMentions72h: 0,
    };
    const avgEng7d = stats.posts7d > 0 ? stats.engSum7d / stats.posts7d : 0;
    await env.DB.prepare(`
      UPDATE projects
      SET posts_7d = ?, posts_30d = ?, avg_eng_7d = ?, cross_mentions_72h = ?, updated_at = ?
      WHERE handle = ?
    `)
      .bind(stats.posts7d, stats.posts30d, avgEng7d, stats.crossMentions72h, now, p.handle)
      .run();
    updated += 1;
  }

  if (batchErrors.length > 0) {
    return {
      ok: false,
      signals_upserted: upserted,
      projects_updated: updated,
      error: batchErrors.join("; "),
    };
  }
  return { ok: true, signals_upserted: upserted, projects_updated: updated };
}
