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

export interface EntityView {
  id: string;
  kind: string;
  category: string | null;
  name: string;
  owner: string | null;
  source_url: string | null;
  last_seen_at: number;
  latest: Record<string, SignalRow>;
  maxSeverity: number;
}

// Every non-poller entity with its latest signal per metric — the map query.
export async function entitiesWithLatest(db: D1Database): Promise<EntityView[]> {
  const res = await db
    .prepare(
      `SELECT e.id, e.kind, e.category, e.name, e.owner, e.source_url, e.last_seen_at,
              s.id AS sig_id, s.source, s.metric, s.value_num, s.value_text, s.severity,
              s.url, s.observed_at, s.period_start, s.period_end, s.dedupe_key
       FROM entities e
       LEFT JOIN (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id, metric ORDER BY observed_at DESC, id DESC) AS rn
         FROM signals
       ) s ON s.entity_id = e.id AND s.rn = 1
       WHERE e.archived = 0 AND e.kind != 'poller'
       ORDER BY e.name`,
    )
    .all<Record<string, unknown>>();

  const byId = new Map<string, EntityView>();
  for (const row of res.results) {
    const id = row.id as string;
    let view = byId.get(id);
    if (!view) {
      view = {
        id,
        kind: row.kind as string,
        category: row.category as string | null,
        name: row.name as string,
        owner: row.owner as string | null,
        source_url: row.source_url as string | null,
        last_seen_at: row.last_seen_at as number,
        latest: {},
        maxSeverity: 0,
      };
      byId.set(id, view);
    }
    if (row.metric != null) {
      const sig: SignalRow = {
        id: row.sig_id as number,
        entity_id: id,
        source: row.source as string,
        metric: row.metric as string,
        value_num: row.value_num as number | null,
        value_text: row.value_text as string | null,
        severity: row.severity as number,
        url: row.url as string | null,
        observed_at: row.observed_at as number,
        period_start: row.period_start as number | null,
        period_end: row.period_end as number | null,
        dedupe_key: row.dedupe_key as string,
      };
      view.latest[sig.metric] = sig;
      if (sig.severity > view.maxSeverity) view.maxSeverity = sig.severity;
    }
  }
  return [...byId.values()];
}

export interface PollerHealth {
  entityId: string;
  name: string;
  lastRun: SignalRow | null;
  lastOk: SignalRow | null;
}

// One row per poller: latest status signal + latest successful one (ux §2.6).
export async function pollerHealth(db: D1Database): Promise<PollerHealth[]> {
  const latest = (filter: string) => `
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY observed_at DESC, id DESC) AS rn
      FROM signals WHERE metric = 'poller.status' ${filter}
    ) WHERE rn = 1`;
  const [entities, lastRuns, lastOks] = await Promise.all([
    db.prepare("SELECT id, name FROM entities WHERE kind = 'poller' ORDER BY id").all<{ id: string; name: string }>(),
    db.prepare(latest("")).all<SignalRow>(),
    db.prepare(latest("AND severity = 0")).all<SignalRow>(),
  ]);
  const runById = new Map(lastRuns.results.map((s) => [s.entity_id, s]));
  const okById = new Map(lastOks.results.map((s) => [s.entity_id, s]));
  return entities.results.map((e) => ({
    entityId: e.id,
    name: e.name,
    lastRun: runById.get(e.id) ?? null,
    lastOk: okById.get(e.id) ?? null,
  }));
}

export interface EntityRow {
  id: string;
  kind: string;
  category: string | null;
  name: string;
  owner: string | null;
  source_url: string | null;
  metadata: string | null;
  first_seen_at: number;
  last_seen_at: number;
  archived: number;
}

export async function getEntity(db: D1Database, id: string): Promise<EntityRow | null> {
  return db.prepare("SELECT * FROM entities WHERE id = ?1").bind(id).first<EntityRow>();
}

export async function signalHistory(
  db: D1Database,
  entityId: string,
  limit: number,
  offset: number,
): Promise<SignalRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM signals WHERE entity_id = ?1
       ORDER BY observed_at DESC, id DESC LIMIT ?2 OFFSET ?3`,
    )
    .bind(entityId, limit, offset)
    .all<SignalRow>();
  return res.results;
}

// 30d usage sums for every entity — feeds the zero-usage triage bonus.
export async function usageSums(db: D1Database, metric: string, since: number): Promise<Map<string, number>> {
  const res = await db
    .prepare(
      `SELECT entity_id, SUM(value_num) AS total FROM signals
       WHERE metric = ?1 AND period_start >= ?2 GROUP BY entity_id`,
    )
    .bind(metric, since)
    .all<{ entity_id: string; total: number }>();
  return new Map(res.results.map((r) => [r.entity_id, r.total]));
}

export async function setArchived(db: D1Database, id: string, archived: boolean): Promise<void> {
  await db.prepare("UPDATE entities SET archived = ?2 WHERE id = ?1").bind(id, archived ? 1 : 0).run();
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
