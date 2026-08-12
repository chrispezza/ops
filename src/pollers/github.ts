import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// Spec §2.4: classification lives in the system of record — GitHub topics.
const TOPIC_CATEGORY: Record<string, string> = {
  "static-site": "static_site",
  "web-app": "web_app",
  mcp: "plugin_skill",
  skill: "plugin_skill",
  "claude-plugin": "plugin_skill",
  "claude-code-plugin": "plugin_skill",
  tool: "tooling",
  template: "tooling",
  client: "client_project",
};

const QUERY = /* GraphQL */ `
  query ($owner: String!, $cursor: String) {
    repositoryOwner(login: $owner) {
      repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          nameWithOwner
          url
          homepageUrl
          pushedAt
          isArchived
          isPrivate
          description
          licenseInfo { spdxId }
          readme: object(expression: "HEAD:README.md") { ... on Blob { byteLength } }
          claudeMd: object(expression: "HEAD:CLAUDE.md") { ... on Blob { byteLength } }
          primaryLanguage { name }
          repositoryTopics(first: 20) { nodes { topic { name } } }
          issues(states: OPEN) { totalCount }
          refs(refPrefix: "refs/heads/") { totalCount }
          vulnerabilityAlerts(states: OPEN, first: 100) {
            totalCount
            nodes {
              securityVulnerability { severity }
            }
          }
          pullRequests(states: OPEN, first: 1, orderBy: { field: CREATED_AT, direction: ASC }) {
            totalCount
            nodes { createdAt }
          }
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
                statusCheckRollup { state }
              }
            }
          }
          latestRelease {
            tagName
            createdAt
            url
          }
        }
      }
    }
  }
`;

interface RepoNode {
  name: string;
  nameWithOwner: string;
  url: string;
  homepageUrl: string | null;
  pushedAt: string;
  isArchived: boolean;
  isPrivate: boolean;
  description: string | null;
  licenseInfo?: { spdxId: string | null } | null;
  readme?: { byteLength: number } | null;
  claudeMd?: { byteLength: number } | null;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  issues: { totalCount: number };
  refs?: { totalCount: number } | null;
  pullRequests: { totalCount: number; nodes?: { createdAt: string }[] };
  vulnerabilityAlerts: {
    totalCount: number;
    nodes?: { securityVulnerability: { severity: string } | null }[];
  } | null;
  defaultBranchRef: {
    name: string;
    target: { oid: string; statusCheckRollup: { state: string } | null } | null;
  } | null;
  latestRelease: { tagName: string; createdAt: string; url: string } | null;
}

interface GraphQLPage {
  data?: {
    repositoryOwner: {
      repositories: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RepoNode[];
      };
    } | null;
  };
  errors?: { message: string }[];
}

async function* fetchRepos(pat: string, owner: string): AsyncGenerator<RepoNode> {
  let cursor: string | null = null;
  do {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pat}`,
        "content-type": "application/json",
        "user-agent": "ops-dashboard",
      },
      body: JSON.stringify({ query: QUERY, variables: { owner, cursor } }),
    });
    if (!res.ok) throw new Error(`github: HTTP ${res.status} for owner ${owner}`);
    const page = (await res.json()) as GraphQLPage;
    const conn = page.data?.repositoryOwner?.repositories;
    // Partial errors (e.g. a field the token can't read) still carry data —
    // only fail when GitHub returned nothing usable at all.
    if (!conn) {
      if (page.errors?.length) throw new Error(`github: ${page.errors[0]?.message}`);
      throw new Error(`github: unknown owner ${owner}`);
    }
    yield* conn.nodes;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

interface WorkflowRun {
  id: number;
  conclusion: string | null;
  run_started_at: string;
  updated_at: string;
  html_url: string;
}

// REST — workflow run history needs Actions: read. Enhancement metrics only:
// a token without the grant gets an empty list, never a failed poll.
async function fetchRuns(pat: string, nameWithOwner: string, branch: string): Promise<WorkflowRun[]> {
  const res = await fetch(
    `https://api.github.com/repos/${nameWithOwner}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=10`,
    {
      headers: {
        authorization: `Bearer ${pat}`,
        accept: "application/vnd.github+json",
        "user-agent": "ops-dashboard",
      },
    },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return body.workflow_runs ?? [];
}

export const github: Poller = {
  id: "github",
  schedule: "hourly",
  metricSemantics: {
    "ci.status": "state",
    "ci.duration_ms": "state",
    "ci.fail_streak": "state",
    "deps.vuln_count": "state",
    "issues.open": "state",
    "prs.open": "state",
    "prs.oldest_days": "state",
    "repo.branches": "state",
    "docs.score": "state",
    "release.age_days": "state",
    "repo.pushed_at": "state",
  },
  async poll(env) {
    const owners = (env.GITHUB_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (owners.length === 0) throw new Error("github: GITHUB_OWNERS is not configured");

    // Fine-grained PATs are scoped to one resource owner. GITHUB_PAT_<OWNER>
    // (uppercased, non-alphanumerics -> "_") overrides GITHUB_PAT per owner.
    const tokenFor = (owner: string): string | undefined => {
      const key = `GITHUB_PAT_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
      return (env as unknown as Record<string, string | undefined>)[key] ?? env.GITHUB_PAT;
    };

    const now = Math.floor(Date.now() / 1000);
    // Spec §2.3: state-count metrics dedupe on observed_at bucketed to poll granularity.
    const hourBucket = String(now - (now % 3600));
    const entities: EntityUpsert[] = [];
    const signals: SignalInsert[] = [];

    for (const owner of owners) {
      const pat = tokenFor(owner);
      if (!pat) throw new Error(`github: no PAT for owner ${owner} (set GITHUB_PAT or a per-owner secret)`);
      for await (const repo of fetchRepos(pat, owner)) {
        if (repo.isArchived) continue;
        const id = `repo:${repo.nameWithOwner}`;
        const topics = repo.repositoryTopics.nodes.map((n) => n.topic.name);
        const category = topics.map((t) => TOPIC_CATEGORY[t]).find(Boolean);

        entities.push({
          id,
          kind: "repo",
          category,
          name: repo.name,
          owner,
          sourceUrl: repo.url,
          metadata: {
            description: repo.description,
            language: repo.primaryLanguage?.name,
            private: repo.isPrivate,
            topics,
            homepage: repo.homepageUrl || undefined, // uptime poller's target list
          },
        });

        const head = repo.defaultBranchRef?.target;
        if (head?.statusCheckRollup) {
          const state = head.statusCheckRollup.state;
          signals.push({
            entityId: id,
            metric: "ci.status",
            valueText: state.toLowerCase(),
            severity: state === "FAILURE" || state === "ERROR" ? 3 : 0,
            url: `${repo.url}/actions`,
            observedAt: now,
            dedupeKey: head.oid, // upstream event id — preferred over time bucket
          });
        }

        // Dependabot grades every alert; flatten that into signal severity so
        // 54 transitive lows stop outranking 2 criticals. critical → act now,
        // high → plan, moderate/low only → routine.
        const vulns = repo.vulnerabilityAlerts?.totalCount ?? 0;
        const grades = { critical: 0, high: 0, other: 0 };
        for (const node of repo.vulnerabilityAlerts?.nodes ?? []) {
          const g = node.securityVulnerability?.severity?.toLowerCase();
          if (g === "critical") grades.critical++;
          else if (g === "high") grades.high++;
          else grades.other++;
        }
        const graded = grades.critical + grades.high + grades.other > 0;
        const vulnSeverity =
          vulns === 0 ? 0
          : !graded ? 2 // grading unavailable (token scope, >100 alerts page) — keep the old conservative middle
          : grades.critical > 0 ? 3
          : grades.high > 0 ? 2
          : 1;
        const breakdown = [
          grades.critical > 0 ? `${grades.critical} critical` : "",
          grades.high > 0 ? `${grades.high} high` : "",
          grades.other > 0 ? `${grades.other} moderate/low` : "",
        ].filter(Boolean).join(" · ");
        signals.push({
          entityId: id,
          metric: "deps.vuln_count",
          valueNum: vulns,
          valueText: breakdown || undefined,
          severity: vulnSeverity as 0 | 1 | 2 | 3,
          url: `${repo.url}/security/dependabot`,
          observedAt: now,
          dedupeKey: hourBucket,
        });
        signals.push({
          entityId: id,
          metric: "issues.open",
          valueNum: repo.issues.totalCount,
          severity: repo.issues.totalCount >= 10 ? 1 : 0, // issue pressure feeds triage
          url: `${repo.url}/issues`,
          observedAt: now,
          dedupeKey: hourBucket,
        });
        signals.push({
          entityId: id,
          metric: "prs.open",
          valueNum: repo.pullRequests.totalCount,
          url: `${repo.url}/pulls`,
          observedAt: now,
          dedupeKey: hourBucket,
        });
        if (repo.refs) {
          signals.push({
            entityId: id,
            metric: "repo.branches",
            valueNum: repo.refs.totalCount,
            url: `${repo.url}/branches`,
            observedAt: now,
            dedupeKey: hourBucket,
          });
        }

        // Documentation health: equal-weight checks over what applies to the
        // repo (license only judged on public repos; CLAUDE.md is the user's
        // own stated convention). valueText names exactly what's missing.
        const docsChecks: [string, boolean][] = [
          ["README", (repo.readme?.byteLength ?? 0) >= 200],
          ["description", !!repo.description?.trim()],
          ["CLAUDE.md", !!repo.claudeMd],
        ];
        if (!repo.isPrivate) {
          docsChecks.push(["license", !!repo.licenseInfo?.spdxId && repo.licenseInfo.spdxId !== "NOASSERTION"]);
        }
        const missing = docsChecks.filter(([, ok]) => !ok).map(([name]) => name);
        const docsScore = Math.round(((docsChecks.length - missing.length) / docsChecks.length) * 100);
        signals.push({
          entityId: id,
          metric: "docs.score",
          valueNum: docsScore,
          valueText: missing.length > 0 ? `missing: ${missing.join(", ")}` : "complete",
          severity: docsScore < 100 ? 1 : 0,
          url: repo.url,
          observedAt: now,
          dedupeKey: hourBucket,
        });

        // PRs rotting is the solo-maintainer failure mode: age of the oldest
        // open PR, warning at 14d, medium at 30d.
        const oldestPr = repo.pullRequests.nodes?.[0];
        if (oldestPr) {
          const prDays = Math.floor((now - Math.floor(Date.parse(oldestPr.createdAt) / 1000)) / 86_400);
          signals.push({
            entityId: id,
            metric: "prs.oldest_days",
            valueNum: prDays,
            severity: prDays >= 30 ? 2 : prDays >= 14 ? 1 : 0,
            url: `${repo.url}/pulls`,
            observedAt: now,
            dedupeKey: hourBucket,
          });
        }

        const pushedAt = Math.floor(Date.parse(repo.pushedAt) / 1000);
        signals.push({
          entityId: id,
          metric: "repo.pushed_at",
          valueNum: pushedAt,
          observedAt: pushedAt, // when the condition was true, not when polled
          dedupeKey: String(pushedAt),
        });

        // Contents: read — null when the token lacks the grant or no release exists
        if (repo.latestRelease) {
          const releasedAt = Math.floor(Date.parse(repo.latestRelease.createdAt) / 1000);
          signals.push({
            entityId: id,
            metric: "release.age_days",
            valueNum: Math.floor((now - releasedAt) / 86_400),
            valueText: repo.latestRelease.tagName,
            url: repo.latestRelease.url,
            observedAt: now,
            dedupeKey: repo.latestRelease.tagName, // one row per release, age updates in place
          });
        }

        // Actions: read — CI health beyond current pass/fail
        if (repo.defaultBranchRef?.name && head?.statusCheckRollup) {
          const runs = await fetchRuns(pat, repo.nameWithOwner, repo.defaultBranchRef.name);
          const latest = runs[0];
          if (latest) {
            signals.push({
              entityId: id,
              metric: "ci.duration_ms",
              valueNum: Date.parse(latest.updated_at) - Date.parse(latest.run_started_at),
              url: latest.html_url,
              observedAt: Math.floor(Date.parse(latest.updated_at) / 1000),
              dedupeKey: String(latest.id), // upstream run id
            });
            let streak = 0;
            for (const run of runs) {
              if (run.conclusion !== "failure") break;
              streak += 1;
            }
            signals.push({
              entityId: id,
              metric: "ci.fail_streak",
              valueNum: streak,
              severity: streak >= 3 ? 2 : 0, // chronic failure; the current break is already sev 3 via ci.status
              url: `${repo.url}/actions`,
              observedAt: now,
              dedupeKey: hourBucket,
            });
          }
        }
      }
    }
    return { entities, signals } satisfies PollerResult;
  },
};
