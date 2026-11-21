import type { PartnerRecord } from "./types.ts";

/**
 * Isolated partner tracker. Partner briefs never mix into organic signals.
 */
export async function listActivePartners(
  db: D1Database,
  pageId?: string,
): Promise<PartnerRecord[]> {
  const res = await db
    .prepare("SELECT * FROM partners WHERE status = 'active' ORDER BY due_date ASC, name ASC")
    .all<PartnerRecord>();
  const rows = res.results ?? [];
  if (!pageId) return rows;
  return rows.filter((p) => {
    const pages = JSON.parse(p.pages_json || "[]") as string[];
    return pages.includes(pageId);
  });
}

export async function upsertPartner(
  db: D1Database,
  partner: {
    partner_id: string;
    name: string;
    handle: string;
    pages: string[];
    deliverable: string;
    due_date?: string | null;
    brief_url?: string | null;
    status?: string;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(`
      INSERT INTO partners (partner_id, name, handle, pages_json, deliverable, due_date, brief_url, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(partner_id) DO UPDATE SET
        name = excluded.name,
        handle = excluded.handle,
        pages_json = excluded.pages_json,
        deliverable = excluded.deliverable,
        due_date = excluded.due_date,
        brief_url = excluded.brief_url,
        status = excluded.status,
        updated_at = excluded.updated_at
    `)
    .bind(
      partner.partner_id,
      partner.name,
      partner.handle.replace(/^@+/, "").toLowerCase(),
      JSON.stringify(partner.pages),
      partner.deliverable,
      partner.due_date ?? null,
      partner.brief_url ?? null,
      partner.status ?? "active",
      now,
    )
    .run();
}
