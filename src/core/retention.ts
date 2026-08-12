// Issue #4: hourly-bucketed state metrics add ~2k rows/day; latest-per-metric
// window scans grow with every one. Once observations are older than the
// retention window, keep the newest row per (entity, metric, UTC day) and drop
// the rest. Interval metrics (spend/usage) are untouched — they're already
// daily — and fixed-dedupe rows (hygiene, budget, balance) only ever have one
// row, so the sweep is a no-op for them by construction.
const RETENTION_DAYS = 30;
const DAY = 86_400;

export async function compactSignals(db: D1Database, now: number): Promise<number> {
  const cutoff = now - RETENTION_DAYS * DAY;
  const result = await db
    .prepare(
      `DELETE FROM signals WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (
             PARTITION BY entity_id, metric, observed_at / ${DAY}
             ORDER BY observed_at DESC, id DESC
           ) AS rn
           FROM signals
           WHERE observed_at < ?1 AND period_start IS NULL
         ) WHERE rn > 1
       )`,
    )
    .bind(cutoff)
    .run();
  return result.meta.changes ?? 0;
}
