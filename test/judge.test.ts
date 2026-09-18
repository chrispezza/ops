import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findings } from "../src/core/queries";
import { computeScore } from "../src/core/score";
import type { EntityView, SignalRow } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";
import { judge, tierFromScore } from "../src/pollers/judge";
import type { KnownEntity, PollerResult, SignalInsert } from "../src/pollers/types";

const NOW = Math.floor(Date.now() / 1000);
const KEY = { TYPESAFE_API_KEY: "test-typesafe-key", GITHUB_PAT: "test-pat" };

const repo = (over: Partial<KnownEntity> = {}): KnownEntity => ({
  id: "repo:chrispezza/ops",
  kind: "repo",
  category: "web_app",
  name: "ops",
  metadata: { private: false },
  archived: false,
  ...over,
});

const ctxOf = (entities: KnownEntity[]) => ({ listEntities: async () => entities });

// Labels carry provenance: the timeline says who applied each one. Default is a
// human, so a fixture reads as "the maintainer labelled this" unless it says
// otherwise.
const HUMAN = { login: "chrispezza", __typename: "User" };
const CLAUDE_APP = { login: "claude[bot]", __typename: "Bot" };

const issue = (
  number: number,
  title: string,
  labels: string[] = [],
  body = "some detail",
  actor: { login: string; __typename: string } = HUMAN,
) => ({
  number,
  title,
  body,
  labels: { nodes: labels.map((name) => ({ name })) },
  timelineItems: { nodes: labels.map((name) => ({ label: { name }, actor })) },
});

interface StubOpts {
  issues: ReturnType<typeof issue>[];
  total?: number;
  scores?: Record<number, { score: number; confidence: number }>;
  jevStatus?: number;
  githubStatus?: number;
}

// Captures every Jev request body so a test can assert what actually left the
// deployment — the blind-calibration guarantee is only worth as much as that.
const jevRequests: unknown[] = [];

function stubUpstreams(opts: StubOpts) {
  jevRequests.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.github.com/graphql")) {
        if (opts.githubStatus) return new Response("nope", { status: opts.githubStatus });
        return Response.json({
          data: { repository: { issues: { totalCount: opts.total ?? opts.issues.length, nodes: opts.issues } } },
        });
      }
      if (url.includes("api.typesafe.ai")) {
        if (opts.jevStatus) return new Response("nope", { status: opts.jevStatus });
        const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
        jevRequests.push(body);
        const answers: Record<string, unknown> = {};
        for (const qid of Object.keys(body.questions)) {
          const n = Number(qid.replace("issue_", ""));
          const given = opts.scores?.[n] ?? { score: 2, confidence: 0.9 };
          answers[qid] = { type: "score", score: given.score, confidence: given.confidence };
        }
        return Response.json({ model: "jev-latest", answers });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

const signalFor = (result: PollerResult, metric: string): SignalInsert | undefined =>
  result.signals.find((s) => s.metric === metric);

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

afterEach(() => vi.unstubAllGlobals());

describe("judge poller", () => {
  it("is calmly unconfigured without a TYPESAFE_API_KEY", async () => {
    await expect(judge.poll({ ...env, GITHUB_PAT: "x" } as Env, ctxOf([repo()]))).rejects.toThrow(/^unconfigured:/);
  });

  it("proposes tiers for unlabelled issues only, and never above severity 0", async () => {
    stubUpstreams({
      issues: [issue(1, "crash on save"), issue(2, "typo in README"), issue(3, "auth bypass", ["p0"])],
      scores: { 1: { score: 2.4, confidence: 0.9 }, 2: { score: 0.2, confidence: 0.9 }, 3: { score: 3, confidence: 0.95 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    const tier = signalFor(result, "judge.issue_tier");
    // #1 rounds to p1 and counts; #2 is "nothing to act on"; #3 is already labelled.
    expect(tier?.valueNum).toBe(1);
    expect(tier?.valueText).toContain("#1 p1");
    expect(tier?.valueText).not.toContain("#3");
    // ADR-006 rule 1: the floor is the mechanism, so it is asserted, not assumed.
    expect(result.signals.every((s) => s.severity === 0)).toBe(true);
  });

  it("grades itself against the maintainer's labels on a blind sample", async () => {
    stubUpstreams({
      issues: [issue(10, "data loss on sync", ["p0"]), issue(11, "button misaligned", ["p2"])],
      // p0 is severity 3 and the judge says 3 — exact. p2 is severity 1 and the
      // judge says 2 — within one tier, but not exact.
      scores: { 10: { score: 3, confidence: 0.9 }, 11: { score: 2, confidence: 0.9 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    const agreement = signalFor(result, "judge.tier_agreement");
    expect(agreement?.valueNum).toBe(50);
    expect(agreement?.valueText).toBe("1 of 2 exact · 2 within one tier · human-labelled sample");
  });

  it("refuses to grade itself against labels an automation applied", async () => {
    stubUpstreams({
      issues: [
        issue(12, "data loss on sync", ["p0"], "detail", CLAUDE_APP),
        issue(13, "button misaligned", ["p2"], "detail", CLAUDE_APP),
      ],
      scores: { 12: { score: 3, confidence: 0.9 }, 13: { score: 1, confidence: 0.9 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // Both labels came from the Claude GitHub App. Agreeing with them would be
    // two models agreeing, so there is no number to report.
    const agreement = signalFor(result, "judge.tier_agreement");
    expect(agreement?.valueNum).toBeUndefined();
    expect(agreement?.valueText).toBe("no human-labelled issues to compare against");
    expect(result.notes?.join(" ")).toContain("2 issue(s) excluded from calibration");
  });

  it("still treats an automation-labelled issue as tiered, so it gets no proposal", async () => {
    stubUpstreams({
      issues: [issue(14, "already triaged by the routine", ["p1"], "detail", CLAUDE_APP)],
      scores: { 14: { score: 3, confidence: 0.95 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    // issues.flagged already sees a p1 whoever applied it — proposing again is noise.
    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(0);
  });

  it("honours JUDGE_CALIBRATION_EXCLUDE for automations running under a person's PAT", async () => {
    const robot = { login: "ops-routine", __typename: "User" };
    stubUpstreams({
      issues: [issue(15, "labelled by a PAT-driven routine", ["p0"], "detail", robot)],
      scores: { 15: { score: 3, confidence: 0.9 } },
    });
    const result = await judge.poll(
      { ...env, ...KEY, JUDGE_CALIBRATION_EXCLUDE: "ops-routine" } as unknown as Env,
      ctxOf([repo()]),
    );
    expect(signalFor(result, "judge.tier_agreement")?.valueNum).toBeUndefined();
  });

  it("ignores a severity label that was applied and later removed", async () => {
    const removed = {
      ...issue(16, "label since removed", [], "detail"),
      // timeline remembers the LABELED_EVENT; the issue no longer carries it
      timelineItems: { nodes: [{ label: { name: "p0" }, actor: HUMAN }] },
    };
    stubUpstreams({ issues: [removed], scores: { 16: { score: 2, confidence: 0.9 } } });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // It is unlabelled now, so it gets a proposal and no calibration entry.
    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(1);
    expect(signalFor(result, "judge.tier_agreement")?.valueNum).toBeUndefined();
  });

  it("never shows the judge the labels it is being graded against", async () => {
    stubUpstreams({ issues: [issue(20, "broken login", ["p0", "security"])] });
    await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // Only the state carries issue data; the criteria are our own wording and
    // legitimately mention security, so the assertion is scoped to the state.
    const states = JSON.stringify(jevRequests.map((r) => (r as { state: unknown }).state));
    expect(states).toContain("broken login");
    expect(states).not.toContain("p0");
    expect(states).not.toContain("security");
    expect(states).not.toContain("labels");
  });

  it("drops verdicts below the confidence floor and says so in notes", async () => {
    stubUpstreams({
      issues: [issue(30, "maybe a bug"), issue(31, "definitely a bug")],
      scores: { 30: { score: 3, confidence: 0.4 }, 31: { score: 3, confidence: 0.95 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(1);
    expect(result.notes?.join(" ")).toContain("confidence floor");
  });

  it("reports a truncated read instead of capping silently", async () => {
    stubUpstreams({ issues: [issue(40, "one")], total: 99 });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    expect(result.notes?.join(" ")).toContain("read 1 of 99 open issues");
  });

  it("skips private repos under JUDGE_SCOPE=public", async () => {
    stubUpstreams({ issues: [issue(50, "anything")] });
    const result = await judge.poll(
      { ...env, ...KEY, JUDGE_SCOPE: "public" } as Env,
      ctxOf([repo({ metadata: { private: true } })]),
    );
    expect(result.signals).toHaveLength(0);
    expect(result.notes?.join(" ")).toContain("skipped 1 private repo");
  });

  it("withholds private issue bodies under JUDGE_SCOPE=titles", async () => {
    stubUpstreams({ issues: [issue(60, "title only please", [], "SECRET BODY TEXT")] });
    const result = await judge.poll(
      { ...env, ...KEY, JUDGE_SCOPE: "titles" } as Env,
      ctxOf([repo({ metadata: { private: true } })]),
    );
    expect(JSON.stringify(jevRequests)).not.toContain("SECRET BODY TEXT");
    expect(result.notes?.join(" ")).toContain("bodies withheld");
  });

  it("isolates one failing repo but fails the run when nothing could be judged", async () => {
    stubUpstreams({ issues: [issue(70, "x")], jevStatus: 500 });
    // Only repo fails -> the whole pass failed, and a calm note would leave
    // poller.last_ok marching forward over a judge that judged nothing.
    await expect(judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]))).rejects.toThrow(/no repo could be judged/);
  });

  it("keeps going when one repo of several is unreachable", async () => {
    const good = repo();
    const bad = repo({ id: "repo:chrispezza/other", name: "other" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("api.github.com/graphql")) {
          const vars = (JSON.parse(String(init?.body)) as { variables: { name: string } }).variables;
          if (vars.name === "other") return new Response("boom", { status: 503 });
          return Response.json({
            data: { repository: { issues: { totalCount: 1, nodes: [issue(80, "real bug")] } } },
          });
        }
        return Response.json({ model: "jev-latest", answers: { issue_80: { score: 2, confidence: 0.9 } } });
      }),
    );
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([good, bad]));
    expect(result.signals.filter((s) => s.metric === "judge.issue_tier")).toHaveLength(1);
    expect(result.notes?.join(" ")).toContain("not judged");
  });

  it("declares every metric it emits", async () => {
    stubUpstreams({ issues: [issue(90, "x")] });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    for (const s of result.signals) expect(judge.metricSemantics[s.metric]).toBe("state");
  });
});

describe("tierFromScore", () => {
  it("rounds Score's fractional position onto a tier and clamps it", () => {
    expect(tierFromScore(0).tier).toBe("none");
    expect(tierFromScore(1.4).tier).toBe("p2");
    expect(tierFromScore(1.6).tier).toBe("p1");
    expect(tierFromScore(2.5).tier).toBe("p0");
    expect(tierFromScore(-4).index).toBe(0);
    expect(tierFromScore(99).index).toBe(3);
  });
});

describe("advisory contract (ADR-006)", () => {
  const seed = async (metric: string, severity: 0 | 3) => {
    await upsertEntities(env.DB, [{ id: "repo:a/b", kind: "repo", name: "b" }], NOW);
    await insertSignals(env.DB, "judge", [
      { entityId: "repo:a/b", metric, valueNum: 4, severity, observedAt: NOW, dedupeKey: "k" },
    ]);
  };

  it("shows judge.* on /findings even though it sits below the severity floor", async () => {
    await seed("judge.issue_tier", 0);
    const rows = await findings(env.DB, { minSeverity: 2 });
    expect(rows.map((r) => r.metric)).toContain("judge.issue_tier");
  });

  it("still filters judge.* by the domain prefix like any other domain", async () => {
    await seed("judge.issue_tier", 0);
    expect(await findings(env.DB, { minSeverity: 0, domain: "ci" })).toHaveLength(0);
    expect(await findings(env.DB, { minSeverity: 0, domain: "judge" })).toHaveLength(1);
  });

  it("contributes nothing to the triage score", () => {
    const sig = (metric: string, severity: number): SignalRow => ({
      id: 1,
      entity_id: "repo:a/b",
      source: "judge",
      metric,
      value_num: 9,
      value_text: null,
      severity,
      url: null,
      observed_at: NOW,
      period_start: null,
      period_end: null,
      dedupe_key: "k",
    });
    const view: EntityView = {
      id: "repo:a/b",
      kind: "repo",
      category: "web_app",
      name: "b",
      owner: null,
      source_url: null,
      last_seen_at: NOW,
      latest: {
        "judge.issue_tier": sig("judge.issue_tier", 0),
        "repo.pushed_at": { ...sig("repo.pushed_at", 0), value_num: NOW },
      },
      maxSeverity: 0,
    };
    // ADR-006 rule 5: drop the judge rows and nothing else moves.
    const withJudge = computeScore(view, NOW, null);
    const { "judge.issue_tier": _dropped, ...rest } = view.latest;
    const withoutJudge = computeScore({ ...view, latest: rest }, NOW, null);
    expect(withJudge.total).toBe(withoutJudge.total);
    expect(withJudge.parts).toEqual(withoutJudge.parts);
  });
});
