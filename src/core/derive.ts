import type { SignalInsert } from "../pollers/types";
import { insertSignals } from "./store";

// Spec §2.4: after each poll cycle, absence of an expected metric becomes a
// queryable signal. Dedupe on the missing metric name keeps exactly one live
// hygiene row per (entity, expected metric); when the metric appears later the
// same row is overwritten at severity 0, so "latest" stays truthful.
export async function emitHygieneSignals(
  db: D1Database,
  expected: Record<string, string[]>,
  now: number,
): Promise<void> {
  const categories = Object.keys(expected);
  if (categories.length === 0) return;

  const placeholders = categories.map((_, i) => `?${i + 1}`).join(", ");
  const entities = await db
    .prepare(`SELECT id, category FROM entities WHERE archived = 0 AND category IN (${placeholders})`)
    .bind(...categories)
    .all<{ id: string; category: string }>();

  const signals: SignalInsert[] = [];
  for (const entity of entities.results) {
    for (const metric of expected[entity.category] ?? []) {
      const present = await db
        .prepare("SELECT 1 FROM signals WHERE entity_id = ?1 AND metric = ?2 LIMIT 1")
        .bind(entity.id, metric)
        .first();
      signals.push({
        entityId: entity.id,
        metric: "hygiene.missing_metric",
        valueText: metric,
        severity: present ? 0 : 1,
        observedAt: now,
        dedupeKey: metric,
      });
    }
  }
  await insertSignals(db, "core", signals);
}
