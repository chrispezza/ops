-- Ops schema — spec §2.1
-- Signals are append-only observations; current state is derived by query, never mutated.

CREATE TABLE entities (
  id            TEXT PRIMARY KEY,           -- "{kind}:{natural_key}"
  kind          TEXT NOT NULL,              -- repo | plugin | skill | vendor_api | api_key | poller | ...
  category      TEXT,                       -- presentation bucket: static_site | web_app | plugin_skill | ...
  name          TEXT NOT NULL,
  owner         TEXT,
  source_url    TEXT,                       -- canonical deep link
  metadata      TEXT,                       -- JSON blob, poller-specific
  first_seen_at INTEGER NOT NULL,           -- unix epoch seconds
  last_seen_at  INTEGER NOT NULL,           -- bumped on every poll observation
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_entities_kind ON entities(kind, archived);

CREATE TABLE signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  source       TEXT NOT NULL,               -- poller id or "core" for derived signals
  metric       TEXT NOT NULL,               -- namespaced: "<domain>.<name>"
  value_num    REAL,
  value_text   TEXT,
  severity     INTEGER NOT NULL DEFAULT 0,  -- 0 info · 1 low · 2 medium · 3 high · 4 critical
  url          TEXT,                        -- deep link to the specific finding
  observed_at  INTEGER NOT NULL,            -- when the condition was true (not when polled)
  period_start INTEGER,                     -- interval metrics only
  period_end   INTEGER,
  dedupe_key   TEXT NOT NULL,               -- source-defined idempotency key (spec §2.3)
  UNIQUE(entity_id, metric, dedupe_key)
);
CREATE INDEX idx_signals_entity ON signals(entity_id, metric, observed_at DESC);
CREATE INDEX idx_signals_severity ON signals(severity, observed_at DESC);

CREATE TABLE budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL,               -- entity id, kind, or "*"
  metric       TEXT NOT NULL,               -- "spend.usd"
  period       TEXT NOT NULL,               -- "month" | "day"
  soft_limit   REAL NOT NULL,               -- crossing => severity 2 signal
  hard_limit   REAL NOT NULL                -- crossing => severity 4 signal
);
