import type {
  PageConfig,
  PickerWeights,
  ProjectRecord,
  RankedCandidate,
  ScoreBreakdown,
  SignalRecord,
} from "./types.ts";

export const DEFAULT_WEIGHTS: PickerWeights = {
  momentumMax: 30,
  shipMax: 25,
  tierFitMax: 15,
  spotlightCooldownDays: 21,
  recapCooldownHours: 48,
};

const SHIP_PATTERNS: Array<{ tag: string; points: number; re: RegExp }> = [
  { tag: "mainnet", points: 10, re: /\b(mainnet|live on|now live|launched on)\b/i },
  { tag: "release", points: 7, re: /\b(v[2-9]|release|shipped|upgrade|sdk|api)\b/i },
  {
    tag: "milestone",
    points: 8,
    re: /(\$[0-9]+(\.[0-9]+)?[kmb]\b|\b[0-9]+(\.[0-9]+)?[kmb]\+?\s*(users|tx|transactions|tvl|volume|agents)\b)/i,
  },
  {
    tag: "integration",
    points: 6,
    re: /\b(integrat(ed|ion)|partner(ed|ship)|support(s|ing)\s+@[a-z0-9_]+)\b/i,
  },
  { tag: "audit", points: 6, re: /\b(audit(ed)?|open[- ]?source(d)?|verified contract)\b/i },
  { tag: "funding", points: 8, re: /\b(raised|seed round|series [a-c]|grant)\b/i },
];

const FILLER_PATTERN = /^(gm|gn|soon|stay tuned|who'?s ready|big things)/i;

export function classifyShipEvents(text: string): { score: number; tags: string[] } {
  const trimmed = text.trim();
  if (FILLER_PATTERN.test(trimmed) && trimmed.length < 80) {
    return { score: 0, tags: ["filler"] };
  }
  let score = 0;
  const tags: string[] = [];
  for (const p of SHIP_PATTERNS) {
    if (p.re.test(trimmed)) {
      score += p.points;
      tags.push(p.tag);
    }
  }
  return { score: Math.min(score, 25), tags };
}

export interface CandidateHistory {
  lastSpotlightAt: number | null;
  lastRecapAt: number | null;
  lastSiblingCoveredAt: number | null;
  recentPageCategories: string[];
  approvals: number;
  skips: number;
  avgOutcomeDelta: number | null;
}

export function scoreCandidate(
  project: ProjectRecord,
  signals: SignalRecord[],
  history: CandidateHistory,
  page: PageConfig,
  series: string,
  nowUnix: number,
  weights: PickerWeights = DEFAULT_WEIGHTS,
): ScoreBreakdown {
  const reasons: string[] = [];

  // 1. Momentum (0..30): 7d vs 30d delta + engagement/follower + cross-mentions
  const expected7d = Math.max(project.posts_30d / 4.28, 0.5);
  const velocityRatio = Math.min(project.posts_7d / expected7d, 3);
  const velocityPts = Math.min((velocityRatio / 3) * 10, 10);

  const engPer1k =
    project.followers_count > 0 ? (project.avg_eng_7d / project.followers_count) * 1000 : 0;
  const engPts = Math.min(engPer1k * 1.5, 10);

  const crossPts = Math.min(project.cross_mentions_72h * 2.5, 10);
  const momentum = Math.min(
    Math.round((velocityPts + engPts + crossPts) * 10) / 10,
    weights.momentumMax,
  );
  reasons.push(
    `momentum=${momentum} (7d=${project.posts_7d}, cross72h=${project.cross_mentions_72h})`,
  );

  // 2. Ship score (0..25): best verified ship signal in window
  let bestShip = 0;
  const bestTags = new Set<string>();
  for (const s of signals) {
    const computed =
      s.ship_score > 0
        ? { score: s.ship_score, tags: JSON.parse(s.ship_tags_json || "[]") as string[] }
        : classifyShipEvents(s.text);
    if (computed.score > bestShip) bestShip = computed.score;
    for (const t of computed.tags) if (t !== "filler") bestTags.add(t);
  }
  const ship = Math.min(bestShip, weights.shipMax);
  if (bestTags.size > 0) reasons.push(`ship=${ship} (${[...bestTags].join(", ")})`);

  // 3. Tier + fit + category diversity (0..15)
  let tierFit = project.tier === 1 ? 10 : project.tier === 2 ? 7 : 4;
  const pages = JSON.parse(project.pages_json || "[]") as string[];
  if (pages.includes(page.page_id) || project.ecosystem === page.ecosystem) {
    tierFit += 5;
  }
  const recentSameCat = history.recentPageCategories.filter((c) => c === project.category).length;
  if (recentSameCat >= 2) {
    tierFit = Math.max(0, tierFit - 6);
    reasons.push(`diversity_penalty=-6 (${project.category} repeated ${recentSameCat}x)`);
  }
  tierFit = Math.min(tierFit, weights.tierFitMax);

  // 4. Cooldown / freshness (-40..+15)
  let cooldown = 0;
  if (series.includes("spotlight") && history.lastSpotlightAt) {
    const daysAgo = (nowUnix - history.lastSpotlightAt) / 86400;
    if (daysAgo < weights.spotlightCooldownDays) {
      cooldown -= 40;
      reasons.push(`spotlight_cooldown=-40 (covered ${Math.round(daysAgo)}d ago)`);
    }
  }
  if (series.includes("recap") && history.lastRecapAt) {
    const hoursAgo = (nowUnix - history.lastRecapAt) / 3600;
    if (hoursAgo < weights.recapCooldownHours) {
      cooldown -= 15;
      reasons.push(`recap_cooldown=-15 (${Math.round(hoursAgo)}h ago)`);
    }
  }
  if (history.lastSiblingCoveredAt && nowUnix - history.lastSiblingCoveredAt < 24 * 3600) {
    cooldown -= 10;
    reasons.push("sibling_overlap=-10 (use a distinct angle)");
  }
  if (!history.lastSpotlightAt && momentum >= 15 && ship >= 8) {
    cooldown += 15;
    reasons.push("newcomer_bonus=+15");
  }
  cooldown = Math.max(-40, Math.min(15, cooldown));

  // 5. Learned outcome (-15..+15) from past human decisions + 7d performance vs median
  let learned = 0;
  const decisionNet = history.approvals - history.skips;
  learned += Math.max(-6, Math.min(6, decisionNet * 2));
  if (history.avgOutcomeDelta !== null) {
    learned += Math.max(-9, Math.min(9, Math.round(history.avgOutcomeDelta * 9 * 10) / 10));
  }
  learned = Math.max(-15, Math.min(15, Math.round(learned * 10) / 10));
  if (learned !== 0) reasons.push(`learned=${learned}`);

  const total = Math.round((momentum + ship + tierFit + cooldown + learned) * 10) / 10;
  return { total, momentum, ship, tier_fit: tierFit, cooldown, learned, reasons };
}

export async function rankProjectsForSeries(
  db: D1Database,
  opts: {
    pageId: string;
    series: string;
    limit?: number;
    replay?: boolean;
    weights?: PickerWeights;
  },
): Promise<{ page: PageConfig; candidates: RankedCandidate[]; pickIds: string[] }> {
  const page = await db
    .prepare("SELECT * FROM pages WHERE page_id = ?")
    .bind(opts.pageId)
    .first<PageConfig>();
  if (!page) throw new Error(`Unknown page_id: ${opts.pageId}`);

  const now = Math.floor(Date.now() / 1000);
  const projectsRes = await db
    .prepare("SELECT * FROM projects WHERE active = 1")
    .all<ProjectRecord>();
  const projects = (projectsRes.results ?? []).filter((p) => {
    const pages = JSON.parse(p.pages_json || "[]") as string[];
    return pages.includes(page.page_id) || p.ecosystem === page.ecosystem;
  });

  const recentCatsRes = await db
    .prepare(
      "SELECT category FROM selection_history WHERE page_id = ? AND decision = 'approved' ORDER BY created_at DESC LIMIT 4",
    )
    .bind(page.page_id)
    .all<{ category: string }>();
  const recentPageCategories = (recentCatsRes.results ?? []).map((r) => r.category);

  const ranked: RankedCandidate[] = [];

  for (const project of projects) {
    const sigRes = await db
      .prepare(
        "SELECT * FROM signals WHERE handle = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 10",
      )
      .bind(project.handle, now - 7 * 86400)
      .all<SignalRecord>();
    const signals = sigRes.results ?? [];

    const histRes = await db
      .prepare(
        "SELECT page_id, series, decision, outcome_delta, created_at FROM selection_history WHERE handle = ? AND decision IN ('approved', 'skipped') ORDER BY created_at DESC LIMIT 100",
      )
      .bind(project.handle)
      .all<{
        page_id: string;
        series: string;
        decision: string;
        outcome_delta: number | null;
        created_at: number;
      }>();
    const rows = histRes.results ?? [];

    let lastSpotlightAt: number | null = null;
    let lastRecapAt: number | null = null;
    let lastSiblingCoveredAt: number | null = null;
    let approvals = 0;
    let skips = 0;
    const deltas: number[] = [];

    for (const r of rows) {
      if (r.decision === "approved") {
        approvals += 1;
        if (r.series.includes("spotlight") && !lastSpotlightAt) lastSpotlightAt = r.created_at;
        if (r.series.includes("recap") && !lastRecapAt) lastRecapAt = r.created_at;
        if (page.sibling_page_id && r.page_id === page.sibling_page_id && !lastSiblingCoveredAt) {
          lastSiblingCoveredAt = r.created_at;
        }
      } else if (r.decision === "skipped") {
        skips += 1;
      }
      if (typeof r.outcome_delta === "number") deltas.push(r.outcome_delta);
    }

    const avgOutcomeDelta =
      deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;

    const scores = scoreCandidate(
      project,
      signals,
      {
        lastSpotlightAt,
        lastRecapAt,
        lastSiblingCoveredAt,
        recentPageCategories,
        approvals,
        skips,
        avgOutcomeDelta,
      },
      page,
      opts.series,
      now,
      opts.weights ?? DEFAULT_WEIGHTS,
    );

    ranked.push({
      handle: project.handle,
      name: project.name,
      category: project.category,
      tier: project.tier,
      scores,
      last_covered_at: lastSpotlightAt ?? lastRecapAt,
      evidence_urls: signals.slice(0, 3).map((s) => s.source_url),
      sibling_angle_note:
        lastSiblingCoveredAt && now - lastSiblingCoveredAt < 24 * 3600
          ? `Sibling page (${page.sibling_page_id}) covered @${project.handle} within 24h; pick a distinct angle.`
          : null,
    });
  }

  ranked.sort((a, b) => b.scores.total - a.scores.total);
  const top = ranked.slice(0, Math.min(Math.max(opts.limit ?? 5, 1), 20));
  const pickIds: string[] = [];

  if (!opts.replay && top.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO selection_history (
        pick_id, page_id, series, handle, category, total_score,
        momentum_score, ship_score, tier_fit_score, cooldown_score, learned_score,
        evidence_urls_json, decision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
    `);
    const batch = top.map((c, idx) => {
      const pickId = `pick_${now}_${crypto.randomUUID().slice(0, 8)}_${idx}_${c.handle}`;
      pickIds.push(pickId);
      return stmt.bind(
        pickId,
        page.page_id,
        opts.series,
        c.handle,
        c.category,
        c.scores.total,
        c.scores.momentum,
        c.scores.ship,
        c.scores.tier_fit,
        c.scores.cooldown,
        c.scores.learned,
        JSON.stringify(c.evidence_urls),
        now,
      );
    });
    await db.batch(batch);
  }

  return { page, candidates: top, pickIds };
}

export async function recordPickDecision(
  db: D1Database,
  opts: {
    pickId: string;
    decision: "approved" | "skipped";
    note?: string;
    postViews?: number;
    postLikes?: number;
    postBookmarks?: number;
    pageMedianViews?: number;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  let outcomeDelta: number | null = null;
  if (
    typeof opts.postViews === "number" &&
    typeof opts.pageMedianViews === "number" &&
    opts.pageMedianViews > 0
  ) {
    outcomeDelta = Math.max(
      -1,
      Math.min(1, (opts.postViews - opts.pageMedianViews) / opts.pageMedianViews),
    );
  }
  await db
    .prepare(
      `UPDATE selection_history
       SET decision = ?, decision_note = COALESCE(?, decision_note),
           post_views = COALESCE(?, post_views),
           post_likes = COALESCE(?, post_likes),
           post_bookmarks = COALESCE(?, post_bookmarks),
           outcome_delta = COALESCE(?, outcome_delta),
           decided_at = ?
       WHERE pick_id = ?`,
    )
    .bind(
      opts.decision,
      opts.note ?? null,
      opts.postViews ?? null,
      opts.postLikes ?? null,
      opts.postBookmarks ?? null,
      outcomeDelta,
      now,
      opts.pickId,
    )
    .run();
}
