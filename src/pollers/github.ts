import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// Spec §2.4: classification lives in the system of record — GitHub topics.
const TOPIC_CATEGORY: Record<string, string> = {
  "static-site": "static_site",
  "web-app": "web_app",
  mcp: "plugin_skill",
  skill: "plugin_skill",
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
          pushedAt
          isArchived
          isPrivate
          description
          primaryLanguage { name }
          repositoryTopics(first: 20) { nodes { topic { name } } }
          issues(states: OPEN) { totalCount }
          pullRequests(states: OPEN) { totalCount }
          vulnerabilityAlerts(states: OPEN) { totalCount }
          defaultBranchRef {
            target {
              ... on Commit {
                oid
                statusCheckRollup { state }
              }
            }
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
  pushedAt: string;
  isArchived: boolean;
  isPrivate: boolean;
  description: string | null;
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  issues: { totalCount: number };
  pullRequests: { totalCount: number };
  vulnerabilityAlerts: { totalCount: number } | null;
  defaultBranchRef: {
    target: { oid: string; statusCheckRollup: { state: string } | null } | null;
  } | null;
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
    if (page.errors?.length) throw new Error(`github: ${page.errors[0]?.message}`);
    const conn = page.data?.repositoryOwner?.repositories;
    if (!conn) throw new Error(`github: unknown owner ${owner}`);
    yield* conn.nodes;
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

export const github: Poller = {
  id: "github",
  schedule: "hourly",
  metricSemantics: {
    "ci.status": "state",
    "deps.vuln_count": "state",
    "issues.open": "state",
    "prs.open": "state",
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

        const vulns = repo.vulnerabilityAlerts?.totalCount ?? 0;
        signals.push({
          entityId: id,
          metric: "deps.vuln_count",
          valueNum: vulns,
          severity: vulns > 0 ? 2 : 0,
          url: `${repo.url}/security/dependabot`,
          observedAt: now,
          dedupeKey: hourBucket,
        });
        signals.push({
          entityId: id,
          metric: "issues.open",
          valueNum: repo.issues.totalCount,
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

        const pushedAt = Math.floor(Date.parse(repo.pushedAt) / 1000);
        signals.push({
          entityId: id,
          metric: "repo.pushed_at",
          valueNum: pushedAt,
          observedAt: pushedAt, // when the condition was true, not when polled
          dedupeKey: String(pushedAt),
        });
      }
    }
    return { entities, signals } satisfies PollerResult;
  },
};
