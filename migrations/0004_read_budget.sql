-- D1 bills every row a query touches against a daily account-wide read
-- allowance (5M on the free tier). Two hot paths read far more than they
-- returned; this migration bounds both.

-- 1. The daily retention sweep (retention.ts) filters `observed_at < cutoff
--    AND period_start IS NULL` and had no index to range on, so it walked the
--    whole table once a day. A partial index over exactly the rows it can
--    delete keeps the walk to the pre-cutoff, state-metric rows only.
CREATE INDEX idx_signals_observed_state ON signals(observed_at) WHERE period_start IS NULL;

-- 2. /health (and the freshness chip in every page's layout) derived each
--    poller's last successful run and its outage onset by walking every
--    poller.status row and json_extract-ing the ok flag: ~10k rows per page
--    view. From now on the runner also maintains a fixed-dedupe
--    `poller.last_ok` row per poller (only ok runs touch it), so the last
--    success is a signal_latest pointer lookup and the onset scan is bounded
--    to the rows after it. Backfill the pointer from existing history once.
-- OR IGNORE: if the new runner has already written a poller's last_ok row by the
-- time this runs, that row is newer than any backfill and must win.
INSERT OR IGNORE INTO signals (entity_id, source, metric, value_num, value_text, severity, url, observed_at, period_start, period_end, dedupe_key)
SELECT entity_id, source, 'poller.last_ok', value_num, value_text, severity, url, observed_at, NULL, NULL, 'last_ok'
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY observed_at DESC, id DESC) AS rn
  FROM signals
  WHERE metric = 'poller.status' AND json_extract(value_text, '$.ok') = 1
) WHERE rn = 1;

INSERT INTO signal_latest (entity_id, metric, signal_id, observed_at)
SELECT entity_id, metric, id, observed_at FROM signals WHERE metric = 'poller.last_ok'
ON CONFLICT(entity_id, metric) DO UPDATE SET
  signal_id = excluded.signal_id,
  observed_at = excluded.observed_at;
