import type { EntityRow, SignalRow } from "./queries";

// A generated hand-off prompt is the +issue affordance matured: Ops contributes
// what it uniquely holds — current findings and machine-checkable done-criteria
// (the next poll verifies the agent's work) — and delegates everything it can't
// know (checkout paths, conventions, test commands) to the agent itself.
// Read here, act there (ADR-001): Ops never dispatches anything.
// Repos and Workers get prompts; other kinds (vendor consoles, databases) have
// no agent-actionable surface, so their pages stay prompt-free.
export function buildAgentPrompt(entity: EntityRow, latest: SignalRow[], now: number): string | null {
  if (entity.kind === "worker") return buildWorkerPrompt(entity, latest, now);
  if (entity.kind !== "repo") return null;
  const by = (metric: string) => latest.find((s) => s.metric === metric);
  const link = (s: SignalRow | undefined) => (s?.url ? ` — ${s.url}` : "");

  const findings: string[] = [];
  const done: string[] = [];

  // Severity order: a down production site outranks everything else on the
  // page — the prompt used to skip it entirely (only CI/deps/PRs/issues were
  // read), so the hand-off could omit the very finding that made the row red.
  const site = by("site.up");
  if (site && site.severity > 0) {
    findings.push(`- the deployed site is DOWN${link(site)} — highest priority`);
    done.push("- the site responds successfully (ops signal: site.up = up)");
  }
  // Attributed to the repo only if a poller ever lands it here — today the
  // Cloudflare poller puts cf.error_rate on worker: entities (see below).
  const errRate = by("cf.error_rate");
  if (errRate && errRate.severity > 0) {
    findings.push(
      `- Worker error rate ${errRate.value_num ?? "?"}%${errRate.value_text ? ` (${errRate.value_text})` : ""}${link(errRate)}`,
    );
    done.push("- error rate back at or below 1% over the trailing day (ops signal: cf.error_rate)");
  }
  const lhci = by("lhci.performance");
  if (lhci && lhci.severity > 0) {
    findings.push(`- Lighthouse performance is ${lhci.value_num ?? "?"}${link(lhci)}`);
    done.push("- Lighthouse performance back above its budget (ops signal: lhci.performance, pushed by CI)");
  }
  const docs = by("docs.score");
  if (docs && docs.severity > 0 && docs.value_text) {
    findings.push(`- documentation gaps — ${docs.value_text}`);
    done.push("- docs complete (ops signal: docs.score = 100)");
  }
  const expected = latest.filter((s) => s.metric.startsWith("hygiene.missing.") && s.severity > 0);
  if (expected.length > 0) {
    const names = expected.map((s) => s.metric.slice("hygiene.missing.".length)).join(", ");
    findings.push(`- expected metrics never reported: ${names} — this category of repo should push them from CI`);
    done.push("- each expected metric arrives via POST /ingest from the repo's CI (see the ops README)");
  }

  const ci = by("ci.status");
  if (ci && ci.severity > 0) {
    findings.push(`- CI is failing on the default branch${link(ci)}`);
    done.push("- CI green on the default branch (ops signal: ci.status = success)");
  }
  const streak = by("ci.fail_streak");
  if ((streak?.value_num ?? 0) >= 2) {
    // "chronic" only past the signal's own escalation threshold (github.ts
    // flags the streak at ≥3) — the prompt was calling 2 chronic
    const chronic = (streak?.value_num ?? 0) >= 3 ? " — chronic, suspect a structural cause" : "";
    findings.push(`- ${streak?.value_num} consecutive CI failures${chronic}`);
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
    "2. A down site comes first: check the host/DNS/deploy pipeline via the finding's URL before touching code.",
    "3. Then the CI failure if there is one: gh run list, then gh run view --log-failed on the latest failing run.",
    "4. For Dependabot alerts: gh api repos/" + repoRef + "/dependabot/alerts — prefer minimal version bumps that keep tests green.",
    "5. For PRs and issues: gh pr list / gh issue list — summarize state and recommend merge/update/close per item rather than silently fixing.",
    "6. Run the repo's own tests and quality gates before proposing changes.",
    "",
    "Definition of done (the ops dashboard re-checks these automatically on its next hourly poll):",
    ...(done.length > 0 ? done : ["- all findings above are resolved or explicitly triaged with reasons"]),
    "",
    "Work in small conventional commits; open a PR rather than pushing to the default branch unless the repo's own docs say otherwise.",
  ].join("\n");
}

// Worker entities carry Cloudflare telemetry, not repo signals — the one
// actionable finding is an elevated error rate. Ops doesn't know which repo
// deploys the Worker (the poller only sees script names), so locating the
// source is delegated to the agent like every other unknowable.
function buildWorkerPrompt(entity: EntityRow, latest: SignalRow[], now: number): string | null {
  const errRate = latest.find((s) => s.metric === "cf.error_rate");
  if (!errRate || errRate.severity === 0) return null;

  const script = entity.id.replace(/^worker:/, "");
  const date = new Date(now * 1000).toISOString().slice(0, 10);
  return [
    `Investigate and fix the elevated error rate on the Cloudflare Worker ${script}.`,
    "",
    `Findings from the ops dashboard, as of ${date}:`,
    `- error rate ${errRate.value_num ?? "?"}%${errRate.value_text ? ` (${errRate.value_text}, trailing day)` : ""}${errRate.url ? ` — ${errRate.url}` : ""}`,
    "",
    "Approach:",
    `1. Find the repo that deploys this Worker (a wrangler config naming "${script}") and read its CLAUDE.md / README for conventions before changing anything.`,
    `2. Capture live failures: wrangler tail ${script} (or the Cloudflare dash link above) — note status codes, exceptions, and which routes fail.`,
    `3. Correlate with recent deploys: wrangler deployments list — a rate that jumped after a deploy points at that change; a rollback is a legitimate stopgap while you fix forward.`,
    "4. Fix the root cause in the deploying repo, run its tests and quality gates, and ship through its normal pipeline rather than an ad-hoc deploy.",
    "",
    "Definition of done (the ops dashboard re-checks this on its next daily poll):",
    "- error rate back at or below 1% over the trailing day (ops signal: cf.error_rate, severity 0)",
    "",
    "Work in small conventional commits; open a PR rather than pushing to the default branch unless the repo's own docs say otherwise.",
  ].join("\n");
}
