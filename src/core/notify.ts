import { labelForMetric } from "../config";
import { getSetting, putSetting } from "./queries";

// Push alerts for NEW or ESCALATED high-severity findings — the panel learns
// to interrupt. State (what was already announced) lives in settings, so the
// append-only signal model needs no schema change and re-runs stay quiet.
// Dormant until the NTFY_URL secret is set (self-hosted ntfy topic URL).

const NOTIFIED_KEY = "notified_alerts";

interface AlertRow {
  entity_id: string;
  entity_name: string;
  metric: string;
  severity: number;
  value_text: string | null;
  value_num: number | null;
}

export async function notifyNewAlerts(db: D1Database, env: Env, now: number): Promise<void> {
  if (!env.NTFY_URL) return;

  const res = await db
    .prepare(
      `SELECT s.entity_id, e.name AS entity_name, s.metric, s.severity, s.value_text, s.value_num
       FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id, metric ORDER BY observed_at DESC, id DESC) AS rn
         FROM signals
       ) s
       JOIN entities e ON e.id = s.entity_id
       WHERE s.rn = 1 AND e.archived = 0 AND s.severity >= 3 AND e.kind != 'poller'`,
    )
    .all<AlertRow>();

  const current = new Map(res.results.map((a) => [`${a.entity_id}|${a.metric}`, a]));
  const previous = (await getSetting<Record<string, number>>(db, NOTIFIED_KEY)) ?? {};

  const fresh = [...current.entries()].filter(([key, a]) => (previous[key] ?? 0) < a.severity);
  if (fresh.length > 0) {
    const lines = fresh.map(
      ([, a]) => `${a.entity_name}: ${labelForMetric(a.metric)} ${a.value_text ?? a.value_num ?? ""} (sev ${a.severity})`,
    );
    try {
      await fetch(env.NTFY_URL, {
        method: "POST",
        headers: {
          title: `Ops: ${fresh.length} new finding${fresh.length > 1 ? "s" : ""}`,
          priority: fresh.some(([, a]) => a.severity >= 4) ? "urgent" : "high",
          tags: "rotating_light",
          ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
        },
        body: lines.join("\n"),
      });
    } catch (err) {
      // Notification failure must never poison the derive pass; the finding
      // itself is still on the dashboard.
      console.error("ntfy notification failed:", err);
      return; // keep previous state so the alert retries next cycle
    }
  }

  // Persist exactly the current alert set: resolved alerts drop out, so a
  // recurrence later notifies again.
  await putSetting(db, NOTIFIED_KEY, Object.fromEntries([...current.entries()].map(([k, a]) => [k, a.severity])));
}
