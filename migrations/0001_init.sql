-- hubos D1 schema: 5 pages, picker with learning history, vibe-check, partners, metrics

CREATE TABLE IF NOT EXISTS pages (
  page_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  x_handle TEXT NOT NULL,
  sibling_page_id TEXT,
  voice_rules TEXT NOT NULL,
  series_quota_json TEXT NOT NULL
);

INSERT OR IGNORE INTO pages (page_id, name, ecosystem, x_handle, sibling_page_id, voice_rules, series_quota_json) VALUES
  ('basehub', 'BaseHub', 'base', 'BaseHub_', 'aionbase', 'Factual Base ecosystem updates. Lead with the shipped product, user impact, or verified metric.', '{"daily-recap":1,"spotlight":1,"weekly-recap":1,"tier-list":1}'),
  ('aionbase', 'AIonBase', 'base-ai', 'AIonBase_', 'basehub', 'AI agents, inference, and onchain automation on Base. Focus on what the agent or model does.', '{"daily-recap":1,"spotlight":1,"weekly-recap":1}'),
  ('robinhub', 'RobinHub', 'robinhood', 'RobinHub_', 'robinhoodhub', 'Builder and community angle on Robinhood Chain and tokenized assets.', '{"daily-recap":1,"spotlight":1,"weekly-recap":1}'),
  ('robinhoodhub', 'Robinhood Hub', 'robinhood', 'RobinhoodHub_', 'robinhub', 'Institutional, market, and product milestones across Robinhood Chain and ecosystem.', '{"daily-recap":1,"spotlight":1,"tier-list":1}'),
  ('elysiumhub', 'Elysium Hub', 'elysium', 'ElysiumHub_', NULL, 'Clean, concise Elysium ecosystem coverage. Do not repeat Elysium on every bullet.', '{"daily-recap":1,"spotlight":1,"weekly-recap":1}');

CREATE TABLE IF NOT EXISTS projects (
  handle TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  pages_json TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'infra',
  tier INTEGER NOT NULL DEFAULT 2,
  followers_count INTEGER NOT NULL DEFAULT 0,
  posts_7d INTEGER NOT NULL DEFAULT 0,
  posts_30d INTEGER NOT NULL DEFAULT 0,
  avg_eng_7d REAL NOT NULL DEFAULT 0,
  cross_mentions_72h INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  signal_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  ecosystem TEXT NOT NULL,
  text TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  ship_score INTEGER NOT NULL DEFAULT 0,
  ship_tags_json TEXT NOT NULL DEFAULT '[]',
  covered_pages_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_signals_eco_created ON signals(ecosystem, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_handle_created ON signals(handle, created_at DESC);

CREATE TABLE IF NOT EXISTS selection_history (
  pick_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  series TEXT NOT NULL,
  handle TEXT NOT NULL,
  category TEXT NOT NULL,
  total_score REAL NOT NULL,
  momentum_score REAL NOT NULL,
  ship_score REAL NOT NULL,
  tier_fit_score REAL NOT NULL,
  cooldown_score REAL NOT NULL,
  learned_score REAL NOT NULL,
  evidence_urls_json TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT 'proposed',
  decision_note TEXT,
  post_views INTEGER,
  post_likes INTEGER,
  post_bookmarks INTEGER,
  outcome_delta REAL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_selection_page_handle ON selection_history(page_id, handle, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_selection_handle ON selection_history(handle, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  series TEXT NOT NULL,
  target_handle TEXT,
  body TEXT NOT NULL,
  edited_body TEXT,
  source_urls_json TEXT NOT NULL,
  vibe_passed INTEGER NOT NULL DEFAULT 0,
  vibe_issues_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  is_gold_example INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drafts_page_status ON drafts(page_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS partners (
  partner_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL,
  pages_json TEXT NOT NULL,
  deliverable TEXT NOT NULL,
  due_date TEXT,
  brief_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_metrics (
  post_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  series TEXT,
  target_handle TEXT,
  hook TEXT NOT NULL,
  url TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  reposts INTEGER NOT NULL DEFAULT 0,
  bookmarks INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL,
  collected_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metrics_page_pub ON post_metrics(page_id, published_at DESC);
