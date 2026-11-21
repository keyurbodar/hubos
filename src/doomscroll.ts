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

export function callXeffectEffect<T>(
  env: Env,
  toolName: string,
  args: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Effect.Effect<T, XeffectConfigError | XeffectHttpError | XeffectRpcError> {
  const url = env.XEFFECT_URL;
  const token = env.XEFFECT_TOKEN;
  if (!url || !token) {
    return Effect.fail(
      new XeffectConfigError({ message: "XEFFECT_URL or XEFFECT_TOKEN not configured" }),
    );
  }

  const requestOnce = Effect.tryPromise({
    try: async () => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new XeffectHttpError({ status: res.status, message: `xeffect HTTP ${res.status}` });
      }
      const rpc = (await res.json()) as {
        result?: { content?: Array<{ text?: string }>; isError?: boolean };
        error?: { message?: string };
      };
      if (rpc.error) {
        throw new XeffectRpcError({ message: rpc.error.message ?? "xeffect RPC error" });
      }
      if (rpc.result?.isError) {
        throw new XeffectRpcError({
          message: rpc.result.content?.[0]?.text ?? "xeffect tool returned error",
        });
      }
      const raw = rpc.result?.content?.[0]?.text ?? "{}";
      return JSON.parse(raw) as T;
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
  fetchImpl: typeof fetch = fetch,
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
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: unknown; error?: string }> {
  const res = await callXeffectTool<Record<string, unknown>>(env, "health", {}, fetchImpl);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, status: res.data };
}

export async function syncDoomscroll(
  env: Env,
  opts: { ecosystem?: string; hours?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: boolean; signals_upserted: number; projects_updated: number; error?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
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

  const postsRes = await callXeffectTool<{ posts?: XeffectPost[] }>(
    env,
    "posts",
    { accounts: handles, hours, limit: 200 },
    fetchImpl,
  );
  if (!postsRes.ok) {
    return { ok: false, signals_upserted: 0, projects_updated: 0, error: postsRes.error };
  }

  const posts = postsRes.data?.posts ?? [];
  const mentionCounts = new Map<string, number>();
  const engTotals = new Map<string, { sum: number; count: number }>();

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

    const eng = (post.likes ?? 0) + (post.reposts ?? 0) * 2 + (post.bookmarks ?? 0) * 3;
    const prev = engTotals.get(h) ?? { sum: 0, count: 0 };
    prev.sum += eng;
    prev.count += 1;
    engTotals.set(h, prev);

    for (const target of byHandle.keys()) {
      if (target !== h && new RegExp(`@${target}\\b`, "i").test(post.text)) {
        mentionCounts.set(target, (mentionCounts.get(target) ?? 0) + 1);
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  let updated = 0;
  for (const [handle, stats] of engTotals.entries()) {
    const avgEng = stats.count > 0 ? stats.sum / stats.count : 0;
    const crossMentions = mentionCounts.get(handle) ?? 0;
    await env.DB.prepare(`
      UPDATE projects
      SET posts_7d = ?, avg_eng_7d = ?, cross_mentions_72h = ?, updated_at = ?
      WHERE handle = ?
    `)
      .bind(stats.count, avgEng, crossMentions, now, handle)
      .run();
    updated += 1;
  }

  return { ok: true, signals_upserted: upserted, projects_updated: updated };
}
