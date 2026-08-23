import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../src/core/agent-prompt";
import type { EntityRow, SignalRow } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";

const NOW = 1_754_400_000;

const repo: EntityRow = {
  id: "repo:clownware/gittunes",
  kind: "repo",
  category: "web_app",
  name: "gittunes",
  owner: "clownware",
  source_url: "https://github.com/clownware/gittunes",
  metadata: null,
  first_seen_at: NOW,
  last_seen_at: NOW,
  archived: 0,
};

function sig(metric: string, value_num: number | null, severity = 0, value_text: string | null = null, url: string | null = null): SignalRow {
  return {
    id: 1, entity_id: repo.id, source: "github", metric, value_num, value_text, severity,
    url, observed_at: NOW, period_start: null, period_end: null, dedupe_key: "k",
  };
}

describe("buildAgentPrompt", () => {
  it("assembles findings, approach, and poller-verified done-criteria", () => {
    const prompt = buildAgentPrompt(
      repo,
      [
        sig("ci.status", null, 3, "failure", "https://github.com/clownware/gittunes/actions"),
        sig("ci.fail_streak", 4, 2),
        sig("deps.vuln_count", 2, 2, null, "https://github.com/clownware/gittunes/security/dependabot"),
        sig("prs.open", 3, 0, null, "https://github.com/clownware/gittunes/pulls"),
        sig("prs.oldest_days", 23, 2),
        sig("issues.open", 11, 1),
      ],
      NOW,
    );
    expect(prompt).toContain("clownware/gittunes");
    expect(prompt).toContain("CI is failing on the default branch — https://github.com/clownware/gittunes/actions");
    expect(prompt).toContain("4 consecutive CI failures");
    expect(prompt).toContain("2 open Dependabot vulnerability alert(s)");
    expect(prompt).toContain("3 open PR(s), oldest open 23d");
    expect(prompt).toContain("11 open issue(s)");
    expect(prompt).toContain("gh repo clone clownware/gittunes");
    // done-criteria mirror the signals the next poll re-checks
    expect(prompt).toContain("ci.status = success");
    expect(prompt).toContain("deps.vuln_count = 0");
    expect(prompt).toContain("every open PR has a decision");
  });

  it("returns null for healthy repos and non-repo entities", () => {
    expect(buildAgentPrompt(repo, [sig("ci.status", null, 0, "success")], NOW)).toBeNull();
    expect(buildAgentPrompt({ ...repo, kind: "vendor_api" }, [sig("spend.anomaly", 12, 2)], NOW)).toBeNull();
  });

  it("omits done-criteria for absent findings", () => {
    const prompt = buildAgentPrompt(repo, [sig("issues.open", 5, 0, null, "https://github.com/clownware/gittunes/issues")], NOW);
    expect(prompt).toContain("5 open issue(s)");
    expect(prompt).not.toContain("ci.status = success");
    expect(prompt).toContain("resolved or explicitly triaged");
  });
});

describe("entity page agent prompt block", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
  });

  it("renders for repos with findings and hides otherwise", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "repo:a/broken", kind: "repo", category: "web_app", name: "broken", sourceUrl: "https://github.com/a/broken" },
        { id: "repo:a/healthy", kind: "repo", category: "web_app", name: "healthy" },
      ],
      NOW,
    );
    await insertSignals(env.DB, "github", [
      { entityId: "repo:a/broken", metric: "ci.status", valueText: "failure", severity: 3, observedAt: NOW, dedupeKey: "c" },
    ]);

    const broken = await (await SELF.fetch("https://ops.local/e/repo:a/broken")).text();
    expect(broken).toContain("agent-prompt");
    expect(broken).toContain("copy prompt");
    expect(broken).toContain("Investigate and address the current findings");

    const healthy = await (await SELF.fetch("https://ops.local/e/repo:a/healthy")).text();
    expect(healthy).not.toContain("agent-prompt");
  });
});

describe("worker error-rate prompt", () => {
  const worker: EntityRow = {
    ...repo,
    id: "worker:deprep",
    kind: "worker",
    category: "vendor_api",
    name: "deprep",
    owner: null,
    source_url: "https://dash.cloudflare.com/acct/workers/services/view/deprep",
  };
  const errSig = (severity: number): SignalRow =>
    sig("cf.error_rate", 1.51, severity, "23 of 1523 requests", "https://dash.cloudflare.com/acct/workers/services/view/deprep");

  it("builds findings, wrangler-based approach, and the poller-verified done-criterion", () => {
    const prompt = buildAgentPrompt(worker, [errSig(2)], NOW);
    expect(prompt).toContain("Cloudflare Worker deprep");
    expect(prompt).toContain("error rate 1.51% (23 of 1523 requests, trailing day) — https://dash.cloudflare.com/acct/workers/services/view/deprep");
    expect(prompt).toContain("wrangler tail deprep");
    expect(prompt).toContain("wrangler deployments list");
    expect(prompt).toContain('a wrangler config naming "deprep"');
    expect(prompt).toContain("ops signal: cf.error_rate, severity 0");
  });

  it("returns null for a healthy worker and for workers without the signal", () => {
    expect(buildAgentPrompt(worker, [errSig(0)], NOW)).toBeNull();
    expect(buildAgentPrompt(worker, [sig("cf.requests", 1523, 0)], NOW)).toBeNull();
  });

  it("renders the prompt block on the worker entity page", async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
    await upsertEntities(
      env.DB,
      [{ id: "worker:deprep", kind: "worker", category: "vendor_api", name: "deprep" }],
      NOW,
    );
    await insertSignals(env.DB, "cloudflare", [
      {
        entityId: "worker:deprep",
        metric: "cf.error_rate",
        valueNum: 1.51,
        valueText: "23 of 1523 requests",
        severity: 2,
        observedAt: NOW,
        dedupeKey: "d",
      },
    ]);
    const page = await (await SELF.fetch("https://ops.local/e/worker:deprep")).text();
    expect(page).toContain("agent-prompt");
    expect(page).toContain("copy prompt");
    expect(page).toContain("elevated error rate on the Cloudflare Worker deprep");
  });
});

describe("expanded finding coverage (issue #24)", () => {
  it("a down site produces a prompt even with green CI, and leads it", () => {
    const prompt = buildAgentPrompt(
      repo,
      [
        sig("ci.status", null, 0, "success"),
        sig("site.up", 0, 3, "down", "https://gittunes.example"),
      ],
      NOW,
    );
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("the deployed site is DOWN — https://gittunes.example — highest priority");
    expect(prompt).toContain("site.up = up");
    // severity order: the site finding precedes any CI mention in the approach
    expect(prompt!.indexOf("DOWN")).toBeLessThan(prompt!.indexOf("CI failure"));
  });

  it("covers a worker error rate attributed to the repo", () => {
    const prompt = buildAgentPrompt(
      repo,
      [sig("cf.error_rate", 2.4, 2, "12 of 500 requests", "https://dash.cloudflare.com/acct/workers/services/view/gittunes")],
      NOW,
    );
    expect(prompt).toContain("Worker error rate 2.4% (12 of 500 requests) — https://dash.cloudflare.com/acct/workers/services/view/gittunes");
    expect(prompt).toContain("ops signal: cf.error_rate");
  });

  it("covers lighthouse, docs gaps and expected-but-missing metrics", () => {
    const prompt = buildAgentPrompt(
      repo,
      [
        sig("lhci.performance", 61, 2, null, "https://ci.example/lhci"),
        sig("docs.score", 50, 1, "missing: CLAUDE.md, license"),
        sig("hygiene.missing.lhci.performance", null, 1),
      ],
      NOW,
    );
    expect(prompt).toContain("Lighthouse performance is 61");
    expect(prompt).toContain("documentation gaps — missing: CLAUDE.md, license");
    expect(prompt).toContain("expected metrics never reported: lhci.performance");
    expect(prompt).toContain("docs.score = 100");
    expect(prompt).toContain("POST /ingest");
  });
});
