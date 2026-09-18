import { LABEL_SEVERITY, tokenForOwner } from "./github";
import type { KnownEntity, Poller, PollerResult, SignalInsert } from "./types";

// Advisory issue tiering (ADR-006). Jev reads open issues that carry no
// severity label and proposes the label a maintainer would have applied. The
// proposal is stored at severity 0 and nothing downstream acts on it: the loop
// closes in GitHub, where a human or the weekly agent pass applies a real
// label, the hourly github poller reads it back as issues.flagged at real
// severity, and judge.tier_agreement grades how often the proposal matched.
// Ops never writes the label itself (ADR-001).

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

// Index == the severity github.ts's LABEL_SEVERITY assigns the same label, so a
// verdict lands in the maintainer's own vocabulary instead of a second scale
// nothing can act on. Ordered low → high, which is what Score's criteria want.
const TIERS = ["none", "p2", "p1", "p0"] as const;
type Tier = (typeof TIERS)[number];

// Score returns a probability-weighted position on this spectrum, so the levels
// have to be separable by reading the issue alone — no repo-specific knowledge,
// no reference to labels (the calibration set is judged blind, see below).
const CRITERIA = [
  "Nothing to act on: a question, a discussion, a duplicate, or a note that needs no change to the software.",
  "Minor: cosmetic, a nice-to-have, or a papercut that has an easy workaround.",
  "A real defect or a wanted change that affects normal use, with no data loss and no security exposure.",
  "Urgent: a security exposure, data loss, or the project is broken for everyone using it.",
];

// Below this the verdict is dropped rather than shown as a proposal. An
// advisory signal that reports coin-flips as suggestions is worse than silent;
// the count of dropped verdicts goes in notes so the gap stays visible.
const MIN_CONFIDENCE = 0.6;

// Caps, all reported in notes when they bite (poller contract: no silent caps).
const UNLABELED_CAP = 25; // proposals per repo per run — the useful output
const LABELED_CAP = 10; // blind calibration sample per repo per run
const ISSUE_FETCH = 60; // open issues read per repo before partitioning
const QUESTIONS_PER_REQUEST = 20; // Score evaluates questions in parallel on one state
const MAX_REPOS = 30; // bounds subrequests in a single cron invocation
const BODY_CHARS = 1500; // per issue, to bound request size

const DAY = 86_400;

// Labels github.ts already grades. "Unlabeled" here means "carries none of
// these" — an issue labeled `documentation` is still untiered, and those are
// exactly the ones issues.flagged cannot see.
const severityLabels = () => Object.keys(LABEL_SEVERITY);
const unlabeledQuery = () =>
  `is:issue is:open ${severityLabels().map((l) => `-label:${l}`).join(" ")} sort:created-desc`;
const labeledQuery = () => `is:issue is:open label:${severityLabels().join(",")}`;

interface IssueNode {
  number: number;
  title: string;
  body: string | null;
  labels?: { nodes: { name: string }[] };
}

interface RepoIssuesPage {
  data?: { repository: { issues: { totalCount: number; nodes: IssueNode[] } } | null };
  errors?: { message: string }[];
}

// Newest-created first, deliberately not newest-updated. Both orders put fresh
// intake at the top, but createdAt never changes, so the window past ISSUE_FETCH
// only moves when an issue is opened or closed. Ordering by updatedAt would let
// a comment on an old issue push another out of the window, and judge.issue_tier
// would drop by one with nothing having been triaged.
const ISSUES_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $first: Int!) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: $first, orderBy: { field: CREATED_AT, direction: DESC }) {
        totalCount
        nodes {
          number
          title
          body
          labels(first: 20) {
            nodes {
              name
            }
          }
        }
      }
    }
  }
`;

async function fetchIssues(pat: string, owner: string, name: string): Promise<{ total: number; nodes: IssueNode[] }> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
      "user-agent": "ops-dashboard",
    },
    body: JSON.stringify({ query: ISSUES_QUERY, variables: { owner, name, first: ISSUE_FETCH } }),
  });
  if (!res.ok) throw new Error(`judge: github HTTP ${res.status} for ${owner}/${name}`);
  const page = (await res.json()) as RepoIssuesPage;
  const conn = page.data?.repository?.issues;
  if (!conn) {
    if (page.errors?.length) throw new Error(`judge: github: ${page.errors[0]?.message}`);
    throw new Error(`judge: github returned no issues for ${owner}/${name}`);
  }
  return { total: conn.totalCount, nodes: conn.nodes };
}

// The severity github.ts would assign this issue from its labels, or null when
// it carries none that LABEL_SEVERITY recognises.
export function labelSeverity(issue: IssueNode): number | null {
  const graded = (issue.labels?.nodes ?? [])
    .map((l) => LABEL_SEVERITY[l.name.toLowerCase()])
    .filter((s): s is 1 | 2 | 3 => s !== undefined);
  return graded.length > 0 ? Math.max(...graded) : null;
}

export interface Verdict {
  index: number; // 0..3 — same scale as LABEL_SEVERITY
  tier: Tier;
  confidence: number;
}

interface ScoreAnswer {
  type?: string;
  score?: number;
  confidence?: number;
}

interface JevResponse {
  answers?: Record<string, ScoreAnswer>;
}

const questionId = (n: number) => `issue_${n}`;
const truncate = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? ""));

// Score's `score` is fractional — a probability-weighted position across the
// levels, not an index — so it is rounded onto the nearest tier and clamped.
export function tierFromScore(score: number): { index: number; tier: Tier } {
  const index = Math.min(TIERS.length - 1, Math.max(0, Math.round(score)));
  return { index, tier: TIERS[index] as Tier };
}

async function askJev(key: string, issues: IssueNode[]): Promise<Map<number, Verdict>> {
  const verdicts = new Map<number, Verdict>();
  for (let i = 0; i < issues.length; i += QUESTIONS_PER_REQUEST) {
    const batch = issues.slice(i, i + QUESTIONS_PER_REQUEST);
    // One state, many questions: Score evaluates them in parallel, which keeps
    // a repo's pass to one subrequest instead of one per issue. Labels are
    // deliberately absent from the state — the calibration sample is only
    // meaningful if the judge never saw the answer.
    const state = {
      context: "Open issues from a software repository, to be tiered as the maintainer would tier them.",
      issues: batch.map((issue) => ({
        ref: `#${issue.number}`,
        title: issue.title,
        body: truncate(issue.body, BODY_CHARS),
      })),
    };
    const questions: Record<string, unknown> = {};
    for (const issue of batch) {
      questions[questionId(issue.number)] = {
        type: "score",
        instructions: `Issue #${issue.number} ("${issue.title}"): how urgently must the maintainer act on it?`,
        criteria: CRITERIA,
      };
    }

    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(JEV_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      });
      // 429 and 529 are TypeSafe's documented back-pressure codes; everything
      // else is either fine or a real error that a retry will not fix.
      if (res.status !== 429 && res.status !== 529 && res.status < 500) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    if (!res || !res.ok) throw new Error(`judge: jev HTTP ${res?.status}`);
    const body = (await res.json()) as JevResponse;
    for (const issue of batch) {
      const answer = body.answers?.[questionId(issue.number)];
      if (!answer || typeof answer.score !== "number" || !Number.isFinite(answer.score)) continue;
      const { index, tier } = tierFromScore(answer.score);
      verdicts.set(issue.number, { index, tier, confidence: answer.confidence ?? 0 });
    }
  }
  return verdicts;
}

// "all" judges every tracked repo on title + body. "titles" withholds private
// repos' bodies; "public" skips private repos entirely. Issue text leaves the
// deployment either way, so the knob is a var (ADR-004), not a code change.
type Scope = "all" | "titles" | "public";
const parseScope = (raw: string | undefined): Scope =>
  raw === "titles" || raw === "public" ? raw : "all";

const isPrivate = (entity: KnownEntity): boolean => entity.metadata?.private === true;

export const judge: Poller = {
  id: "judge",
  // Daily, not hourly: issues do not change hourly, the verdict costs a model
  // call, and a poller cannot read back what it already judged (the contract
  // gives it listEntities and nothing else), so every run re-judges from
  // scratch. Daily makes that affordable instead of wasteful.
  schedule: "daily",
  metricSemantics: {
    "judge.issue_tier": "state",
    "judge.tier_agreement": "state",
  },
  async poll(env, ctx): Promise<PollerResult> {
    const key = env.TYPESAFE_API_KEY;
    if (!key) throw new Error("unconfigured: set the TYPESAFE_API_KEY secret to enable this poller");

    const scope = parseScope(env.JUDGE_SCOPE);
    const now = Math.floor(Date.now() / 1000);
    const dayBucket = String(now - (now % DAY));
    const signals: SignalInsert[] = [];
    const notes: string[] = [];

    const all = (await ctx.listEntities("repo")).filter((e) => !e.archived);
    const inScope = scope === "public" ? all.filter((e) => !isPrivate(e)) : all;
    if (scope === "public" && inScope.length < all.length) {
      notes.push(`JUDGE_SCOPE=public: skipped ${all.length - inScope.length} private repo(s)`);
    }
    const repos = inScope.slice(0, MAX_REPOS);
    if (inScope.length > repos.length) {
      notes.push(`judged ${repos.length} of ${inScope.length} tracked repos (MAX_REPOS)`);
    }
    if (repos.length === 0) {
      notes.push("no repos to judge yet — the github poller populates the list");
      return { entities: [], signals, notes };
    }

    let lowConfidence = 0;
    let withheldBodies = 0;
    let attempted = 0;
    let judged = 0;
    for (const entity of repos) {
      const ref = entity.id.replace(/^repo:/, "");
      const [owner, name] = ref.split("/");
      if (!owner || !name) continue;
      const pat = tokenForOwner(env, owner);
      if (!pat) {
        notes.push(`${ref}: no PAT for owner ${owner} — not judged`);
        continue;
      }
      const repoUrl = `https://github.com/${ref}`;
      attempted++;
      let total: number;
      let nodes: IssueNode[];
      try {
        ({ total, nodes } = await fetchIssues(pat, owner, name));
      } catch (err) {
        // One unreachable repo must not cost the whole pass. A GitHub outage is
        // already the github poller's failure to report; repeating it here would
        // just double-count it.
        notes.push(`${ref}: not judged — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (total > nodes.length) notes.push(`${ref}: read ${nodes.length} of ${total} open issues`);

      const withSeverity = nodes.map((issue) => ({ issue, labelled: labelSeverity(issue) }));
      const unlabelled = withSeverity.filter((r) => r.labelled === null).map((r) => r.issue);
      const labelled = withSeverity.filter((r) => r.labelled !== null);
      if (unlabelled.length > UNLABELED_CAP) {
        notes.push(`${ref}: proposed tiers for ${UNLABELED_CAP} of ${unlabelled.length} unlabelled issues`);
      }
      if (labelled.length > LABELED_CAP) {
        notes.push(`${ref}: calibrated against ${LABELED_CAP} of ${labelled.length} labelled issues`);
      }
      const toPropose = unlabelled.slice(0, UNLABELED_CAP);
      const toCalibrate = labelled.slice(0, LABELED_CAP);

      // JUDGE_SCOPE=titles: a private repo's issue bodies never leave the
      // deployment. Titles alone still tier usefully; the verdicts are just
      // less confident, which the confidence floor already accounts for.
      const withhold = scope === "titles" && isPrivate(entity);
      if (withhold) withheldBodies++;
      const forJev = (issue: IssueNode): IssueNode => (withhold ? { ...issue, body: null } : issue);
      let verdicts: Map<number, Verdict>;
      try {
        verdicts = await askJev(key, [...toPropose, ...toCalibrate.map((r) => r.issue)].map(forJev));
      } catch (err) {
        notes.push(`${ref}: not judged — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      judged++;

      // Proposals: unlabelled issues the judge puts at p1 or worse, confidently.
      // Anything calmer is not worth a maintainer's attention as a suggestion.
      const proposals = toPropose
        .map((issue) => ({ issue, verdict: verdicts.get(issue.number) }))
        .filter((p): p is { issue: IssueNode; verdict: Verdict } => {
          if (!p.verdict) return false;
          if (p.verdict.index < 2) return false;
          // Counted only when the floor actually changed the outcome — a
          // low-confidence "nothing to act on" was never going to be shown, and
          // counting it would inflate the note into noise.
          if (p.verdict.confidence < MIN_CONFIDENCE) {
            lowConfidence++;
            return false;
          }
          return true;
        })
        .sort((a, b) => b.verdict.index - a.verdict.index || a.issue.number - b.issue.number);

      signals.push({
        entityId: entity.id,
        metric: "judge.issue_tier",
        valueNum: proposals.length,
        // Jev is decision-only — there is no generated rationale to show, so the
        // text carries the proposed label and the model's own confidence and
        // stops there. The issue itself is the record (ADR-001).
        valueText:
          proposals.length > 0
            ? proposals
                .slice(0, 5)
                .map(
                  (p) =>
                    `#${p.issue.number} ${p.verdict.tier} (${p.verdict.confidence.toFixed(2)}) ${
                      p.issue.title.length > 60 ? `${p.issue.title.slice(0, 57)}…` : p.issue.title
                    }`,
                )
                .join(" · ")
            : undefined,
        // ADR-006: judge.* is advisory and carries no weight, ever. Severity 0
        // is what keeps it out of computeScore, notifyNewAlerts and the
        // digest's raised/resolved — it is the mechanism, not a default.
        severity: 0,
        url: `${repoUrl}/issues?q=${encodeURIComponent(unlabeledQuery())}`,
        observedAt: now,
        dedupeKey: dayBucket,
      });

      // Calibration: the blind sample, scored against the maintainer's labels.
      // This is what has to be graded before judge.* earns any more surface.
      // Low-confidence verdicts are graded here rather than dropped: excluding
      // the judge's own uncertain answers would flatter the agreement number.
      const compared = toCalibrate
        .map((r) => ({ expected: r.labelled as number, verdict: verdicts.get(r.issue.number) }))
        .filter((c): c is { expected: number; verdict: Verdict } => c.verdict !== undefined);
      const exact = compared.filter((c) => c.verdict.index === c.expected).length;
      const within = compared.filter((c) => Math.abs(c.verdict.index - c.expected) <= 1).length;
      signals.push({
        entityId: entity.id,
        metric: "judge.tier_agreement",
        valueNum: compared.length > 0 ? Math.round((exact / compared.length) * 100) : undefined,
        valueText:
          compared.length > 0
            ? `${exact} of ${compared.length} exact · ${within} within one tier`
            : "no labelled issues to compare against",
        severity: 0,
        url: `${repoUrl}/issues?q=${encodeURIComponent(labeledQuery())}`,
        observedAt: now,
        dedupeKey: dayBucket,
      });
    }

    // Partial failure is a coverage caveat (notes -> calm severity 1 on /health);
    // total failure is a failure. Swallowing the second would leave poller.last_ok
    // marching forward while nothing was ever judged, which reads as healthy.
    if (attempted > 0 && judged === 0) {
      throw new Error(`judge: no repo could be judged (${attempted} attempted) — ${notes.join("; ")}`);
    }
    if (lowConfidence > 0) {
      notes.push(`${lowConfidence} verdict(s) dropped below the ${MIN_CONFIDENCE} confidence floor`);
    }
    if (withheldBodies > 0) {
      notes.push(`JUDGE_SCOPE=titles: issue bodies withheld for ${withheldBodies} private repo(s)`);
    }

    return { entities: [], signals, ...(notes.length ? { notes } : {}) } satisfies PollerResult;
  },
};
