export interface TopHook {
  post_id: string;
  hook: string;
  url: string;
  views: number;
  likes: number;
  bookmarks: number;
}

export async function getRecentHooks(db: D1Database, pageId: string, days = 14): Promise<string[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const fromMetrics = await db
    .prepare(
      "SELECT hook FROM post_metrics WHERE page_id = ? AND published_at >= ? ORDER BY published_at DESC LIMIT 30",
    )
    .bind(pageId, since)
    .all<{ hook: string }>();
  const fromDrafts = await db
    .prepare(
      "SELECT COALESCE(edited_body, body) as body FROM drafts WHERE page_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 20",
    )
    .bind(pageId, since)
    .all<{ body: string }>();

  const hooks = [
    ...(fromMetrics.results ?? []).map((r) => r.hook),
    ...(fromDrafts.results ?? []).map((r) => r.body.split(/\r?\n/)[0] ?? ""),
  ].filter(Boolean);
  return [...new Set(hooks)];
}

export async function getTopPerformingHooks(
  db: D1Database,
  pageId: string,
  days = 14,
): Promise<TopHook[]> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const res = await db
    .prepare(
      `SELECT post_id, hook, url, views, likes, bookmarks
       FROM post_metrics
       WHERE page_id = ? AND published_at >= ?
       ORDER BY (likes + bookmarks * 2) DESC
       LIMIT 5`,
    )
    .bind(pageId, since)
    .all<TopHook>();
  return res.results ?? [];
}

export async function getGoldExamples(
  db: D1Database,
  pageId: string,
  series?: string,
): Promise<Array<{ draft_id: string; series: string; body: string }>> {
  const sql = series
    ? "SELECT draft_id, series, COALESCE(edited_body, body) as body FROM drafts WHERE page_id = ? AND series = ? AND is_gold_example = 1 ORDER BY decided_at DESC LIMIT 5"
    : "SELECT draft_id, series, COALESCE(edited_body, body) as body FROM drafts WHERE page_id = ? AND is_gold_example = 1 ORDER BY decided_at DESC LIMIT 5";
  const res = series
    ? await db
        .prepare(sql)
        .bind(pageId, series)
        .all<{ draft_id: string; series: string; body: string }>()
    : await db.prepare(sql).bind(pageId).all<{ draft_id: string; series: string; body: string }>();
  return res.results ?? [];
}
