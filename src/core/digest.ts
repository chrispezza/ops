import { labelForMetric, SEVERITY_NAMES } from "../config";
import {
  type ArchivedEntity,
  currentFindingsWithBaseline,
  type DigestChangeRow,
  type DigestResolvedRow,
  entitiesSince,
  insertWatermark,
  latestTotals,
  resolvedInWindow,
  spendWindows,
} from "./queries";

// The digest is spec §4.4's "a lens, not a domain" applied to time: the same
// stored signals, asked "what changed since <window start>?" instead of "what
// is bad now?". Nothing is stored — every run recomputes from history, so
// there is no snapshot to drift (the notify module's announced-set is the
// deliberate exception, and it exists because alerts must fire exactly once).

const DAY = 86_400;
export const DIGEST_DEFAULT_DAYS = 7;
// Retention (src/core/retention.ts) compacts older history to one row per
// (entity, metric, day) and keeps 30 days at full resolution; past that there
// is progressively less to diff against, so the window stops there.
export const DIGEST_MAX_DAYS = 30;

// Current-state metrics summed across active entities for the "now" strip.
// These are the GitHub poller's backlog-shape signals: the digest's consumer
// (a person on Friday, or the agent reading /digest.md) wants the count of
// idle issues and major Dependabot bumps next to what changed, so it can
// decide without a second request.
export const BACKLOG_METRICS = [
  "issues.open",
  "issues.new_7d",
  "issues.idle_90d",
  "prs.open",
  "prs.dependabot_count",
  "prs.dependabot_major",
  "deps.vuln_count",
] as const;

export interface DigestRaised extends DigestChangeRow {
  from: number | null; // severity at window start; null = first seen in the window
}

export interface Digest {
  since: number;
  now: number;
  days: number;
  raised: DigestRaised[];
  resolved: DigestResolvedRow[];
  newEntities: ArchivedEntity[];
  spend: { current: number; prior: number };
  backlog: { metric: string; total: number; entities: number }[];
}

// `since=7d` (or a bare `7`), clamped to [1, DIGEST_MAX_DAYS]; anything else is the default.
export function parseSinceDays(raw: string | undefined): number {
  const m = /^(\d{1,3})d?$/.exec(raw ?? "");
  const n = m ? Number(m[1]) : DIGEST_DEFAULT_DAYS;
  return Math.min(DIGEST_MAX_DAYS, Math.max(1, n));
}

export async function buildDigest(db: D1Database, days: number, now: number): Promise<Digest> {
  const since = now - days * DAY;
  const [watermark, current, resolved, newEntities, spend, backlog] = await Promise.all([
    insertWatermark(db, since),
    currentFindingsWithBaseline(db, since),
    resolvedInWindow(db, since),
    entitiesSince(db, since),
    spendWindows(db, since, days * DAY),
    latestTotals(db, BACKLOG_METRICS),
  ]);
  const raised = current.flatMap((row): DigestRaised[] => {
    // No pre-window row: new if it was inserted after the window opened,
    // otherwise an in-place row whose earlier severity is unknowable — skip
    // rather than announce a months-old hygiene flag as news every week.
    if (row.baseline_severity == null) return row.id > watermark ? [{ ...row, from: null }] : [];
    return row.baseline_severity < row.severity ? [{ ...row, from: row.baseline_severity }] : [];
  });
  const order = new Map<string, number>(BACKLOG_METRICS.map((m, i) => [m, i]));
  backlog.sort((a, b) => (order.get(a.metric) ?? 99) - (order.get(b.metric) ?? 99));
  return { since, now, days, raised, resolved, newEntities, spend, backlog };
}

const isoDay = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);
const sevWord = (n: number) => SEVERITY_NAMES[n] ?? String(n);
const rawValue = (s: Pick<DigestChangeRow, "value_text" | "value_num">) => s.value_text ?? (s.value_num != null ? String(s.value_num) : "");

export function digestHeadline(d: Digest): string {
  const n = d.newEntities.length;
  return [
    `${d.raised.length} raised`,
    `${d.resolved.length} resolved`,
    `${n} new ${n === 1 ? "entity" : "entities"}`,
    `spend $${d.spend.current.toFixed(2)} (prior $${d.spend.prior.toFixed(2)})`,
  ].join(" · ");
}

// Markdown for GET /digest.md — the facts half of the Friday report. The
// agent that reads it supplies judgment; Ops supplies what it uniquely holds
// (ADR-001), which is why every line carries a deep link and the signal name
// so the agent can cite and re-check it.
export function renderDigestMarkdown(d: Digest, opsUrl?: string): string {
  const base = opsUrl?.replace(/\/$/, "");
  const entityLink = (id: string) => (base ? `${base}/e/${id}` : `/e/${id}`);
  const lines: string[] = [
    `# Ops digest — ${d.days}d ending ${isoDay(d.now)}`,
    "",
    `**${digestHeadline(d)}**`,
    "",
    `## Raised`,
    `Findings at severity 2+ that are new or escalated since ${isoDay(d.since)}.`,
    ...(d.raised.length === 0
      ? ["- none"]
      : d.raised.map(
          (r) =>
            `- **${r.entity_name}** — ${labelForMetric(r.metric)}: ${rawValue(r)} — ${sevWord(r.severity)}${
              r.from == null ? ", new" : `, was ${sevWord(r.from)}`
            } — ${r.url ?? entityLink(r.entity_id)} (ops signal: ${r.metric}, entity: ${entityLink(r.entity_id)})`,
        )),
    "",
    `## Resolved`,
    `Findings that dropped below severity 2 during the window.`,
    ...(d.resolved.length === 0
      ? ["- none"]
      : d.resolved.map(
          (r) =>
            `- **${r.entity_name}** — ${labelForMetric(r.metric)}: now ${rawValue(r)} (peaked ${sevWord(r.peak)}) — ${entityLink(r.entity_id)} (ops signal: ${r.metric})`,
        )),
    "",
    `## New entities`,
    ...(d.newEntities.length === 0
      ? ["- none"]
      : d.newEntities.map((e) => `- ${e.name} (${e.kind}${e.category ? `, ${e.category}` : ""}) — ${entityLink(e.id)}`)),
    "",
    `## Portfolio now`,
    `Current state across active entities — not a delta.`,
    "",
    `| metric | total | entities |`,
    `|---|---|---|`,
    ...d.backlog.map((b) => `| ${labelForMetric(b.metric)} (${b.metric}) | ${b.total} | ${b.entities} |`),
    "",
    `## Spend`,
    `This window $${d.spend.current.toFixed(2)} · prior window $${d.spend.prior.toFixed(2)}`,
    "",
    `_Read here, act there: links go to the system of record or the Ops entity page. Generated ${new Date(d.now * 1000).toISOString()}._`,
  ];
  return lines.join("\n");
}

// Friday push: the headline plus the top movers, clicking through to /digest.
// Dormant without NTFY_URL. Default priority — anything urgent already fired
// hourly through notifyNewAlerts; this is the weekly read, not an alarm.
export async function notifyDigest(db: D1Database, env: Env, now: number): Promise<void> {
  if (!env.NTFY_URL) return;
  const digest = await buildDigest(db, DIGEST_DEFAULT_DAYS, now);
  const base = env.OPS_URL?.replace(/\/$/, "");
  const lines = [
    digestHeadline(digest),
    ...digest.raised.slice(0, 5).map((r) => `▲ ${r.entity_name}: ${labelForMetric(r.metric)} ${rawValue(r)}`),
    ...digest.resolved.slice(0, 3).map((r) => `✓ ${r.entity_name}: ${labelForMetric(r.metric)} ${rawValue(r)}`),
  ];
  try {
    await fetch(env.NTFY_URL, {
      method: "POST",
      headers: {
        title: `Ops weekly digest — ${isoDay(now)}`,
        priority: "default",
        tags: "newspaper",
        ...(base ? { click: `${base}/digest?since=${DIGEST_DEFAULT_DAYS}d` } : {}),
        ...(env.NTFY_TOKEN ? { authorization: `Bearer ${env.NTFY_TOKEN}` } : {}),
      },
      body: lines.join("\n"),
    });
  } catch (err) {
    // The digest is recomputed from history on every request, so a failed push
    // loses nothing — /digest still shows the same window.
    console.error("ntfy digest failed:", err);
  }
}
