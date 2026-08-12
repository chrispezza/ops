// Weights and category maps are data, not code paths (spec §2.4, §4.1).

// Expected metrics per category: absence becomes a queryable hygiene signal.
// Only metrics a poller in THIS deployment can provide belong here — the work
// deployment adds manifest.description alongside its manifests poller
// (ADR-004); listing it here would flag every skill for an unfixable gap.
export const EXPECTED_METRICS: Record<string, string[]> = {
  static_site: ["lhci.performance"],
  web_app: ["ci.status", "deps.vuln_count"],
  plugin_skill: ["usage.invocations"],
  tooling: [], // templates/libs/experiments — categorized, but nothing is demanded of them
  client_project: [], // mixed shapes; per-repo expectations don't generalize
};

// Display names for metric codes. Codes stay the storage/query contract
// (ADR-002); labels are presentation config. Unknown metrics fall back to
// their raw code so new ingest domains render without code changes.
export const METRIC_LABELS: Record<string, string> = {
  "ci.status": "CI status",
  "ci.duration_ms": "CI duration",
  "ci.fail_streak": "CI fail streak",
  "deps.vuln_count": "Dependabot vulns",
  "issues.open": "open issues",
  "prs.open": "open PRs",
  "prs.oldest_days": "oldest PR age",
  "repo.pushed_at": "last push",
  "repo.branches": "branches",
  "release.age_days": "release age",
  "lhci.performance": "Lighthouse perf",
  "tests.coverage_pct": "test coverage",
  "audit.vuln_count": "audit vulns",
  "site.up": "site status",
  "site.response_ms": "site response",
  "usage.invocations": "invocations 30d",
  "usage.tokens_in": "tokens in",
  "usage.tokens_out": "tokens out",
  "usage.sessions": "sessions",
  "usage.loc_added": "lines added",
  "usage.commits": "commits",
  "spend.usd": "spend",
  "spend.anomaly": "spend anomaly",
  "balance.usd": "balance",
  "budget.status": "budget",
  "usage.monthly_posts": "posts this month",
  "usage.cap_pct": "post cap used",
  "poller.status": "poller status",
  "hygiene.uncategorized": "category tag",
  "hygiene.inactive": "activity",
  "manifest.description": "manifest description",
  "manifest.skill_count": "skills",
  "cf.requests": "requests",
  "cf.errors": "errors",
  "cf.error_rate": "error rate",
  "d1.size_bytes": "database size",
};

export function labelForMetric(metric: string): string {
  if (metric.startsWith("hygiene.missing.")) {
    return `expected: ${labelForMetric(metric.slice("hygiene.missing.".length))}`;
  }
  if (metric === "hygiene.missing_metric") return "expected metric"; // legacy packed name
  return METRIC_LABELS[metric] ?? metric;
}

// Entity-page section headings, keyed by metric domain prefix.
export const DOMAIN_LABELS: Record<string, string> = {
  ci: "CI",
  deps: "Dependencies",
  prs: "Pull Requests",
  issues: "Issues",
  repo: "Repository",
  release: "Releases",
  site: "Site",
  lhci: "Lighthouse",
  tests: "Tests",
  audit: "Audit",
  usage: "Usage",
  spend: "Spend",
  balance: "Balance",
  budget: "Budget",
  hygiene: "Hygiene",
  poller: "Poller",
  manifest: "Manifest",
  cf: "Cloudflare",
  d1: "Database",
};

// Triage score — spec §4.1. Defaults here; overridable via /settings (stored in D1).
export interface TriageWeights {
  severityFactor: number; // 10 * max open severity
  breadthFactor: number; // 2 * count(severity >= 2)
  staleness: { minDays: number; points: number }[]; // sorted by minDays desc
  zeroUsageBonus: number; // kinds with usage metrics only
}

export const TRIAGE_WEIGHTS: TriageWeights = {
  severityFactor: 10,
  breadthFactor: 2,
  staleness: [
    { minDays: 90, points: 6 },
    { minDays: 30, points: 3 },
  ],
  zeroUsageBonus: 5,
};
