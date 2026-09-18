-- signal_latest.signal_id REFERENCES signals(id) ON DELETE CASCADE (0003), and
-- D1 enforces foreign keys. SQLite does not index the child side of a foreign
-- key on its own, so every DELETE of a signals row scanned all of signal_latest
-- looking for pointers to cascade: the daily retention sweep (retention.ts)
-- deletes ~10k rows against ~450 pointers, ~4.5M rows read in one statement at
-- 10:00 UTC — the whole free-tier daily allowance, every day from 2026-09-12.
-- 0004's observed_at index bounded the sweep's SELECT side; this bounds its
-- DELETE side. With the index the child lookup is one seek per deleted row.
CREATE INDEX idx_signal_latest_signal ON signal_latest(signal_id);
