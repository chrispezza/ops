import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findings } from "../src/core/queries";
import { computeScore } from "../src/core/score";
import type { EntityView, SignalRow } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";
import { extendSpan, judge, tierFromChoice } from "../src/pollers/judge";
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

// The judge reads its own cursor off the `poller:judge` entity, so the fake ctx
// has to serve both kinds the poller asks for.
const ctxOf = (entities: KnownEntity[], cursors?: Record<string, unknown>) => ({
  listEntities: async (kind?: string) => {
    if (kind === "poller") {
      return cursors
        ? [
            {
              id: "poller:judge",
              kind: "poller",
              category: null,
              name: "judge",
              metadata: { cursors },
              archived: false,
            } satisfies KnownEntity,
          ]
        : [];
    }
    return entities;
  },
});

// Labels carry provenance: the timeline says who applied each one. Default is a
// human, so a fixture reads as "the maintainer labelled this" unless it says
// otherwise.
const HUMAN = { login: "chrispezza", __typename: "User" };
// wrangler.jsonc names "claude" as the reference actor; GraphQL spells the App
// without the [bot] suffix, REST with it, and both must match.
const CLAUDE_APP = { login: "claude[bot]", __typename: "Bot" };
const OTHER_BOT = { login: "dependabot", __typename: "Bot" };

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
  issues?: ReturnType<typeof issue>[];
  pages?: ReturnType<typeof issue>[][];
  total?: number;
  // Issue number -> the tier Jev answers with. Default p1 at high confidence.
  tiers?: Record<number, { choice: string; confidence: number }>;
  jevStatus?: number;
  githubStatus?: number;
  // Every page claims another one behind it, so the read is never "complete".
  alwaysMore?: boolean;
}

// Captures every Jev request body so a test can assert what actually left the
// deployment — the blind-calibration guarantee is only worth as much as that,
// and the one-issue-per-request rule is only worth as much as this count.
const jevRequests: { state: { issue: { ref: string; title: string; body: string } }; questions: Record<string, { type: string; criteria: Record<string, unknown> }> }[] = [];

function stubUpstreams(opts: StubOpts) {
  jevRequests.length = 0;
  const pages = opts.pages ?? [opts.issues ?? []];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("api.github.com/graphql")) {
        if (opts.githubStatus) return new Response("nope", { status: opts.githubStatus });
        const vars = (JSON.parse(String(init?.body)) as { variables: { after: string | null } }).variables;
        const index = vars.after === null ? 0 : Number(vars.after.slice(1)) + 1;
        const nodes = pages[index] ?? [];
        return Response.json({
          data: {
            repository: {
              issues: {
                totalCount: opts.total ?? pages.flat().length,
                pageInfo: {
                  hasNextPage: Boolean(opts.alwaysMore) || index < pages.length - 1,
                  endCursor: `c${index}`,
                },
                nodes,
              },
            },
          },
        });
      }
      if (url.includes("api.typesafe.ai")) {
        if (opts.jevStatus) return new Response("nope", { status: opts.jevStatus });
        const body = JSON.parse(String(init?.body)) as (typeof jevRequests)[number];
        jevRequests.push(body);
        const n = Number(body.state.issue.ref.replace("#", ""));
        const given = opts.tiers?.[n] ?? { choice: "p1", confidence: 0.9 };
        return Response.json({
          model: "jev-latest",
          answers: { tier: { type: "choice", choice: given.choice, confidence: given.confidence } },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

const signalFor = (result: PollerResult, metric: string): SignalInsert | undefined =>
  result.signals.find((s) => s.metric === metric);

// The cursor the run wants carried into the next one.
const cursorsFrom = (result: PollerResult) =>
  (result.entities.find((e) => e.id === "poller:judge")?.metadata?.cursors ?? {}) as Record<
    string,
    { low: number; high: number; open: { n: number; t: string }[] }
  >;

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
      tiers: { 1: { choice: "p1", confidence: 0.9 }, 2: { choice: "none", confidence: 0.9 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    const tier = signalFor(result, "judge.issue_tier");
    // #1 is p1 and counts; #2 is "nothing to act on"; #3 is already labelled.
    expect(tier?.valueNum).toBe(1);
    expect(tier?.valueText).toContain("#1 p1");
    expect(tier?.valueText).not.toContain("#3");
    // ADR-006 rule 1: the floor is the mechanism, so it is asserted, not assumed.
    expect(result.signals.every((s) => s.severity === 0)).toBe(true);
  });

  it("asks about one issue per request, with the tiers as choice options", async () => {
    stubUpstreams({ issues: [issue(1, "a"), issue(2, "b"), issue(3, "c")] });
    await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // The documented failure mode is a state carrying content unrelated to the
    // question, so each request carries exactly the issue being tiered.
    expect(jevRequests).toHaveLength(3);
    // Newest first: the backlog is walked down from the top of the issue list.
    expect(jevRequests.map((r) => r.state.issue.ref)).toEqual(["#3", "#2", "#1"]);
    for (const request of jevRequests) {
      expect(Object.keys(request.questions)).toEqual(["tier"]);
      expect(request.questions.tier?.type).toBe("choice");
      expect(Object.keys(request.questions.tier?.criteria ?? {})).toEqual(["none", "p2", "p1", "p0"]);
    }
  });

  it("judges an issue once and never pays for it again", async () => {
    stubUpstreams({ issues: [issue(1, "crash on save"), issue(2, "typo")] });
    const first = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    expect(jevRequests).toHaveLength(2);
    const cursors = cursorsFrom(first);
    expect(cursors["repo:chrispezza/ops"]).toMatchObject({ low: 1, high: 2 });

    // Same issues, second night, carrying the cursor the first run produced.
    stubUpstreams({ issues: [issue(1, "crash on save"), issue(2, "typo")] });
    const second = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));
    expect(jevRequests).toHaveLength(0);
    // And the proposal is still reported: judge.issue_tier is outstanding work,
    // not "what I looked at last night".
    expect(signalFor(second, "judge.issue_tier")?.valueNum).toBe(2);
    expect(signalFor(second, "judge.issue_tier")?.valueText).toContain("#1 p1");
  });

  it("judges an issue opened above the span, and one left below it", async () => {
    const cursors = { "repo:chrispezza/ops": { low: 5, high: 8, open: [] } };
    stubUpstreams({
      issues: [issue(9, "brand new"), issue(7, "already judged"), issue(4, "backlog")],
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));

    expect(jevRequests.map((r) => r.state.issue.ref).sort()).toEqual(["#4", "#9"]);
    expect(cursorsFrom(result)["repo:chrispezza/ops"]).toMatchObject({ low: 4, high: 9 });
  });

  it("does not fail the run when everything has already been judged", async () => {
    const cursors = { "repo:chrispezza/ops": { low: 1, high: 2, open: [] } };
    stubUpstreams({ issues: [issue(1, "a"), issue(2, "b")] });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));

    // Steady state: no model call, no verdicts, and emphatically not a failure.
    expect(jevRequests).toHaveLength(0);
    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(0);
  });

  it("drops an outstanding proposal once the issue is tiered for real", async () => {
    const cursors = {
      "repo:chrispezza/ops": { low: 1, high: 1, open: [{ n: 1, t: "p1", c: 0.9, s: "crash on save" }] },
    };
    stubUpstreams({ issues: [issue(1, "crash on save", ["p1"])] });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));

    // The maintainer acted on it, so there is nothing left to propose.
    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(0);
    expect(cursorsFrom(result)["repo:chrispezza/ops"]?.open).toEqual([]);
  });

  it("keeps an outstanding proposal for an issue below the pages it read", async () => {
    const cursors = {
      "repo:chrispezza/ops": { low: 50, high: 60, open: [{ n: 3, t: "p0", c: 0.9, s: "old and urgent" }] },
    };
    // #3 is nowhere in this window, and the window does not reach the bottom.
    stubUpstreams({ issues: [issue(60, "recent", ["p1"])], alwaysMore: true, total: 90 });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));

    // Absence below the last page read proves nothing, so it is not dropped.
    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(1);
    expect(signalFor(result, "judge.issue_tier")?.valueText).toContain("#3 p0");
  });

  it("does not extend the span over an issue whose verdict never arrived", async () => {
    stubUpstreams({ issues: [issue(9, "answered"), issue(8, "unanswerable")], tiers: { 8: { choice: "nonsense", confidence: 0.9 } } });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // #8 got no usable verdict, so the span stops above it and the next run retries.
    expect(cursorsFrom(result)["repo:chrispezza/ops"]).toMatchObject({ low: 9, high: 9 });
    expect(result.notes?.join(" ")).toContain("named no known tier");
  });

  it("grades itself against the maintainer's labels on a blind sample", async () => {
    stubUpstreams({
      issues: [issue(10, "data loss on sync", ["p0"]), issue(11, "button misaligned", ["p2"])],
      // p0 is severity 3 and the judge says p0 — exact. p2 is severity 1 and the
      // judge says p1 (2) — within one tier, but not exact.
      tiers: { 10: { choice: "p0", confidence: 0.9 }, 11: { choice: "p1", confidence: 0.9 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    const agreement = signalFor(result, "judge.tier_agreement");
    expect(agreement?.valueNum).toBe(50);
    expect(agreement?.valueText).toBe("1 of 2 exact · 2 within one tier · 2 human-labelled, 0 reference-labelled");
    const human = signalFor(result, "judge.tier_agreement_human");
    expect(human?.valueNum).toBe(50);
    expect(human?.valueText).toBe("1 of 2 exact · 2 within one tier · human-labelled sample");
  });

  it("keeps re-judging the calibration sample even when everything is in the span", async () => {
    const cursors = { "repo:chrispezza/ops": { low: 10, high: 11, open: [] } };
    stubUpstreams({
      issues: [issue(10, "data loss", ["p0"]), issue(11, "misaligned", ["p2"])],
      tiers: { 10: { choice: "p0", confidence: 0.9 }, 11: { choice: "p2", confidence: 0.9 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));

    // Calibration measures the model, not the issue, so a fresh sample is the point.
    expect(jevRequests).toHaveLength(2);
    expect(signalFor(result, "judge.tier_agreement")?.valueNum).toBe(100);
  });

  it("refuses to grade itself against labels an unnamed automation applied", async () => {
    stubUpstreams({
      issues: [
        issue(12, "data loss on sync", ["p0"], "detail", OTHER_BOT),
        issue(13, "button misaligned", ["p2"], "detail", OTHER_BOT),
      ],
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // Both labels came from a bot that is not a reference actor. Agreeing with
    // them would be two models agreeing, so there is no number to report.
    const agreement = signalFor(result, "judge.tier_agreement");
    expect(agreement?.valueNum).toBeUndefined();
    expect(agreement?.valueText).toBe("no human- or reference-labelled issues to compare against");
    expect(signalFor(result, "judge.tier_agreement_human")?.valueNum).toBeUndefined();
    expect(result.notes?.join(" ")).toContain("2 issue(s) excluded from calibration");
  });

  it("grades itself against the reference actor's labels and says which kind it had", async () => {
    stubUpstreams({
      issues: [
        issue(12, "data loss on sync", ["p0"], "detail", CLAUDE_APP),
        issue(13, "button misaligned", ["p2"], "detail", CLAUDE_APP),
      ],
      tiers: { 12: { choice: "p0", confidence: 0.9 }, 13: { choice: "p2", confidence: 0.9 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    const agreement = signalFor(result, "judge.tier_agreement");
    expect(agreement?.valueNum).toBe(100);
    expect(agreement?.valueText).toBe("2 of 2 exact · 2 within one tier · 0 human-labelled, 2 reference-labelled");
    // The human-only metric stays honest: nothing here came from a person.
    const human = signalFor(result, "judge.tier_agreement_human");
    expect(human?.valueNum).toBeUndefined();
    expect(human?.valueText).toBe("no human-labelled issues to compare against");
    // Neither reference tier has been reviewed, so the reference is ungraded too.
    const reference = signalFor(result, "judge.reference_agreement");
    expect(reference?.valueNum).toBeUndefined();
    expect(reference?.valueText).toBe("no reference tiers reviewed yet");
  });

  it("lets a human override win over the reference tier, and counts it against the reference", async () => {
    const overridden = {
      ...issue(14, "silent deploy stop", ["p2", "p1"]),
      timelineItems: {
        nodes: [
          { label: { name: "p2" }, actor: CLAUDE_APP },
          { label: { name: "p1" }, actor: HUMAN },
        ],
      },
    };
    stubUpstreams({ issues: [overridden], tiers: { 14: { choice: "p1", confidence: 0.9 } } });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    // Ground truth is the human's p1 (severity 2); the judge said p1 — exact.
    expect(signalFor(result, "judge.tier_agreement")?.valueText).toBe(
      "1 of 1 exact · 1 within one tier · 1 human-labelled, 0 reference-labelled",
    );
    const reference = signalFor(result, "judge.reference_agreement");
    expect(reference?.valueNum).toBe(0);
    expect(reference?.valueText).toBe("0 of 1 reviewed reference tiers stood · 1 overridden");
  });

  it("treats a human `triaged` label as accepting the reference tier", async () => {
    const accepted = {
      ...issue(15, "reviewed and left standing", ["p1", "triaged"]),
      timelineItems: {
        nodes: [
          { label: { name: "p1" }, actor: CLAUDE_APP },
          { label: { name: "triaged" }, actor: HUMAN },
        ],
      },
    };
    stubUpstreams({ issues: [accepted], tiers: { 15: { choice: "p2", confidence: 0.9 } } });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    const reference = signalFor(result, "judge.reference_agreement");
    expect(reference?.valueNum).toBe(100);
    expect(reference?.valueText).toBe("1 of 1 reviewed reference tiers stood · 0 overridden");
    // `triaged` is not a severity label, so the truth is still the reference's p1
    // and the judge's p2 verdict is one tier off.
    expect(signalFor(result, "judge.tier_agreement")?.valueText).toBe(
      "0 of 1 exact · 1 within one tier · 0 human-labelled, 1 reference-labelled",
    );
  });

  it("restores the human-only rule exactly when JUDGE_REFERENCE_ACTORS is empty", async () => {
    stubUpstreams({
      issues: [issue(16, "data loss on sync", ["p0"], "detail", CLAUDE_APP)],
      tiers: { 16: { choice: "p0", confidence: 0.9 } },
    });
    const result = await judge.poll(
      { ...env, ...KEY, JUDGE_REFERENCE_ACTORS: "" } as unknown as Env,
      ctxOf([repo()]),
    );
    expect(signalFor(result, "judge.tier_agreement")?.valueNum).toBeUndefined();
    expect(signalFor(result, "judge.reference_agreement")).toBeUndefined();
    expect(result.notes?.join(" ")).toContain("JUDGE_REFERENCE_ACTORS unset");
  });

  it("still treats an automation-labelled issue as tiered, so it gets no proposal", async () => {
    stubUpstreams({
      issues: [issue(14, "already triaged by the routine", ["p1"], "detail", CLAUDE_APP)],
      tiers: { 14: { choice: "p0", confidence: 0.95 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    // issues.flagged already sees a p1 whoever applied it — proposing again is noise.
    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(0);
  });

  it("honours JUDGE_CALIBRATION_EXCLUDE for automations running under a person's PAT", async () => {
    const robot = { login: "ops-routine", __typename: "User" };
    stubUpstreams({
      issues: [issue(15, "labelled by a PAT-driven routine", ["p0"], "detail", robot)],
      tiers: { 15: { choice: "p0", confidence: 0.9 } },
    });
    const result = await judge.poll(
      { ...env, ...KEY, JUDGE_CALIBRATION_EXCLUDE: "ops-routine" } as unknown as Env,
      ctxOf([repo()]),
    );
    expect(signalFor(result, "judge.tier_agreement")?.valueNum).toBeUndefined();
    expect(signalFor(result, "judge.tier_agreement_human")?.valueNum).toBeUndefined();
  });

  it("ignores a severity label that was applied and later removed", async () => {
    const removed = {
      ...issue(16, "label since removed", [], "detail"),
      // timeline remembers the LABELED_EVENT; the issue no longer carries it
      timelineItems: { nodes: [{ label: { name: "p0" }, actor: HUMAN }] },
    };
    stubUpstreams({ issues: [removed], tiers: { 16: { choice: "p1", confidence: 0.9 } } });
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
    const states = JSON.stringify(jevRequests.map((r) => r.state));
    expect(states).toContain("broken login");
    expect(states).not.toContain("p0");
    expect(states).not.toContain("security");
    expect(states).not.toContain("labels");
  });

  it("drops verdicts below the confidence floor and says so in notes", async () => {
    stubUpstreams({
      issues: [issue(30, "maybe a bug"), issue(31, "definitely a bug")],
      tiers: { 30: { choice: "p0", confidence: 0.4 }, 31: { choice: "p0", confidence: 0.95 } },
    });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    expect(signalFor(result, "judge.issue_tier")?.valueNum).toBe(1);
    expect(result.notes?.join(" ")).toContain("confidence floor");
  });

  it("reports a truncated read instead of capping silently", async () => {
    stubUpstreams({ issues: [issue(40, "one")], total: 99, alwaysMore: true });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    expect(result.notes?.join(" ")).toContain("read 1 of 99 open issues");
  });

  it("caps proposals per repo and says how many it left", async () => {
    const many = Array.from({ length: 20 }, (_, i) => issue(100 - i, `issue ${100 - i}`));
    stubUpstreams({ issues: many });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));

    expect(jevRequests).toHaveLength(12);
    expect(result.notes?.join(" ")).toContain("tiered 12 of 20 untiered issues");
    // The span covers exactly what was judged, newest-first, so the next run
    // picks up where this one stopped.
    expect(cursorsFrom(result)["repo:chrispezza/ops"]).toMatchObject({ low: 89, high: 100 });
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

  it("fails the run when there was something to judge and no verdict came back", async () => {
    stubUpstreams({ issues: [issue(70, "x")], jevStatus: 500 });
    // A calm note here would leave poller.last_ok marching forward over a judge
    // that judged nothing.
    await expect(judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]))).rejects.toThrow(
      /no verdict could be obtained/,
    );
  });

  it("fails the run when no repo could even be read", async () => {
    stubUpstreams({ issues: [issue(70, "x")], githubStatus: 503 });
    await expect(judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]))).rejects.toThrow(/no repo could be read/);
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
            data: {
              repository: {
                issues: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [issue(80, "real bug")],
                },
              },
            },
          });
        }
        return Response.json({ answers: { tier: { type: "choice", choice: "p1", confidence: 0.9 } } });
      }),
    );
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([good, bad]));
    expect(result.signals.filter((s) => s.metric === "judge.issue_tier")).toHaveLength(1);
    expect(result.notes?.join(" ")).toContain("not judged");
  });

  it("carries a skipped repo's cursor forward instead of forgetting it", async () => {
    const good = repo();
    const bad = repo({ id: "repo:chrispezza/other", name: "other" });
    const cursors = { "repo:chrispezza/other": { low: 1, high: 9, open: [] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("api.github.com/graphql")) {
          const vars = (JSON.parse(String(init?.body)) as { variables: { name: string } }).variables;
          if (vars.name === "other") return new Response("boom", { status: 503 });
          return Response.json({
            data: {
              repository: {
                issues: {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [issue(1, "a")],
                },
              },
            },
          });
        }
        return Response.json({ answers: { tier: { type: "choice", choice: "p1", confidence: 0.9 } } });
      }),
    );
    // The unreachable repo must keep its cursor, or it re-judges its whole
    // backlog the moment GitHub comes back.
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([good, bad], cursors));
    expect(cursorsFrom(result)["repo:chrispezza/other"]).toMatchObject({ low: 1, high: 9 });
  });

  it("forgets the cursor of a repo Ops no longer tracks", async () => {
    const cursors = { "repo:chrispezza/gone": { low: 1, high: 9, open: [] } };
    stubUpstreams({ issues: [issue(1, "a")] });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()], cursors));
    expect(cursorsFrom(result)["repo:chrispezza/gone"]).toBeUndefined();
  });

  it("declares every metric it emits", async () => {
    stubUpstreams({ issues: [issue(90, "x")] });
    const result = await judge.poll({ ...env, ...KEY } as Env, ctxOf([repo()]));
    for (const s of result.signals) expect(judge.metricSemantics[s.metric]).toBe("state");
  });
});

describe("tierFromChoice", () => {
  it("maps an option name onto the LABEL_SEVERITY scale", () => {
    expect(tierFromChoice("none")).toEqual({ index: 0, tier: "none" });
    expect(tierFromChoice("p2")).toEqual({ index: 1, tier: "p2" });
    expect(tierFromChoice("p1")).toEqual({ index: 2, tier: "p1" });
    expect(tierFromChoice("p0")).toEqual({ index: 3, tier: "p0" });
  });

  it("returns nothing for an answer that names no tier", () => {
    expect(tierFromChoice("urgent")).toBeNull();
    expect(tierFromChoice(undefined)).toBeNull();
  });
});

describe("extendSpan", () => {
  const set = (...ns: number[]) => new Set(ns);

  it("anchors a first run at the newest issue and walks down", () => {
    expect(extendSpan(undefined, [1, 2, 3, 4], set(2, 3, 4))).toEqual({ low: 2, high: 4 });
  });

  it("gives up on a first run whose newest issue was never settled", () => {
    expect(extendSpan(undefined, [1, 2, 3], set(1, 2))).toBeUndefined();
  });

  it("extends upward over new issues and stops at the first gap", () => {
    expect(extendSpan({ low: 5, high: 8 }, [5, 6, 7, 8, 9, 10, 11], set(9, 10))).toEqual({ low: 5, high: 10 });
  });

  it("extends downward over the backlog and stops at the first gap", () => {
    expect(extendSpan({ low: 5, high: 8 }, [1, 2, 3, 4, 5], set(4, 3))).toEqual({ low: 3, high: 8 });
  });

  it("leaves the span alone when nothing adjacent was settled", () => {
    expect(extendSpan({ low: 5, high: 8 }, [1, 9], set())).toEqual({ low: 5, high: 8 });
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
