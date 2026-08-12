import type { EntityRow, SignalRow } from "./queries";

// A generated hand-off prompt is the +issue affordance matured: Ops contributes
// what it uniquely holds — current findings and machine-checkable done-criteria
// (the next poll verifies the agent's work) — and delegates everything it can't
// know (checkout paths, conventions, test commands) to the agent itself.
// Read here, act there (ADR-001): Ops never dispatches anything.
export function buildAgentPrompt(entity: EntityRow, latest: SignalRow[], now: number): string | null {
  if (entity.kind !== "repo") return null;
  const by = (metric: string) => latest.find((s) => s.metric === metric);
  const link = (s: SignalRow | undefined) => (s?.url ? ` — ${s.url}` : "");

  const findings: string[] = [];
  const done: string[] = [];

  const ci = by("ci.status");
  if (ci && ci.severity > 0) {
    findings.push(`- CI is failing on the default branch${link(ci)}`);
    done.push("- CI green on the default branch (ops signal: ci.status = success)");
  }
  const streak = by("ci.fail_streak");
  if ((streak?.value_num ?? 0) >= 2) {
    findings.push(`- ${streak?.value_num} consecutive CI failures — chronic, suspect a structural cause`);
  }
  const vulns = by("deps.vuln_count");
  if ((vulns?.value_num ?? 0) > 0) {
    findings.push(`- ${vulns?.value_num} open Dependabot vulnerability alert(s)${link(vulns)}`);
    done.push("- zero open Dependabot alerts (ops signal: deps.vuln_count = 0); dismissals need a stated reason");
  }
  const prs = by("prs.open");
  const oldestPr = by("prs.oldest_days");
  if ((prs?.value_num ?? 0) > 0) {
    const age = (oldestPr?.value_num ?? 0) > 0 ? `, oldest open ${oldestPr?.value_num}d` : "";
    findings.push(`- ${prs?.value_num} open PR(s)${age}${link(prs)}`);
    if ((oldestPr?.value_num ?? 0) >= 14) {
      done.push("- every open PR has a decision: merged, updated with what it needs, or closed with a reason");
    }
  }
  const issues = by("issues.open");
  if ((issues?.value_num ?? 0) > 0) {
    findings.push(`- ${issues?.value_num} open issue(s)${link(issues)} — triage them; fixing is optional, deciding is not`);
  }

  if (findings.length === 0) return null;

  const repoRef = entity.id.replace(/^repo:/, "");
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  return [
    `Investigate and address the current findings for ${repoRef}${entity.source_url ? ` (${entity.source_url})` : ""}.`,
    "",
    `Findings from the ops dashboard, as of ${date}:`,
    ...findings,
    "",
    "Approach:",
    `1. Get the repo (gh repo clone ${repoRef} if you don't have a checkout) and read its CLAUDE.md / README / CONTRIBUTING for conventions before changing anything.`,
    "2. Start with the CI failure if there is one: gh run list, then gh run view --log-failed on the latest failing run.",
    "3. For Dependabot alerts: gh api repos/" + repoRef + "/dependabot/alerts — prefer minimal version bumps that keep tests green.",
    "4. For PRs and issues: gh pr list / gh issue list — summarize state and recommend merge/update/close per item rather than silently fixing.",
    "5. Run the repo's own tests and quality gates before proposing changes.",
    "",
    "Definition of done (the ops dashboard re-checks these automatically on its next hourly poll):",
    ...(done.length > 0 ? done : ["- all findings above are resolved or explicitly triaged with reasons"]),
    "",
    "Work in small conventional commits; open a PR rather than pushing to the default branch unless the repo's own docs say otherwise.",
  ].join("\n");
}
