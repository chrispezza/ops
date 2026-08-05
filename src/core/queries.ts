// The only module that knows the two metric semantics (spec §2.2):
// state metrics → latest signal per (entity, metric); interval metrics → sums over period windows.

export interface SignalRow {
  id: number;
  entity_id: string;
  source: string;
  metric: string;
  value_num: number | null;
  value_text: string | null;
  severity: number;
  url: string | null;
  observed_at: number;
  period_start: number | null;
  period_end: number | null;
  dedupe_key: string;
}

export async function latestSignals(db: D1Database, entityId: string): Promise<SignalRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY observed_at DESC, id DESC) AS rn
         FROM signals WHERE entity_id = ?1
       ) WHERE rn = 1
       ORDER BY severity DESC, metric`,
    )
    .bind(entityId)
    .all<SignalRow>();
  return res.results;
}

export async function intervalSums(
  db: D1Database,
  entityId: string,
  metric: string,
  since: number,
): Promise<{ period_start: number; total: number }[]> {
  const res = await db
    .prepare(
      `SELECT period_start, SUM(value_num) AS total
       FROM signals
       WHERE entity_id = ?1 AND metric = ?2 AND period_start >= ?3
       GROUP BY period_start
       ORDER BY period_start`,
    )
    .bind(entityId, metric, since)
    .all<{ period_start: number; total: number }>();
  return res.results;
}
