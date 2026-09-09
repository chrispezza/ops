// The only module that knows the two metric semantics (spec §2.2):
// state metrics → latest signal per (entity, metric); interval metrics → sums over period windows.
// "Latest" reads go through signal_latest (ADR-005), a pointer table kept in
// step with every write in store.ts — never a window scan over all signals.

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
      `SELECT s.* FROM signal_latest l JOIN signals s ON s.id = l.signal_id
       WHERE l.entity_id = ?1
       ORDER BY s.severity DESC, s.metric`,
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
       LEFT JOIN signal_latest l ON l.entity_id = e.id
       LEFT JOIN signals s ON s.id = l.signal_id
       WHERE e.archived = 0 AND e.kind NOT IN ('poller', 'budget')
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

export interface ArchivedEntity {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  owner: string | null;
}

// Archived entities keep their history but leave the working set; the map
// shows them in a collapsed section so "what did I retire" stays answerable.
export async function archivedEntities(db: D1Database): Promise<ArchivedEntity[]> {
  const res = await db
    .prepare(
      `SELECT id, name, kind, category, owner FROM entities
       WHERE archived = 1 AND kind NOT IN ('poller', 'budget') ORDER BY name`,
    )
    .all<ArchivedEntity>();
  return res.results;
}

// Latest signal of one metric across all entities (e.g. balance.usd per vendor).
export async function latestByMetric(db: D1Database, metric: string): Promise<Map<string, SignalRow>> {
  const res = await db
    .prepare(
      `SELECT s.* FROM signal_latest l JOIN signals s ON s.id = l.signal_id
       WHERE l.metric = ?1`,
    )
    .bind(metric)
    .all<SignalRow>();
  return new Map(res.results.map((s) => [s.entity_id, s]));
}

export interface PollerHealth {
  entityId: string;
  name: string;
  lastRun: SignalRow | null;
  lastOk: SignalRow | null;
  // Epoch of the FIRST failing run after the last success — the outage onset.
  // The banner used to show the latest attempt, so a 4-day outage read
  // "failing since 7m ago" after every hourly cron (principle 2 violation).
  failingSince: number | null;
}

// One row per poller: latest status signal + latest successful one (ux §2.6).
export async function pollerHealth(db: D1Database): Promise<PollerHealth[]> {
  // "Success" is the run summary's ok flag, not severity 0: a run that
  // succeeded with coverage notes is recorded at severity 1 (calm) and still
  // counts as fresh data — otherwise the freshness chip would age forever
  // while the poller was in fact working. Unconfigured runs are ok:false.
  const ok = (col: string) => `json_extract(${col}, '$.ok') = 1`;
  // Last ok run is a filtered latest, which the pointer table can't answer;
  // it and the onset query walk poller.status history via idx_signals_metric.
  const [entities, lastRuns, lastOks, onsets] = await Promise.all([
    db.prepare("SELECT id, name FROM entities WHERE kind = 'poller' ORDER BY id").all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT s.* FROM signal_latest l JOIN signals s ON s.id = l.signal_id
         WHERE l.metric = 'poller.status'`,
      )
      .all<SignalRow>(),
    db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY observed_at DESC, id DESC) AS rn
           FROM signals WHERE metric = 'poller.status' AND ${ok("value_text")}
         ) WHERE rn = 1`,
      )
      .all<SignalRow>(),
    db
      .prepare(
        `SELECT s.entity_id, MIN(s.observed_at) AS onset FROM signals s
         WHERE s.metric = 'poller.status' AND NOT (${ok("s.value_text")})
           AND s.observed_at > coalesce((
             SELECT MAX(ok.observed_at) FROM signals ok
             WHERE ok.metric = 'poller.status' AND ${ok("ok.value_text")} AND ok.entity_id = s.entity_id
           ), 0)
         GROUP BY s.entity_id`,
      )
      .all<{ entity_id: string; onset: number }>(),
  ]);
  const runById = new Map(lastRuns.results.map((s) => [s.entity_id, s]));
  const okById = new Map(lastOks.results.map((s) => [s.entity_id, s]));
  const onsetById = new Map(onsets.results.map((r) => [r.entity_id, r.onset]));
  return entities.results.map((e) => ({
    entityId: e.id,
    name: e.name,
    lastRun: runById.get(e.id) ?? null,
    lastOk: okById.get(e.id) ?? null,
    failingSince: onsetById.get(e.id) ?? null,
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

// Numeric state-metric history for trend sparklines: metrics with enough
// points in the window to draw a line worth reading (issue #5).
export async function trendSeries(
  db: D1Database,
  entityId: string,
  since: number,
): Promise<Map<string, { observed_at: number; value: number }[]>> {
  const res = await db
    .prepare(
      `SELECT metric, value_num AS value, observed_at FROM signals
       WHERE entity_id = ?1 AND period_start IS NULL AND value_num IS NOT NULL AND observed_at >= ?2
       ORDER BY metric, observed_at`,
    )
    .bind(entityId, since)
    .all<{ metric: string; value: number; observed_at: number }>();
  const series = new Map<string, { observed_at: number; value: number }[]>();
  for (const row of res.results) {
    const list = series.get(row.metric);
    if (list) list.push(row);
    else series.set(row.metric, [row]);
  }
  for (const [metric, points] of series) {
    if (points.length < 3) series.delete(metric); // no trend in two points
  }
  return series;
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

export interface FindingRow extends SignalRow {
  entity_name: string;
  entity_category: string | null;
  entity_archived: number;
}

// The cross-cutting audit lens (spec §4.4): latest signals across every entity
// with severity >= min, plus all audit.* and hygiene.* hits regardless of
// severity. A filter, not a domain — new audit sources appear with no changes.
export async function findings(
  db: D1Database,
  opts: { minSeverity: number; domain?: string; category?: string; sort?: string },
): Promise<FindingRow[]> {
  const conditions = ["(s.severity >= ?1 OR s.metric LIKE 'audit.%' OR (s.metric LIKE 'hygiene.%' AND s.severity > 0))"];
  const params: (string | number)[] = [opts.minSeverity];
  if (opts.domain) {
    params.push(`${opts.domain}.%`);
    conditions.push(`s.metric LIKE ?${params.length}`);
  }
  if (opts.category) {
    params.push(opts.category);
    conditions.push(`e.category = ?${params.length}`);
  }
  // Archived entities stay visible here — findings is the audit lens, and the
  // phase-3 archive decision hides them from map/triage only.
  // magnitude breaks same-severity ties: after a fresh poll everything shares
  // observed_at, and 54 vulns should sit above 2
  const orderBy =
    opts.sort === "recent"
      ? "s.observed_at DESC, s.severity DESC"
      : "s.severity DESC, s.value_num DESC, s.observed_at DESC";
  const res = await db
    .prepare(
      `SELECT s.*, e.name AS entity_name, e.category AS entity_category, e.archived AS entity_archived
       FROM signal_latest l
       JOIN signals s ON s.id = l.signal_id
       JOIN entities e ON e.id = s.entity_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ${orderBy}`,
    )
    .bind(...params)
    .all<FindingRow>();
  return res.results;
}

// Daily spend sums per entity over a window — feeds /spend rows and sparklines.
export async function spendByEntity(
  db: D1Database,
  since: number,
): Promise<Map<string, { name: string; points: { period_start: number; total: number }[] }>> {
  const res = await db
    .prepare(
      `SELECT s.entity_id, e.name, s.period_start, SUM(s.value_num) AS total
       FROM signals s JOIN entities e ON e.id = s.entity_id
       WHERE s.metric = 'spend.usd' AND s.period_start >= ?1
       GROUP BY s.entity_id, s.period_start
       ORDER BY s.entity_id, s.period_start`,
    )
    .bind(since)
    .all<{ entity_id: string; name: string; period_start: number; total: number }>();
  const map = new Map<string, { name: string; points: { period_start: number; total: number }[] }>();
  for (const row of res.results) {
    let entry = map.get(row.entity_id);
    if (!entry) {
      entry = { name: row.name, points: [] };
      map.set(row.entity_id, entry);
    }
    entry.points.push({ period_start: row.period_start, total: row.total });
  }
  return map;
}

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function putSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
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

// ---- Digest: the time lens (what changed in a window) ----------------------
// Same rows as /findings, read along the time axis instead of the severity
// axis. Signals are append-only (ADR-002) so the pre-window state of a metric
// is the newest row observed before the window start.

export interface DigestChangeRow extends SignalRow {
  entity_name: string;
  entity_kind: string;
  baseline_severity: number | null; // newest row before the window; null = no such row
}

// Insertion watermark for a window start. Signal ids are AUTOINCREMENT and
// poller.status rows are appended every run (dedupe on the run time), so the
// highest poller.status id observed before `since` sits above every pre-window
// insert. Fixed-dedupe rows (hygiene.*, balance.usd, per-tag release.age_days)
// are overwritten in place — observed_at moves, id does not — so with no
// baseline row this is the one way to tell "existed before the window, prior
// severity unknowable" (id ≤ watermark) from "genuinely new" (id > watermark).
export async function insertWatermark(db: D1Database, since: number): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(id) AS id FROM signals WHERE metric = 'poller.status' AND observed_at < ?1")
    .bind(since)
    .first<{ id: number | null }>();
  return row?.id ?? 0;
}

// Every current finding (latest severity ≥ 2) with the severity it had at the
// window start. Pollers are excluded as on /triage — Ops's own health is
// /health's story, not the portfolio's.
export async function currentFindingsWithBaseline(db: D1Database, since: number): Promise<DigestChangeRow[]> {
  const res = await db
    .prepare(
      `SELECT s.*, e.name AS entity_name, e.kind AS entity_kind,
              (SELECT b.severity FROM signals b
               WHERE b.entity_id = s.entity_id AND b.metric = s.metric AND b.observed_at < ?1
               ORDER BY b.observed_at DESC, b.id DESC LIMIT 1) AS baseline_severity
       FROM signal_latest l
       JOIN signals s ON s.id = l.signal_id
       JOIN entities e ON e.id = s.entity_id
       WHERE s.severity >= 2 AND e.archived = 0 AND e.kind != 'poller'
       ORDER BY s.severity DESC, e.name, s.metric`,
    )
    .bind(since)
    .all<DigestChangeRow>();
  return res.results;
}

export interface DigestResolvedRow extends SignalRow {
  entity_name: string;
  entity_kind: string;
  peak: number; // highest severity observed in the window
}

// Findings that were at severity ≥ 2 at some point in the window and are below
// it now. Candidates come from the window's own rows (idx_signals_severity), so
// an in-place row that was overwritten to 0 leaves no trace here — hygiene
// resolutions are not tracked, by construction.
export async function resolvedInWindow(db: D1Database, since: number): Promise<DigestResolvedRow[]> {
  const res = await db
    .prepare(
      `WITH peaked AS (
         SELECT entity_id, metric, MAX(severity) AS peak FROM signals
         WHERE severity >= 2 AND observed_at >= ?1
         GROUP BY entity_id, metric
       )
       SELECT s.*, e.name AS entity_name, e.kind AS entity_kind, p.peak
       FROM peaked p
       JOIN signal_latest l ON l.entity_id = p.entity_id AND l.metric = p.metric
       JOIN signals s ON s.id = l.signal_id
       JOIN entities e ON e.id = p.entity_id
       WHERE s.severity < 2 AND e.archived = 0 AND e.kind != 'poller'
       ORDER BY p.peak DESC, e.name, s.metric`,
    )
    .bind(since)
    .all<DigestResolvedRow>();
  return res.results;
}

export async function entitiesSince(db: D1Database, since: number): Promise<ArchivedEntity[]> {
  const res = await db
    .prepare(
      `SELECT id, name, kind, category, owner FROM entities
       WHERE first_seen_at >= ?1 AND archived = 0 AND kind NOT IN ('poller', 'budget')
       ORDER BY first_seen_at DESC, name`,
    )
    .bind(since)
    .all<ArchivedEntity>();
  return res.results;
}

// Spend in the window versus the window before it, same length.
export async function spendWindows(db: D1Database, since: number, windowSeconds: number): Promise<{ current: number; prior: number }> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN period_start >= ?1 THEN value_num ELSE 0 END) AS current,
              SUM(CASE WHEN period_start < ?1 THEN value_num ELSE 0 END) AS prior
       FROM signals WHERE metric = 'spend.usd' AND period_start >= ?2`,
    )
    .bind(since, since - windowSeconds)
    .first<{ current: number | null; prior: number | null }>();
  return { current: row?.current ?? 0, prior: row?.prior ?? 0 };
}

// Latest value of each metric summed across active entities — a current-state
// strip, not a delta.
export async function latestTotals(
  db: D1Database,
  metrics: readonly string[],
): Promise<{ metric: string; total: number; entities: number }[]> {
  if (metrics.length === 0) return [];
  const placeholders = metrics.map((_, i) => `?${i + 1}`).join(", ");
  const res = await db
    .prepare(
      `SELECT l.metric, SUM(s.value_num) AS total, COUNT(*) AS entities
       FROM signal_latest l
       JOIN signals s ON s.id = l.signal_id
       JOIN entities e ON e.id = l.entity_id
       WHERE e.archived = 0 AND l.metric IN (${placeholders})
       GROUP BY l.metric`,
    )
    .bind(...metrics)
    .all<{ metric: string; total: number; entities: number }>();
  return res.results;
}
