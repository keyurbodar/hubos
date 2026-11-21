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

function extractXHandle(cell: string | undefined): string | null {
  if (!cell) return null;
  const match = cell.trim().match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)/i);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function pagesForSection(section: string): string[] {
  const s = section.trim().toLowerCase();
  if (s === "base") return ["basehub", "aionbase"];
  if (s === "robinhood") return ["robinhub", "robinhoodhub"];
  if (s === "elysium") return ["elysiumhub"];
  return [];
}

async function syncCsvPartnerRow(
  db: D1Database,
  partner: {
    partner_id: string;
    name: string;
    handle: string;
    pages: string[];
    deliverable: string;
    brief_url: string | null;
    status: string;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(`
      INSERT INTO partners (partner_id, name, handle, pages_json, deliverable, due_date, brief_url, status, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(partner_id) DO UPDATE SET
        pages_json = excluded.pages_json,
        status = excluded.status,
        brief_url = COALESCE(partners.brief_url, excluded.brief_url),
        updated_at = excluded.updated_at
    `)
    .bind(
      partner.partner_id,
      partner.name,
      partner.handle.replace(/^@+/, "").toLowerCase(),
      JSON.stringify(partner.pages),
      partner.deliverable,
      partner.brief_url,
      partner.status,
      now,
    )
    .run();
}

/**
 * Parse and sync the Hub partner sheet CSV (sections: Base, Robinhood, Elysium).
 */
export async function syncPartnersFromCsv(
  db: D1Database,
  csvUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; synced: number; error?: string }> {
  try {
    const res = await fetchImpl(csvUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      return { ok: false, synced: 0, error: `Partner CSV HTTP ${res.status}` };
    }
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    let currentSection = "";
    let synced = 0;

    for (const line of lines) {
      const cols = line.split(",").map((c) => c.trim());
      if (cols[0]) {
        currentSection = cols[0];
      }
      const pages = pagesForSection(currentSection);
      if (pages.length === 0) continue;

      const freq = cols[1] || "MEDIUM";
      const activeHandle = extractXHandle(cols[2]);
      const expiredHandle = extractXHandle(cols[3]);
      const blacklistHandle = extractXHandle(cols[4]);

      if (activeHandle) {
        await syncCsvPartnerRow(db, {
          partner_id: `${currentSection.toLowerCase()}_${activeHandle}`,
          name: activeHandle,
          handle: activeHandle,
          pages,
          deliverable: `Partner coverage (${freq})`,
          brief_url: cols[2]?.trim() || null,
          status: "active",
        });
        synced += 1;
      }
      if (expiredHandle) {
        await syncCsvPartnerRow(db, {
          partner_id: `${currentSection.toLowerCase()}_${expiredHandle}`,
          name: expiredHandle,
          handle: expiredHandle,
          pages,
          deliverable: "Expired partner",
          brief_url: cols[3]?.trim() || null,
          status: "expired",
        });
        synced += 1;
      }
      if (blacklistHandle) {
        await syncCsvPartnerRow(db, {
          partner_id: `${currentSection.toLowerCase()}_${blacklistHandle}`,
          name: blacklistHandle,
          handle: blacklistHandle,
          pages,
          deliverable: "Blacklisted",
          brief_url: cols[4]?.trim() || null,
          status: "blacklist",
        });
        synced += 1;
      }
    }

    return { ok: true, synced };
  } catch (err) {
    return { ok: false, synced: 0, error: String(err) };
  }
}
