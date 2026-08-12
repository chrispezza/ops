import type { SignalInsert } from "../pollers/types";
import { getSetting } from "./queries";
import { insertSignals, upsertEntities } from "./store";

const DAY = 86_400;

export interface BudgetRow {
  id: number;
  scope: string; // entity id, kind, or "*"
  metric: string;
  period: string; // "month" | "day"
  soft_limit: number;
  hard_limit: number;
}

function periodStart(period: string, now: number): number {
  if (period === "day") return now - (now % DAY);
  const d = new Date(now * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

// Spec §3: after spend pollers run, core evaluates budgets and emits
// threshold-crossing signals (sev 2 soft / 4 hard) attributed to the scope.
// One signal per budget per period (dedupe on period start), overwritten each
// cycle so it always reflects the current spent-vs-limit state.
// Period-correct spend for a budget's scope — the single source both the
// evaluator and the /spend budget bars use, so the bar never approximates.
export async function budgetSpent(db: D1Database, b: BudgetRow, now: number): Promise<number> {
  const since = periodStart(b.period, now);
  if (b.scope === "*") {
    const row = await db
      .prepare("SELECT SUM(value_num) AS total FROM signals WHERE metric = ?1 AND period_start >= ?2")
      .bind(b.metric, since)
      .first<{ total: number | null }>();
    return row?.total ?? 0;
  }
  if (b.scope.includes(":")) {
    const row = await db
      .prepare(
        "SELECT SUM(value_num) AS total FROM signals WHERE metric = ?1 AND period_start >= ?2 AND entity_id = ?3",
      )
      .bind(b.metric, since, b.scope)
      .first<{ total: number | null }>();
    return row?.total ?? 0;
  }
  const row = await db
    .prepare(
      `SELECT SUM(s.value_num) AS total FROM signals s
       JOIN entities e ON e.id = s.entity_id
       WHERE s.metric = ?1 AND s.period_start >= ?2 AND e.kind = ?3`,
    )
    .bind(b.metric, since, b.scope)
    .first<{ total: number | null }>();
  return row?.total ?? 0;
}

export async function evaluateBudgets(db: D1Database, now: number): Promise<void> {
  const budgets = (await db.prepare("SELECT * FROM budgets").all<BudgetRow>()).results;
  const signals: SignalInsert[] = [];

  for (const b of budgets) {
    const since = periodStart(b.period, now);
    const spent = await budgetSpent(db, b, now);

    const severity = spent >= b.hard_limit ? 4 : spent >= b.soft_limit ? 2 : 0;
    let entityId = b.scope;
    if (!b.scope.includes(":")) {
      entityId = `budget:${b.scope}`;
      await upsertEntities(db, [{ id: entityId, kind: "budget", name: `budget ${b.scope}` }], now);
    }
    signals.push({
      entityId,
      metric: "budget.status",
      valueNum: spent,
      valueText: `$${spent.toFixed(2)} of $${b.soft_limit}/$${b.hard_limit} (${b.period})`,
      severity,
      url: "/spend",
      observedAt: now,
      dedupeKey: `${b.id}:${since}`,
    });
  }
  await insertSignals(db, "core", signals);
}

// Prepaid balances — no vendor exposes a balance API (Anthropic, OpenAI, and
// xAI included), so the user records a starting balance once and Ops derives
// live remaining = starting − observed spend since that date. Stored in
// settings; emits a balance.usd state signal per entity, updated in place.
export interface BalanceEntry {
  entityId: string; // e.g. "vendor_api:xai"
  name: string;
  startingUsd: number;
  asOf: number; // epoch seconds — spend before this is already reflected in the starting amount
}

export async function deriveBalances(db: D1Database, now: number): Promise<void> {
  const entries = (await getSetting<BalanceEntry[]>(db, "balances")) ?? [];
  if (entries.length === 0) return;

  const signals: SignalInsert[] = [];
  for (const entry of entries) {
    // balance entries may name vendors no poller creates (xAI) — ensure the entity exists
    await upsertEntities(
      db,
      [{ id: entry.entityId, kind: "vendor_api", category: "vendor_api", name: entry.name }],
      now,
    );
    const spent = await db
      .prepare(
        "SELECT SUM(value_num) AS total FROM signals WHERE entity_id = ?1 AND metric = 'spend.usd' AND period_start >= ?2",
      )
      .bind(entry.entityId, entry.asOf)
      .first<{ total: number | null }>();
    const remaining = entry.startingUsd - (spent?.total ?? 0);
    const fraction = entry.startingUsd > 0 ? remaining / entry.startingUsd : 0;
    signals.push({
      entityId: entry.entityId,
      metric: "balance.usd",
      valueNum: remaining,
      valueText: `$${remaining.toFixed(2)} of $${entry.startingUsd.toFixed(2)}`,
      severity: remaining <= 0 ? 3 : fraction < 0.2 ? 2 : 0,
      observedAt: now,
      dedupeKey: "balance",
    });
  }
  await insertSignals(db, "core", signals);
}

// Spec §4.2: today > 3× trailing-7-day median → severity 2, derived by core.
// Overwritten daily at severity 0 when normal, so "latest" stays truthful.
export async function detectSpendAnomalies(db: D1Database, now: number): Promise<void> {
  const today = now - (now % DAY);
  const entities = (
    await db
      .prepare("SELECT DISTINCT entity_id FROM signals WHERE metric = 'spend.usd' AND period_start >= ?1")
      .bind(today - 8 * DAY)
      .all<{ entity_id: string }>()
  ).results;

  const signals: SignalInsert[] = [];
  for (const { entity_id } of entities) {
    const sums = (
      await db
        .prepare(
          `SELECT period_start, SUM(value_num) AS total FROM signals
           WHERE entity_id = ?1 AND metric = 'spend.usd' AND period_start >= ?2
           GROUP BY period_start`,
        )
        .bind(entity_id, today - 7 * DAY)
        .all<{ period_start: number; total: number }>()
    ).results;

    const todaySpend = sums.find((s) => s.period_start === today)?.total ?? 0;
    const trailing = sums.filter((s) => s.period_start < today).map((s) => s.total).sort((a, b) => a - b);
    if (trailing.length === 0) continue;
    const mid = Math.floor(trailing.length / 2);
    const median =
      trailing.length % 2 === 1 ? (trailing[mid] ?? 0) : ((trailing[mid - 1] ?? 0) + (trailing[mid] ?? 0)) / 2;
    const anomalous = median > 0 && todaySpend > 3 * median;

    signals.push({
      entityId: entity_id,
      metric: "spend.anomaly",
      valueNum: todaySpend,
      valueText: anomalous
        ? `today $${todaySpend.toFixed(2)} > 3× median $${median.toFixed(2)}`
        : "normal",
      severity: anomalous ? 2 : 0,
      observedAt: now,
      dedupeKey: String(today),
    });
  }
  await insertSignals(db, "core", signals);
}

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

  // Expected metrics describe the REPO portfolio buckets — plugin/skill/vendor
  // entities get their hygiene from their own pollers, not category expectations
  // (40 skills flagged "usage.invocations missing" would be noise, not signal).
  const placeholders = categories.map((_, i) => `?${i + 1}`).join(", ");
  const entities = await db
    .prepare(
      `SELECT id, category FROM entities WHERE archived = 0 AND kind = 'repo' AND category IN (${placeholders})`,
    )
    .bind(...categories)
    .all<{ id: string; category: string }>();

  const signals: SignalInsert[] = [];
  for (const entity of entities.results) {
    for (const metric of expected[entity.category] ?? []) {
      const present = await db
        .prepare("SELECT 1 FROM signals WHERE entity_id = ?1 AND metric = ?2 LIMIT 1")
        .bind(entity.id, metric)
        .first();
      // One hygiene metric PER expected metric — packing them under a single
      // metric name would let a resolved flag shadow a missing one in every
      // latest-per-metric query.
      signals.push({
        entityId: entity.id,
        metric: `hygiene.missing.${metric}`,
        valueText: metric,
        severity: present ? 0 : 1,
        observedAt: now,
        dedupeKey: metric,
      });
    }
  }

  // Resolve hygiene flags whose metric is no longer expected (config changed,
  // category changed) — otherwise a stale severity-1 row stays "latest" forever.
  // Matches the legacy packed name too, sweeping old deployments clean.
  const existing = await db
    .prepare(
      `SELECT s.entity_id, s.metric, s.dedupe_key, e.category FROM signals s
       JOIN entities e ON e.id = s.entity_id
       WHERE (s.metric LIKE 'hygiene.missing.%' OR s.metric = 'hygiene.missing_metric') AND s.severity > 0`,
    )
    .all<{ entity_id: string; metric: string; dedupe_key: string; category: string | null }>();
  for (const row of existing.results) {
    const isLegacy = row.metric === "hygiene.missing_metric";
    const stillExpected = !isLegacy && (expected[row.category ?? ""] ?? []).includes(row.dedupe_key);
    if (!stillExpected) {
      signals.push({
        entityId: row.entity_id,
        metric: row.metric,
        valueText: row.dedupe_key,
        severity: 0,
        observedAt: now,
        dedupeKey: row.dedupe_key,
      });
    }
  }

  // Spec §2.4: untagged repos are themselves a hygiene finding — queryable on
  // /findings, not just visible as the map's warning bucket.
  const knownCategories = new Set(categories);
  const repos = await db
    .prepare("SELECT id, category FROM entities WHERE archived = 0 AND kind = 'repo'")
    .all<{ id: string; category: string | null }>();
  for (const repo of repos.results) {
    const categorized = repo.category != null && knownCategories.has(repo.category);
    signals.push({
      entityId: repo.id,
      metric: "hygiene.uncategorized",
      valueText: repo.category ?? "no topic",
      severity: categorized ? 0 : 1,
      observedAt: now,
      dedupeKey: "category",
    });
  }

  // The standing triage path for inactive repos: no pushes for 90d flags low,
  // 180d flags medium. Resolves itself on the next push; archiving removes the
  // entity from the working set entirely. Based on push activity, NOT
  // last_seen_at (which every hourly poll bumps).
  const pushed = await db
    .prepare(
      `SELECT s.entity_id, MAX(s.value_num) AS pushed_at FROM signals s
       JOIN entities e ON e.id = s.entity_id
       WHERE s.metric = 'repo.pushed_at' AND e.archived = 0
       GROUP BY s.entity_id`,
    )
    .all<{ entity_id: string; pushed_at: number }>();
  for (const row of pushed.results) {
    const days = Math.floor((now - row.pushed_at) / 86_400);
    signals.push({
      entityId: row.entity_id,
      metric: "hygiene.inactive",
      valueNum: days,
      valueText: days >= 90 ? `no pushes for ${days}d` : "active",
      severity: days >= 180 ? 2 : days >= 90 ? 1 : 0,
      observedAt: now,
      dedupeKey: "activity",
    });
  }

  await insertSignals(db, "core", signals);
}
