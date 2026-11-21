export interface Env {
  DB: D1Database;
  XEFFECT?: Fetcher;
  HUB_MCP_TOKEN?: string;
  XEFFECT_URL?: string;
  XEFFECT_TOKEN?: string;
  PARTNER_SHEET_CSV_URL?: string;
  NOTION_TOKEN?: string;
}

export interface PageConfig {
  page_id: string;
  name: string;
  ecosystem: string;
  x_handle: string;
  sibling_page_id: string | null;
  voice_rules: string;
  series_quota_json: string;
}

export interface ProjectRecord {
  handle: string;
  name: string;
  ecosystem: string;
  pages_json: string;
  category: string;
  tier: number;
  followers_count: number;
  posts_7d: number;
  posts_30d: number;
  avg_eng_7d: number;
  cross_mentions_72h: number;
  active: number;
  updated_at: number;
}

export interface SignalRecord {
  signal_id: string;
  handle: string;
  ecosystem: string;
  text: string;
  source_url: string;
  created_at: number;
  likes: number;
  reposts: number;
  bookmarks: number;
  views: number;
  ship_score: number;
  ship_tags_json: string;
  covered_pages_json: string;
}

export interface PickerWeights {
  momentumMax: number;
  shipMax: number;
  tierFitMax: number;
  spotlightCooldownDays: number;
  recapCooldownHours: number;
}

export interface ScoreBreakdown {
  total: number;
  momentum: number;
  ship: number;
  tier_fit: number;
  cooldown: number;
  learned: number;
  reasons: string[];
}

export interface RankedCandidate {
  handle: string;
  name: string;
  category: string;
  tier: number;
  scores: ScoreBreakdown;
  last_covered_at: number | null;
  evidence_urls: string[];
  sibling_angle_note: string | null;
}

export interface VibeIssue {
  rule: string;
  severity: "error" | "warn";
  message: string;
  line?: number;
}

export interface VibeCheckResult {
  passed: boolean;
  errors: VibeIssue[];
  warnings: VibeIssue[];
}

export interface PartnerRecord {
  partner_id: string;
  name: string;
  handle: string;
  pages_json: string;
  deliverable: string;
  due_date: string | null;
  brief_url: string | null;
  status: string;
  updated_at: number;
}
