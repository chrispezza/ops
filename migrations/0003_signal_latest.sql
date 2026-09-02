-- Issue #42 / ADR-005: materialized "latest signal per (entity, metric)" pointer.
-- Every current-state read used ROW_NUMBER() OVER (PARTITION BY entity_id, metric …)
-- across the whole signals table (~200k rows read per request; 40M/day on
-- 2026-09-02, which tripped D1's account-wide free-tier cap). Signals stay the
-- append-only truth (ADR-002); this table is an index over them, maintained in
-- the same batch as every signal write (src/core/store.ts) and backfilled once here.
CREATE TABLE signal_latest (
  entity_id   TEXT    NOT NULL,
  metric      TEXT    NOT NULL,
  signal_id   INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (entity_id, metric)
);
CREATE INDEX idx_signal_latest_metric ON signal_latest(metric, entity_id);

-- Poller health still reads raw poller.status history (last ok run, outage
-- onset); a metric-leading index confines those reads to that metric's rows.
CREATE INDEX idx_signals_metric ON signals(metric, entity_id, observed_at DESC);

-- One last full scan: seed the pointer from the window query it replaces.
INSERT INTO signal_latest (entity_id, metric, signal_id, observed_at)
SELECT entity_id, metric, id, observed_at FROM (
  SELECT id, entity_id, metric, observed_at,
         ROW_NUMBER() OVER (PARTITION BY entity_id, metric ORDER BY observed_at DESC, id DESC) AS rn
  FROM signals
) WHERE rn = 1;
