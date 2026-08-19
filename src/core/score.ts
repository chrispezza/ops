import { labelForMetric, SEVERITY_NAMES, TRIAGE_WEIGHTS, type TriageWeights } from "../config";
import type { EntityView, SignalRow } from "./queries";

export interface ScorePart {
  label: string;
  points: number;
}

export interface Score {
  total: number;
  parts: ScorePart[]; // sorted by points desc — parts[0..1] are the "why" column
}

const SEV_WORDS = SEVERITY_NAMES; // one vocabulary — this said "info" where the dot said "ok"

// Spec §4.1. usage30d is the summed usage.invocations over 30d, or null when
// the entity's kind has no usage semantics at all.
export function computeScore(
  view: EntityView,
  now: number,
  usage30d: number | null,
  weights: TriageWeights = TRIAGE_WEIGHTS,
): Score {
  const w = weights;
  const parts: ScorePart[] = [];
  const latest = Object.values(view.latest);

  const worst = latest.reduce<SignalRow | undefined>(
    (a, b) => (b.severity > (a?.severity ?? -1) ? b : a),
    undefined,
  );
  if (worst && worst.severity > 0) {
    parts.push({ label: worstLabel(worst), points: w.severityFactor * worst.severity });
  }

  const breadth = latest.filter((s) => s.severity >= 2).length;
  if (breadth > 0) {
    parts.push({ label: `${breadth} open problem${breadth > 1 ? "s" : ""}`, points: w.breadthFactor * breadth });
  }

  const days = Math.floor((now - activityAt(view)) / 86_400);
  const tier = w.staleness.find((t) => days >= t.minDays);
  if (tier) parts.push({ label: `stale ${days}d`, points: tier.points });

  if (usage30d !== null && usage30d === 0) {
    parts.push({ label: "no usage 30d", points: w.zeroUsageBonus });
  }

  parts.sort((a, b) => b.points - a.points);
  return { total: parts.reduce((sum, p) => sum + p.points, 0), parts };
}

// "<severity> <metric label>" explains the points (10 × severity) for signal
// metrics — "high CI status". For the hygiene lifecycle metrics the label is a
// state noun that takes the severity word literally: "low activity" for
// hygiene.inactive meant severity-low but read as "activity is low", the exact
// opposite. Those describe the state instead; the breakdown's +N carries the
// arithmetic.
function worstLabel(s: SignalRow): string {
  if (s.metric === "hygiene.inactive") return `inactive ${s.value_num ?? "?"}d`;
  if (s.metric === "hygiene.uncategorized") return "untagged";
  if (s.metric.startsWith("hygiene.missing.")) return `missing ${labelForMetric(s.metric.slice("hygiene.missing.".length))}`;
  if (s.metric === "hygiene.missing_metric") return "missing expected metric";
  return `${SEV_WORDS[s.severity] ?? "?"} ${labelForMetric(s.metric)}`;
}

// Kinds with usage semantics get the zero-usage bonus; everything else passes
// null. Scoped to repos until real skill-usage telemetry exists — otherwise
// every marketplace skill would collect the bonus for data nobody emits yet.
export function hasUsageSemantics(view: EntityView): boolean {
  return view.category === "plugin_skill" && view.kind === "repo";
}

// Staleness means "no real activity", not "not recently polled" — last_seen_at
// is bumped every hourly poll, so for repos the push timestamp is the truth.
export function activityAt(view: Pick<EntityView, "latest" | "last_seen_at">): number {
  return view.latest["repo.pushed_at"]?.value_num ?? view.last_seen_at;
}
