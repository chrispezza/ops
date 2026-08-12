import { labelForMetric, TRIAGE_WEIGHTS, type TriageWeights } from "../config";
import type { EntityView, SignalRow } from "./queries";

export interface ScorePart {
  label: string;
  points: number;
}

export interface Score {
  total: number;
  parts: ScorePart[]; // sorted by points desc — parts[0..1] are the "why" column
}

const SEV_WORDS = ["info", "low", "medium", "high", "critical"] as const;

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
    parts.push({
      label: `${SEV_WORDS[worst.severity] ?? "?"} ${labelForMetric(worst.metric)}`,
      points: w.severityFactor * worst.severity,
    });
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

// Kinds with usage semantics get the zero-usage bonus; everything else passes null.
export function hasUsageSemantics(view: EntityView): boolean {
  return view.category === "plugin_skill";
}

// Staleness means "no real activity", not "not recently polled" — last_seen_at
// is bumped every hourly poll, so for repos the push timestamp is the truth.
export function activityAt(view: Pick<EntityView, "latest" | "last_seen_at">): number {
  return view.latest["repo.pushed_at"]?.value_num ?? view.last_seen_at;
}
