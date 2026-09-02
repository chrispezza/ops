import type { EntityUpsert, SignalInsert } from "../pollers/types";

const ENTITY_UPSERT_SQL = `
INSERT INTO entities (id, kind, category, name, owner, source_url, metadata, archived, first_seen_at, last_seen_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, coalesce(?9, 0), ?8, ?8)
ON CONFLICT(id) DO UPDATE SET
  kind = excluded.kind,
  category = coalesce(excluded.category, entities.category),
  name = excluded.name,
  owner = coalesce(excluded.owner, entities.owner),
  source_url = coalesce(excluded.source_url, entities.source_url),
  metadata = coalesce(excluded.metadata, entities.metadata),
  archived = coalesce(?9, entities.archived),
  last_seen_at = excluded.last_seen_at`;

const SIGNAL_INSERT_SQL = `
INSERT INTO signals (entity_id, source, metric, value_num, value_text, severity, url, observed_at, period_start, period_end, dedupe_key)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT(entity_id, metric, dedupe_key) DO UPDATE SET
  source = excluded.source,
  value_num = excluded.value_num,
  value_text = excluded.value_text,
  severity = excluded.severity,
  url = excluded.url,
  observed_at = excluded.observed_at,
  period_start = excluded.period_start,
  period_end = excluded.period_end`;

// ADR-005: after the rows land, point signal_latest at the newest row per
// (entity, metric). Looking the row up by its UNIQUE key (not by id) covers
// the upsert path, where a fixed-dedupe row keeps its id but moves forward in
// observed_at. Two index seeks per signal, whatever the history length.
const LATEST_REFRESH_SQL = `
INSERT INTO signal_latest (entity_id, metric, signal_id, observed_at)
SELECT entity_id, metric, id, observed_at FROM signals
WHERE entity_id = ?1 AND metric = ?2 AND dedupe_key = ?3
ON CONFLICT(entity_id, metric) DO UPDATE SET
  signal_id = excluded.signal_id,
  observed_at = excluded.observed_at
WHERE excluded.observed_at > signal_latest.observed_at
   OR (excluded.observed_at = signal_latest.observed_at AND excluded.signal_id >= signal_latest.signal_id)
   OR excluded.signal_id = signal_latest.signal_id`;

export async function upsertEntities(db: D1Database, entities: EntityUpsert[], now: number): Promise<void> {
  if (entities.length === 0) return;
  const stmt = db.prepare(ENTITY_UPSERT_SQL);
  await db.batch(
    entities.map((e) =>
      stmt.bind(
        e.id,
        e.kind,
        e.category ?? null,
        e.name,
        e.owner ?? null,
        e.sourceUrl ?? null,
        e.metadata ? JSON.stringify(e.metadata) : null,
        now,
        // null = leave archived as-is on update (protects the manual toggle)
        e.archived ? 1 : null,
      ),
    ),
  );
}

export async function insertSignals(db: D1Database, source: string, signals: SignalInsert[]): Promise<void> {
  if (signals.length === 0) return;
  for (const s of signals) {
    // Empty dedupe keys would defeat the UNIQUE constraint's idempotency guarantee.
    if (!s.dedupeKey) throw new Error(`signal ${s.entityId}/${s.metric}: dedupeKey is required`);
  }
  const stmt = db.prepare(SIGNAL_INSERT_SQL);
  const refresh = db.prepare(LATEST_REFRESH_SQL);
  // One batch = one transaction: rows and their latest pointers land together.
  await db.batch([
    ...signals.map((s) =>
      stmt.bind(
        s.entityId,
        source,
        s.metric,
        s.valueNum ?? null,
        s.valueText ?? null,
        s.severity ?? 0,
        s.url ?? null,
        s.observedAt,
        s.period?.start ?? null,
        s.period?.end ?? null,
        s.dedupeKey,
      ),
    ),
    ...signals.map((s) => refresh.bind(s.entityId, s.metric, s.dedupeKey)),
  ]);
}
