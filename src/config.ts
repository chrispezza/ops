// Weights and category maps are data, not code paths (spec §2.4, §4.1).

// Expected metrics per category: absence becomes a queryable hygiene signal.
export const EXPECTED_METRICS: Record<string, string[]> = {
  static_site: ["lhci.performance"],
  web_app: ["ci.status", "deps.vuln_count"],
  plugin_skill: ["usage.invocations", "manifest.description"],
};

// Triage score — spec §4.1. Overridable via /settings in a later phase.
export const TRIAGE_WEIGHTS = {
  severityFactor: 10, // 10 * max open severity
  breadthFactor: 2, // 2 * count(severity >= 2)
  staleness: [
    { minDays: 90, points: 6 },
    { minDays: 30, points: 3 },
  ],
  zeroUsageBonus: 5, // kinds with usage metrics only
} as const;
