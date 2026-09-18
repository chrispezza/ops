import { LABEL_SEVERITY, tokenForOwner } from "./github";
import type { EntityUpsert, KnownEntity, Poller, PollerResult, SignalInsert } from "./types";

// Advisory issue tiering (ADR-006). Jev reads open issues that carry no
// severity label and proposes the label a maintainer would have applied. The
// proposal is stored at severity 0 and nothing downstream acts on it: the loop
// closes in GitHub, where a human or the weekly agent pass applies a real
// label, the hourly github poller reads it back as issues.flagged at real
// severity, and the agreement metrics grade how often the proposal matched —
// against the maintainer, and against the frontier-model pass that labels the
// bulk (which is itself graded against the maintainer, so the chain closes).
// Ops never writes the label itself (ADR-001).
//
// An issue is judged ONCE. What has been asked, and what is still outstanding,
// is remembered in the poller's own entity metadata (see Bookkeeping below), so
// a nightly run costs a model call only for issues that are new to it.

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

// Index == the severity github.ts's LABEL_SEVERITY assigns the same label, so a
// verdict lands in the maintainer's own vocabulary instead of a second scale
// nothing can act on. Order is load-bearing: `within one tier` in the
// calibration metrics compares these indices.
const TIERS = ["none", "p2", "p1", "p0"] as const;
type Tier = (typeof TIERS)[number];

// Choice, not Score: the tiers are four named labels, and jev-1.13's documented
// weakness is numerical calibration between score levels. Choice returns the
// option name and a probability distribution over the options, so nothing is
// lost and the fractional-score-to-index rounding step goes away.
//
// The descriptions are objects rather than strings on purpose. Jev has no
// fine-tuning — no training endpoint, no few-shot parameter — so the rubric is
// the only lever there is, and structured options are the documented way to
// use it. `not_for` carries the boundary against the neighbouring tier, which
// is where a tiering model actually goes wrong.
const CRITERIA: Record<Tier, { what: string; not_for: string; examples: string[] }> = {
  none: {
    what: "Needs no change to the software: a question, a support request, a discussion, a duplicate, or something already answered.",
    not_for: "A real defect that happens to be reported politely or vaguely. Judge what is broken, not how it is written.",
    examples: ["How do I configure the cache?", "Duplicate of #12", "Thanks — this works now"],
  },
  p2: {
    what: "Real but minor: cosmetic, a nice-to-have, a papercut with an easy workaround, or a small documentation gap.",
    not_for: "Anything that stops someone using the software as intended.",
    examples: ["Typo in the README", "Button misaligned on mobile", "Add a --quiet flag"],
  },
  p1: {
    what: "A defect or wanted change that affects normal use: something is wrong, slow or missing for people using the software as intended.",
    not_for: "Security exposure, data loss, or a total outage — those are p0. A serious bug that still has a workaround belongs here, not there.",
    examples: ["Import fails on files over 10MB", "Timestamps render in the wrong timezone", "Retry logic swallows the last error"],
  },
  p0: {
    what: "Urgent: a security exposure, data loss or corruption, or the software is broken for everyone using it.",
    not_for: "A serious bug with a workaround, which is p1.",
    examples: ["API key written to logs in plaintext", "Migration deletes rows it should keep", "Every request has 500'd since the last release"],
  },
};

// Below this the verdict is dropped rather than shown as a proposal. An
// advisory signal that reports coin-flips as suggestions is worse than silent;
// the count of dropped verdicts goes in notes so the gap stays visible.
const MIN_CONFIDENCE = 0.6;

// Caps, all reported in notes when they bite (poller contract: no silent caps).
// One issue per Jev call is the reason these are smaller than a batched design
// would need: the docs are explicit that accuracy falls as the state grows and
// that unrelated detail acts as a distractor, so nineteen other people's bug
// reports have no business sitting next to the one being tiered.
const PROPOSAL_CAP = 12; // new tier proposals per repo per run
const CALIBRATION_CAP = 5; // blind calibration sample per repo per run
const MAX_JUDGMENTS = 300; // run-wide Jev calls — the real bound on the invocation
const ISSUE_FETCH = 60; // open issues per GraphQL page
const MAX_PAGES = 4; // pages per repo, so a long backlog drains over several runs
const MAX_REPOS = 30;
const BODY_CHARS = 1500; // per issue, to bound request size
const PROPOSALS_KEPT = 15; // outstanding proposals remembered per repo

const DAY = 86_400;

// A human applying this label to an issue the reference actor tiered says "I
// looked, the tier stands". Without it, acceptance would be invisible: only
// overrides leave a human severity label behind, and grading the reference on
// overrides alone would make it look wrong every time it was checked.
const REVIEWED_LABEL = "triaged";

// Labels github.ts already grades. "Unlabeled" here means "carries none of
// these" — an issue labeled `documentation` is still untiered, and those are
// exactly the ones issues.flagged cannot see.
const severityLabels = () => Object.keys(LABEL_SEVERITY);
const unlabeledQuery = () =>
  `is:issue is:open ${severityLabels().map((l) => `-label:${l}`).join(" ")} sort:created-desc`;
const labeledQuery = () => `is:issue is:open label:${severityLabels().join(",")}`;

// ---------------------------------------------------------------------------
// Bookkeeping
//
// The poller remembers two things per repo, and both live in the metadata of
// its own `poller:judge` entity — the entity that exists so Ops can monitor
// itself with its own machinery. `ctx.listEntities` reads it back and
// `EntityUpsert.metadata` writes it, so this needs no new contract surface and
// no schema change. The entity upsert coalesces a null metadata, and
// `recordPollerStatus` upserts `poller:judge` without any, so the runner's own
// write cannot clobber this one.
//
// This is the poller's working state — what it has already asked, and what it
// is still proposing — not a derived view of stored signals. The signals remain
// the published truth (CLAUDE.md: derived things are computed, not stored).
// ---------------------------------------------------------------------------

interface Proposal {
  n: number; // issue number
  t: Tier;
  c: number; // confidence
  s: string; // short title, so an outstanding proposal can still be named after
  // it has dropped out of the pages a later run reads
}

interface RepoCursor {
  // Every open issue numbered low..high that carried no severity label at the
  // time has been judged. Two limits follow, both accepted for an advisory
  // signal: an issue whose severity label is later REMOVED stays inside the
  // span and is not re-proposed, and an issue closed during the pass and
  // reopened later is inside the span without ever having been judged.
  low: number;
  high: number;
  open: Proposal[]; // outstanding proposals, newest tier first
}

type Cursors = Record<string, RepoCursor>;

const CURSOR_ENTITY = "poller:judge";

function readCursors(entities: KnownEntity[]): Cursors {
  const self = entities.find((e) => e.id === CURSOR_ENTITY);
  const raw = self?.metadata?.cursors;
  if (!raw || typeof raw !== "object") return {};
  const out: Cursors = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const c = value as Partial<RepoCursor>;
    // Anything malformed is dropped rather than repaired: the failure mode is
    // re-judging that repo once, which is exactly the old behaviour.
    if (typeof c?.low !== "number" || typeof c.high !== "number") continue;
    const open = Array.isArray(c.open)
      ? (c.open as Proposal[]).filter((p) => typeof p?.n === "number" && TIERS.includes(p.t))
      : [];
    out[id] = { low: c.low, high: c.high, open };
  }
  return out;
}

interface LabeledEvent {
  label?: { name: string };
  // null when the actor's account is gone; __typename is "Bot" for a GitHub App.
  actor?: { login: string; __typename: string } | null;
}

interface IssueNode {
  number: number;
  title: string;
  body: string | null;
  labels?: { nodes: { name: string }[] };
  timelineItems?: { nodes: (LabeledEvent | Record<string, never>)[] };
}

interface RepoIssuesPage {
  data?: {
    repository: {
      issues: {
        totalCount: number;
        pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        nodes: IssueNode[];
      };
    } | null;
  };
  errors?: { message: string }[];
}

// Newest-created first, deliberately not newest-updated. Both orders put fresh
// intake at the top, but createdAt never changes, so paging down walks a stable
// list. Ordering by updatedAt would let a comment on an old issue reshuffle the
// window under the cursor, which is the one thing the cursor cannot survive.
const ISSUES_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          number
          title
          body
          labels(first: 20) {
            nodes {
              name
            }
          }
          timelineItems(itemTypes: [LABELED_EVENT], first: 50) {
            nodes {
              ... on LabeledEvent {
                label {
                  name
                }
                actor {
                  login
                  __typename
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Pages newest-first until `enough` is satisfied, the issues run out, or
// MAX_PAGES is spent. `complete` says the whole open set was read, which is
// what lets the cursor's low end be trusted all the way down.
async function fetchIssues(
  pat: string,
  owner: string,
  name: string,
  enough: (nodes: IssueNode[]) => boolean,
): Promise<{ total: number; nodes: IssueNode[]; complete: boolean }> {
  const nodes: IssueNode[] = [];
  let after: string | null = null;
  let total = 0;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
        "user-agent": "ops-dashboard",
      },
      body: JSON.stringify({ query: ISSUES_QUERY, variables: { owner, name, first: ISSUE_FETCH, after } }),
    });
    if (!res.ok) throw new Error(`judge: github HTTP ${res.status} for ${owner}/${name}`);
    const body = (await res.json()) as RepoIssuesPage;
    const conn = body.data?.repository?.issues;
    if (!conn) {
      if (body.errors?.length) throw new Error(`judge: github: ${body.errors[0]?.message}`);
      throw new Error(`judge: github returned no issues for ${owner}/${name}`);
    }
    total = conn.totalCount;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) {
      complete = true;
      break;
    }
    after = conn.pageInfo.endCursor;
    if (after === null || enough(nodes)) break;
  }
  return { total, nodes, complete };
}

// The severity github.ts would assign this issue from its labels, or null when
// it carries none that LABEL_SEVERITY recognises. Provenance is deliberately
// ignored here: this decides whether an issue is ALREADY tiered, and an issue
// carrying p1 is tiered — issues.flagged sees it — whoever applied the label.
// Proposing a tier for it again would be noise.
export function labelSeverity(issue: IssueNode): number | null {
  const graded = (issue.labels?.nodes ?? [])
    .map((l) => LABEL_SEVERITY[l.name.toLowerCase()])
    .filter((s): s is 1 | 2 | 3 => s !== undefined);
  return graded.length > 0 ? Math.max(...graded) : null;
}

type Actor = { login: string; __typename: string };

// GraphQL reports a GitHub App as login "x" and REST as "x[bot]"; a configured
// list should match either spelling.
const normalizeLogin = (login: string) => login.toLowerCase().replace(/\[bot\]$/, "");

// The labels the issue still carries that were applied by an actor the
// predicate accepts. The timeline remembers a label that was since removed, so
// membership in the current label set is checked, not just the event.
function labelsBy(issue: IssueNode, accept: (actor: Actor) => boolean): string[] {
  const current = new Set((issue.labels?.nodes ?? []).map((l) => l.name.toLowerCase()));
  return (issue.timelineItems?.nodes ?? []).flatMap((node) => {
    const event = node as LabeledEvent;
    const name = event.label?.name?.toLowerCase();
    if (!name || !current.has(name)) return [];
    return event.actor && accept(event.actor) ? [name] : [];
  });
}

const maxSeverity = (labels: string[]): number | null => {
  const graded = labels.map((l) => LABEL_SEVERITY[l]).filter((s): s is 1 | 2 | 3 => s !== undefined);
  return graded.length > 0 ? Math.max(...graded) : null;
};

// A GitHub App (the Claude app included) is actor __typename "Bot". An
// automation driving the REST API with a person's PAT is indistinguishable
// from that person here, so JUDGE_CALIBRATION_EXCLUDE names those logins.
const isHuman = (excluded: ReadonlySet<string>) => (actor: Actor) =>
  actor.__typename === "User" && !excluded.has(normalizeLogin(actor.login));
const isReference = (actors: ReadonlySet<string>) => (actor: Actor) => actors.has(normalizeLogin(actor.login));

// The severity a HUMAN assigned, or null when no severity label on the issue
// was applied by a person. This is the top of the calibration chain (ADR-006
// rule 4): the reference actor is graded against it, and the judge is graded
// against both.
export function humanLabelSeverity(issue: IssueNode, excluded: ReadonlySet<string>): number | null {
  return maxSeverity(labelsBy(issue, isHuman(excluded)));
}

// The severity a REFERENCE ACTOR assigned — the frontier-model labelling pass
// named in JUDGE_REFERENCE_ACTORS. Its labels are ground truth for the judge
// because it is itself graded against the maintainer (judge.reference_agreement);
// any other automation's labels are ground truth for nothing.
export function referenceLabelSeverity(issue: IssueNode, actors: ReadonlySet<string>): number | null {
  return maxSeverity(labelsBy(issue, isReference(actors)));
}

// A human applied REVIEWED_LABEL: the reference actor's tier was looked at and
// left standing. Overriding it (a human severity label) is the other review.
export function reviewedByHuman(issue: IssueNode, excluded: ReadonlySet<string>): boolean {
  return labelsBy(issue, isHuman(excluded)).includes(REVIEWED_LABEL);
}

export interface Verdict {
  index: number; // 0..3 — same scale as LABEL_SEVERITY
  tier: Tier;
  confidence: number;
}

interface ChoiceAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
}

interface JevResponse {
  answers?: Record<string, ChoiceAnswer>;
}

const QUESTION_ID = "tier";
const truncate = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n)}…` : (s ?? ""));

// Choice answers with an option name. An answer naming something that is not a
// tier is dropped rather than coerced — a verdict nobody can map to a label is
// not a verdict.
export function tierFromChoice(choice: string | undefined): { index: number; tier: Tier } | null {
  const index = TIERS.indexOf(choice as Tier);
  return index < 0 ? null : { index, tier: TIERS[index] as Tier };
}

// One issue per request. The docs are explicit that accuracy falls as the state
// grows and that unrelated detail acts as a distractor, and that the fix is to
// filter in code and send only the fields the question needs. Labels are
// structurally absent from the state, which is what makes the calibration
// sample blind.
async function askJev(key: string, issue: IssueNode): Promise<Verdict | null> {
  const state = {
    issue: {
      ref: `#${issue.number}`,
      title: issue.title,
      body: truncate(issue.body, BODY_CHARS),
    },
  };
  const questions = {
    [QUESTION_ID]: {
      type: "choice",
      instructions:
        "This is one open issue from a software repository. Which tier would the repository's maintainer assign it?",
      criteria: CRITERIA,
    },
  };

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
  const answer = body.answers?.[QUESTION_ID];
  const tier = tierFromChoice(answer?.choice);
  return tier ? { ...tier, confidence: answer?.confidence ?? 0 } : null;
}

// "all" judges every tracked repo on title + body. "titles" withholds private
// repos' bodies; "public" skips private repos entirely. Issue text leaves the
// deployment either way, so the knob is a var (ADR-004), not a code change.
type Scope = "all" | "titles" | "public";
const parseScope = (raw: string | undefined): Scope => (raw === "titles" || raw === "public" ? raw : "all");

const isPrivate = (entity: KnownEntity): boolean => entity.metadata?.private === true;

// Comma-separated GitHub logins. JUDGE_CALIBRATION_EXCLUDE: humans whose labels
// are not ground truth (automations under a person's PAT). JUDGE_REFERENCE_ACTORS:
// the frontier labelling pass whose labels ARE reference ground truth.
const parseLogins = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? "").split(",").map((s) => normalizeLogin(s.trim())).filter(Boolean));

// Extends the judged span outward from its previous ends over issues this run
// settled — judged now, already inside the span, or carrying a severity label
// and so not a proposal candidate at all. It stops at the first gap in either
// direction, so the span never claims an issue the run did not reach, however
// a cap or the run-wide budget cut the pass short.
export function extendSpan(
  prev: { low: number; high: number } | undefined,
  fetched: number[],
  settled: ReadonlySet<number>,
): { low: number; high: number } | undefined {
  const asc = [...fetched].sort((a, b) => a - b);
  let low = prev?.low;
  let high = prev?.high;
  if (low === undefined || high === undefined) {
    // First run for this repo: anchor at the newest issue, which is where the
    // descending backlog pass starts. If even that was not settled there is
    // nothing to anchor to and the next run starts over.
    const top = asc[asc.length - 1];
    if (top === undefined || !settled.has(top)) return undefined;
    low = top;
    high = top;
  }
  for (const n of asc) {
    if (n <= high) continue;
    if (!settled.has(n)) break;
    high = n;
  }
  for (let i = asc.length - 1; i >= 0; i--) {
    const n = asc[i] as number;
    if (n >= low) continue;
    if (!settled.has(n)) break;
    low = n;
  }
  return { low, high };
}

export const judge: Poller = {
  id: "judge",
  // Daily, not hourly: issues do not change hourly and a verdict costs a model
  // call. Since an issue is judged once, a nightly run in the steady state
  // costs a call only for what opened that day; the first runs after a fresh
  // deployment drain the existing backlog a page at a time.
  schedule: "daily",
  metricSemantics: {
    "judge.issue_tier": "state",
    "judge.tier_agreement": "state",
    "judge.tier_agreement_human": "state",
    "judge.reference_agreement": "state",
  },
  async poll(env, ctx): Promise<PollerResult> {
    const key = env.TYPESAFE_API_KEY;
    if (!key) throw new Error("unconfigured: set the TYPESAFE_API_KEY secret to enable this poller");

    const scope = parseScope(env.JUDGE_SCOPE);
    const excluded = parseLogins(env.JUDGE_CALIBRATION_EXCLUDE);
    const referenceActors = parseLogins(env.JUDGE_REFERENCE_ACTORS);
    const now = Math.floor(Date.now() / 1000);
    const dayBucket = String(now - (now % DAY));
    const signals: SignalInsert[] = [];
    const notes: string[] = [];

    const tracked = await ctx.listEntities("repo");
    const all = tracked.filter((e) => !e.archived);
    const priorCursors = readCursors(await ctx.listEntities("poller"));
    // Carried forward by default. A repo skipped this run — no PAT, GitHub
    // unreachable, past MAX_REPOS, budget spent — must not forget what it has
    // already judged, or it pays for the same backlog again on the next run.
    // A repo Ops no longer tracks at all is dropped, so this cannot grow
    // without bound.
    const knownIds = new Set(tracked.map((e) => e.id));
    const cursors: Cursors = Object.fromEntries(
      Object.entries(priorCursors).filter(([id]) => knownIds.has(id)),
    );
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
    let ungraded = 0;
    let untiered = 0;
    let attempted = 0;
    let reached = 0;
    let wanted = 0;
    let produced = 0;
    // The run-wide bound that actually matters. A Workers invocation gets 1000
    // subrequests and this poller shares them with every other daily poller, so
    // the ceiling is global rather than per repo: one slow repo with a long
    // backlog cannot spend the whole pass.
    let budget = MAX_JUDGMENTS;
    if (referenceActors.size === 0) {
      notes.push("JUDGE_REFERENCE_ACTORS unset: calibrating against human labels only");
    }
    for (const entity of repos) {
      const ref = entity.id.replace(/^repo:/, "");
      const [owner, name] = ref.split("/");
      if (!owner || !name) continue;
      const prior = priorCursors[entity.id];
      const pat = tokenForOwner(env, owner);
      if (!pat) {
        notes.push(`${ref}: no PAT for owner ${owner} — not judged`);
        continue;
      }
      const repoUrl = `https://github.com/${ref}`;
      attempted++;

      const judgedAlready = (n: number) => prior !== undefined && n >= prior.low && n <= prior.high;
      const candidateCount = (ns: IssueNode[]) =>
        ns.filter((i) => labelSeverity(i) === null && !judgedAlready(i.number)).length;

      let total: number;
      let nodes: IssueNode[];
      let complete: boolean;
      try {
        ({ total, nodes, complete } = await fetchIssues(pat, owner, name, (ns) => candidateCount(ns) >= PROPOSAL_CAP));
      } catch (err) {
        // One unreachable repo must not cost the whole pass. A GitHub outage is
        // already the github poller's failure to report; repeating it here would
        // just double-count it.
        notes.push(`${ref}: not judged — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      reached++;

      const withSeverity = nodes.map((issue) => {
        const human = humanLabelSeverity(issue, excluded);
        const reference = referenceLabelSeverity(issue, referenceActors);
        // The tier the judge is graded against: the maintainer's own label
        // wins; otherwise the reference actor's stands in for it.
        return {
          issue,
          labelled: labelSeverity(issue),
          human,
          reference,
          truth: human ?? reference,
          reviewed: reviewedByHuman(issue, excluded),
        };
      });
      const byNumber = new Map(withSeverity.map((r) => [r.issue.number, r]));
      ungraded += withSeverity.filter((r) => r.labelled !== null && r.truth === null).length;

      // Proposal candidates: untiered issues outside the judged span. New ones
      // are taken ASCENDING from the top of the span and the backlog DESCENDING
      // from its bottom, so whatever a cap cuts off leaves the span contiguous
      // rather than full of holes. In the steady state the new segment is a
      // handful of issues and the cap never bites.
      const candidates = withSeverity
        .filter((r) => r.labelled === null && !judgedAlready(r.issue.number))
        .map((r) => r.issue);
      const fresh = prior
        ? candidates.filter((i) => i.number > prior.high).sort((a, b) => a.number - b.number)
        : [];
      const backlog = candidates
        .filter((i) => prior === undefined || i.number < prior.low)
        .sort((a, b) => b.number - a.number);

      // Calibration keeps re-judging, deliberately: it measures the model, not
      // the issue, so a fresh sample every run is the point. Every
      // human-labelled issue is in it — they are the scarce ground truth — and
      // the reference-labelled fill rotates by day so the sample moves instead
      // of grading the same five issues forever.
      const graded = withSeverity.filter((r) => r.truth !== null);
      const humans = graded.filter((r) => r.human !== null);
      const refs = graded.filter((r) => r.human === null);
      const offset = refs.length > 0 ? Math.floor(now / DAY) % refs.length : 0;
      const rotated = [...refs.slice(offset), ...refs.slice(0, offset)];
      const toCalibrate = [...humans, ...rotated].slice(0, Math.min(CALIBRATION_CAP, budget));
      budget -= toCalibrate.length;
      const toPropose = [...fresh, ...backlog].slice(0, Math.min(PROPOSAL_CAP, budget));
      budget -= toPropose.length;

      if (candidates.length > toPropose.length) {
        notes.push(
          `${ref}: tiered ${toPropose.length} of ${candidates.length} untiered issues this run${
            complete ? "" : " (and more below the pages read)"
          }`,
        );
      } else if (!complete) {
        notes.push(`${ref}: read ${nodes.length} of ${total} open issues`);
      }
      if (graded.length > toCalibrate.length) {
        notes.push(`${ref}: calibrated against ${toCalibrate.length} of ${graded.length} labelled issues`);
      }

      // The reference actor graded against the maintainer — no model call, just
      // labels. Of the tiers it applied that a human then reviewed, how many
      // stood? Accepting is REVIEWED_LABEL; overriding is a human severity
      // label. This is the error bar on the reference set the judge is graded
      // against below, so it is emitted even when no model call is made.
      if (referenceActors.size > 0) {
        const reviewed = withSeverity.filter((r) => r.reference !== null && (r.human !== null || r.reviewed));
        const stood = reviewed.filter((r) => r.human === null || r.human === r.reference).length;
        signals.push({
          entityId: entity.id,
          metric: "judge.reference_agreement",
          valueNum: reviewed.length > 0 ? Math.round((stood / reviewed.length) * 100) : undefined,
          valueText:
            reviewed.length > 0
              ? `${stood} of ${reviewed.length} reviewed reference tiers stood · ${reviewed.length - stood} overridden`
              : "no reference tiers reviewed yet",
          severity: 0,
          url: `${repoUrl}/issues?q=${encodeURIComponent(labeledQuery())}`,
          observedAt: now,
          dedupeKey: dayBucket,
        });
      }

      // JUDGE_SCOPE=titles: a private repo's issue bodies never leave the
      // deployment. Titles alone still tier usefully; the verdicts are just
      // less confident, which the confidence floor already accounts for.
      const withhold = scope === "titles" && isPrivate(entity);
      if (withhold) withheldBodies++;
      const forJev = (issue: IssueNode): IssueNode => (withhold ? { ...issue, body: null } : issue);

      const verdicts = new Map<number, Verdict>();
      const toAsk = [...toCalibrate.map((r) => r.issue), ...toPropose];
      if (toAsk.length > 0) wanted++;
      for (const issue of toAsk) {
        try {
          const verdict = await askJev(key, forJev(issue));
          if (verdict) verdicts.set(issue.number, verdict);
          else untiered++;
        } catch (err) {
          // Stop this repo rather than spend the rest of the budget failing the
          // same way. Nothing is lost: an issue with no verdict does not enter
          // the judged span, so the next run picks it up.
          notes.push(`${ref}: judging stopped early — ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
      if (verdicts.size > 0) produced++;

      // Outstanding proposals, not this run's. judge.issue_tier is a `state`
      // metric (ADR-002) and has to keep meaning "untiered issues the judge
      // thinks need attention". Judging each issue once would otherwise turn it
      // into "issues looked at last night", which reads as an empty backlog on
      // the very night the backlog is largest.
      //
      // An entry drops off when the issue has since been tiered, or when it is
      // gone from the open set — but only where the run actually read far
      // enough to know. Below the pages fetched, absence proves nothing.
      const lowestFetched = nodes.length > 0 ? Math.min(...nodes.map((i) => i.number)) : Number.POSITIVE_INFINITY;
      const readThatFar = (n: number) => complete || n >= lowestFetched;
      const judgedNow = new Set(toPropose.map((i) => i.number));
      const carried = (prior?.open ?? []).filter((p) => {
        if (judgedNow.has(p.n)) return false; // replaced by this run's verdict
        const row = byNumber.get(p.n);
        if (row) return row.labelled === null;
        return !readThatFar(p.n);
      });

      // Proposals: untiered issues the judge puts at p1 or worse, confidently.
      // Anything calmer is not worth a maintainer's attention as a suggestion.
      const proposed: Proposal[] = [];
      for (const issue of toPropose) {
        const verdict = verdicts.get(issue.number);
        if (!verdict || verdict.index < 2) continue;
        // Counted only when the floor actually changed the outcome — a
        // low-confidence "nothing to act on" was never going to be shown, and
        // counting it would inflate the note into noise.
        if (verdict.confidence < MIN_CONFIDENCE) {
          lowConfidence++;
          continue;
        }
        proposed.push({
          n: issue.number,
          t: verdict.tier,
          c: Math.round(verdict.confidence * 100) / 100,
          s: issue.title.length > 50 ? `${issue.title.slice(0, 47)}…` : issue.title,
        });
      }
      const open = [...carried, ...proposed].sort(
        (a, b) => TIERS.indexOf(b.t) - TIERS.indexOf(a.t) || b.n - a.n,
      );
      if (open.length > PROPOSALS_KEPT) {
        notes.push(`${ref}: remembering the ${PROPOSALS_KEPT} most urgent of ${open.length} outstanding proposals`);
      }

      signals.push({
        entityId: entity.id,
        metric: "judge.issue_tier",
        valueNum: open.length,
        // Jev is decision-only — there is no generated rationale to show, so the
        // text carries the proposed label and the model's own confidence and
        // stops there. The issue itself is the record (ADR-001).
        valueText:
          open.length > 0
            ? open
                .slice(0, 5)
                .map((p) => `#${p.n} ${p.t} (${p.c.toFixed(2)}) ${p.s}`)
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

      // An issue is settled once the run is done with it: already inside the
      // span, carrying a severity label so it was never a candidate, or judged
      // now. A judged-but-unanswered issue is deliberately NOT settled, so a
      // failed call is retried rather than silently skipped forever.
      const settled = new Set<number>();
      for (const r of withSeverity) {
        if (r.labelled !== null || judgedAlready(r.issue.number)) settled.add(r.issue.number);
      }
      for (const issue of toPropose) if (verdicts.has(issue.number)) settled.add(issue.number);
      const span = extendSpan(
        prior ? { low: prior.low, high: prior.high } : undefined,
        nodes.map((i) => i.number),
        settled,
      );
      if (span) cursors[entity.id] = { ...span, open: open.slice(0, PROPOSALS_KEPT) };

      // Calibration: the blind sample, scored against the reference tier and,
      // separately, against the maintainer's own labels. Both have to be graded
      // before judge.* earns any more surface. Low-confidence verdicts are
      // graded here rather than dropped: excluding the judge's own uncertain
      // answers would flatter the agreement number.
      const compared = toCalibrate
        .map((r) => ({ human: r.human, expected: r.truth as number, verdict: verdicts.get(r.issue.number) }))
        .filter((c): c is { human: number | null; expected: number; verdict: Verdict } => c.verdict !== undefined);
      const agreement = (sample: typeof compared, empty: string, describe: (n: number) => string): SignalInsert => {
        const exact = sample.filter((c) => c.verdict.index === c.expected).length;
        const within = sample.filter((c) => Math.abs(c.verdict.index - c.expected) <= 1).length;
        return {
          entityId: entity.id,
          metric: "",
          valueNum: sample.length > 0 ? Math.round((exact / sample.length) * 100) : undefined,
          // The denominator is named, because "80% agreement" means nothing
          // without knowing it was 4 of 5. An empty sample reports no number at
          // all rather than a 0 that reads as "the judge is always wrong".
          valueText:
            sample.length > 0
              ? `${exact} of ${sample.length} exact · ${within} within one tier · ${describe(sample.length)}`
              : empty,
          severity: 0,
          url: `${repoUrl}/issues?q=${encodeURIComponent(labeledQuery())}`,
          observedAt: now,
          dedupeKey: dayBucket,
        };
      };
      const humanCount = compared.filter((c) => c.human !== null).length;
      signals.push({
        ...agreement(
          compared,
          "no human- or reference-labelled issues to compare against",
          (n) => `${humanCount} human-labelled, ${n - humanCount} reference-labelled`,
        ),
        metric: "judge.tier_agreement",
      });
      signals.push({
        ...agreement(
          compared.filter((c) => c.human !== null),
          "no human-labelled issues to compare against",
          () => "human-labelled sample",
        ),
        metric: "judge.tier_agreement_human",
      });
    }

    // Two distinct total failures, both of which would otherwise leave
    // poller.last_ok marching forward while nothing was judged. A run that
    // asked for nothing because everything is already judged is NOT a failure —
    // it is what this poller looks like in the steady state.
    if (attempted > 0 && reached === 0) {
      throw new Error(`judge: no repo could be read (${attempted} attempted) — ${notes.join("; ")}`);
    }
    if (wanted > 0 && produced === 0) {
      throw new Error(`judge: no verdict could be obtained (${wanted} repo(s) had issues to judge) — ${notes.join("; ")}`);
    }
    if (budget === 0) {
      notes.push(`run-wide judgment budget of ${MAX_JUDGMENTS} spent — the rest carries to the next run`);
    }
    if (ungraded > 0) {
      // Not a failure — but if this number dwarfs the calibration sample, the
      // portfolio is being tiered by an automation nobody grades and the gate
      // has little to grade against. Visible, not inferred from a small N.
      notes.push(
        `${ungraded} issue(s) excluded from calibration: severity label applied by neither a human nor a reference actor`,
      );
    }
    if (lowConfidence > 0) {
      notes.push(`${lowConfidence} verdict(s) dropped below the ${MIN_CONFIDENCE} confidence floor`);
    }
    if (untiered > 0) {
      notes.push(`${untiered} verdict(s) named no known tier and were discarded`);
    }
    if (withheldBodies > 0) {
      notes.push(`JUDGE_SCOPE=titles: issue bodies withheld for ${withheldBodies} private repo(s)`);
    }

    // The cursor rides on the poller's own entity. The runner upserts this
    // before recordPollerStatus, whose own upsert passes no metadata and so
    // leaves it alone (store.ts coalesces a null).
    const self: EntityUpsert = {
      id: CURSOR_ENTITY,
      kind: "poller",
      name: "judge",
      metadata: { cursors },
    };
    return { entities: [self], signals, ...(notes.length ? { notes } : {}) } satisfies PollerResult;
  },
};
