-- Ops-owned settings (triage weight overrides). Budgets already have their table.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL  -- JSON
);
