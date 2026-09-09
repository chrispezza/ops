import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { github } from "../src/pollers/github";

function repoNode(overrides: Record<string, unknown>) {
  return {
    name: "repo",
    nameWithOwner: "clownware/repo",
    url: "https://github.com/clownware/repo",
    pushedAt: "2026-08-02T12:00:00Z",
    isArchived: false,
    isPrivate: false,
    description: null,
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [] },
    issues: { totalCount: 0, nodes: [] },
    pullRequests: { totalCount: 0, nodes: [] },
    vulnerabilityAlerts: { totalCount: 0 },
    defaultBranchRef: null,
    ...overrides,
  };
}

function gqlResponse(nodes: unknown[]) {
  return Response.json({
    data: {
      repositoryOwner: {
        repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
      },
    },
  });
}

const testEnv = { ...env, GITHUB_OWNERS: "clownware", GITHUB_PAT: "test-pat" } as Env;

afterEach(() => vi.unstubAllGlobals());

describe("github poller", () => {
  it("maps topics to categories and upstream state to signals", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse([
          repoNode({
            name: "gittunes",
            nameWithOwner: "clownware/gittunes",
            url: "https://github.com/clownware/gittunes",
            repositoryTopics: { nodes: [{ topic: { name: "web-app" } }] },
            refs: { totalCount: 4 },
            issues: { totalCount: 4 },
            pullRequests: { totalCount: 3 },
            vulnerabilityAlerts: {
              totalCount: 2,
              nodes: [
                { securityVulnerability: { severity: "CRITICAL" } },
                { securityVulnerability: { severity: "LOW" } },
              ],
            },
            defaultBranchRef: { target: { oid: "abc123", statusCheckRollup: { state: "FAILURE" } } },
          }),
          repoNode({ name: "untagged", nameWithOwner: "clownware/untagged" }),
          repoNode({ name: "old", nameWithOwner: "clownware/old", isArchived: true }),
        ]),
      ),
    );

    const result = await github.poll(testEnv, { listEntities: async () => [] });

    // upstream-archived repo is MARKED archived, not skipped — the entity page
    // promises "archive it on GitHub and Ops follows on the next poll"
    expect(result.entities.map((e) => e.id)).toEqual([
      "repo:clownware/gittunes",
      "repo:clownware/untagged",
      "repo:clownware/old",
    ]);
    expect(result.entities[0]?.category).toBe("web_app");
    expect(result.entities[1]?.category).toBeUndefined();
    expect(result.entities[2]?.archived).toBe(true);
    // archived means frozen: no signals for it
    expect(result.signals.some((s) => s.entityId === "repo:clownware/old")).toBe(false);

    const sig = (id: string, metric: string) =>
      result.signals.find((s) => s.entityId === id && s.metric === metric);

    const ci = sig("repo:clownware/gittunes", "ci.status");
    expect(ci?.valueText).toBe("failure");
    expect(ci?.severity).toBe(3);
    expect(ci?.dedupeKey).toBe("abc123"); // upstream event id, not time bucket

    const vulns = sig("repo:clownware/gittunes", "deps.vuln_count");
    expect(vulns?.valueNum).toBe(2);
    expect(vulns?.severity).toBe(3); // a critical alert escalates the signal
    expect(vulns?.valueText).toBe("1 critical · 1 moderate/low");

    // ungraded counts (no nodes) keep the conservative middle severity
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse([
          repoNode({ nameWithOwner: "clownware/plainvulns", vulnerabilityAlerts: { totalCount: 54 } }),
        ]),
      ),
    );
    const plain = await github.poll(testEnv, { listEntities: async () => [] });
    const plainVulns = plain.signals.find((s) => s.metric === "deps.vuln_count");
    expect(plainVulns?.severity).toBe(2);

    // moderate/low only → routine severity
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse([
          repoNode({
            nameWithOwner: "clownware/lowvulns",
            vulnerabilityAlerts: { totalCount: 3, nodes: [{ securityVulnerability: { severity: "MODERATE" } }, { securityVulnerability: { severity: "LOW" } }, { securityVulnerability: { severity: "LOW" } }] },
          }),
        ]),
      ),
    );
    const low = await github.poll(testEnv, { listEntities: async () => [] });
    expect(low.signals.find((s) => s.metric === "deps.vuln_count")?.severity).toBe(1);

    // repo without CI emits no ci.status signal at all
    expect(sig("repo:clownware/untagged", "ci.status")).toBeUndefined();

    // branch count captured when the API returns refs
    const branches = sig("repo:clownware/gittunes", "repo.branches");
    expect(branches?.valueNum).toBe(4);

    // docs health: public repo missing README/description/CLAUDE.md/license → 0
    const docs = sig("repo:clownware/gittunes", "docs.score");
    expect(docs?.valueNum).toBe(0);
    expect(docs?.severity).toBe(1);
    expect(docs?.valueText).toBe("missing: README, description, CLAUDE.md, license");

    // pushed_at observed when the push happened, dedupe on the event itself
    const pushed = sig("repo:clownware/gittunes", "repo.pushed_at");
    const pushedEpoch = Math.floor(Date.parse("2026-08-02T12:00:00Z") / 1000);
    expect(pushed?.observedAt).toBe(pushedEpoch);
    expect(pushed?.dedupeKey).toBe(String(pushedEpoch));
  });

  it("separates human PR age from Dependabot PRs and flags major bumps", async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const pr = (number: number, title: string, login: string, ageDays: number) => ({
      number,
      title,
      createdAt: daysAgo(ageDays),
      author: { login },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse([
          repoNode({
            nameWithOwner: "clownware/deprep",
            url: "https://github.com/clownware/deprep",
            pullRequests: {
              totalCount: 5,
              nodes: [
                pr(78, "chore(deps): bump the next-cloudflare group with 4 updates", "dependabot", 35),
                pr(80, "chore(deps): bump vitest from 4.1.11 to 5.0.0", "dependabot", 20),
                pr(81, "chore(ci): Bump docker/setup-buildx-action from 3 to 4", "dependabot", 20),
                pr(82, "chore(deps): bump preact from 10.29.7 to 10.29.8", "dependabot", 2),
                pr(83, "feat: real work", "chrispezza", 16),
              ],
            },
          }),
          repoNode({ nameWithOwner: "clownware/quiet", url: "https://github.com/clownware/quiet" }),
        ]),
      ),
    );
    const result = await github.poll(testEnv, { listEntities: async () => [] });
    const sig = (id: string, metric: string) => result.signals.find((s) => s.entityId === id && s.metric === metric);

    // human PR age ignores the older bot PR (35d) and reads the 16d human one
    const human = sig("repo:clownware/deprep", "prs.oldest_days");
    expect(human?.valueNum).toBe(16);
    expect(human?.severity).toBe(1);
    expect(human?.url).toContain("-author%3Aapp%2Fdependabot");

    const bots = sig("repo:clownware/deprep", "prs.dependabot_count");
    expect(bots?.valueNum).toBe(4);
    expect(bots?.valueText).toBe("oldest 35d");
    expect(bots?.severity).toBe(1); // a month of bot rot is a chore, not an incident

    const majors = sig("repo:clownware/deprep", "prs.dependabot_major");
    expect(majors?.valueNum).toBe(2);
    expect(majors?.valueText).toBe("#80 vitest 4→5 · #81 docker/setup-buildx-action 3→4");
    expect(majors?.severity).toBe(1);

    // a repo with no PRs still emits every PR metric at zero, so a merged-away
    // finding resolves instead of its last severity staying "latest" forever
    expect(sig("repo:clownware/quiet", "prs.oldest_days")).toMatchObject({ valueNum: 0, severity: 0 });
    expect(sig("repo:clownware/quiet", "prs.dependabot_count")).toMatchObject({ valueNum: 0, severity: 0 });
    expect(sig("repo:clownware/quiet", "prs.dependabot_major")).toMatchObject({ valueNum: 0, severity: 0 });
    expect(result.notes).toBeUndefined();
  });

  it("describes the issue backlog shape and reports capped inspection", async () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const issue = (number: number, createdDays: number, updatedDays: number) => ({
      number,
      createdAt: daysAgo(createdDays),
      updatedAt: daysAgo(updatedDays),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse([
          repoNode({
            nameWithOwner: "clownware/gittunes_website",
            url: "https://github.com/clownware/gittunes_website",
            issues: {
              totalCount: 5,
              nodes: [issue(3, 159, 102), issue(7, 120, 95), issue(20, 40, 12), issue(31, 3, 3), issue(32, 1, 0)],
            },
          }),
          repoNode({
            nameWithOwner: "clownware/busy",
            issues: { totalCount: 45, nodes: Array.from({ length: 30 }, (_, i) => issue(i + 1, 10, 1)) },
            pullRequests: { totalCount: 25, nodes: Array.from({ length: 20 }, (_, i) => ({ number: i + 1, title: "x", createdAt: daysAgo(1), author: { login: "dependabot" } })) },
          }),
        ]),
      ),
    );
    const result = await github.poll(testEnv, { listEntities: async () => [] });
    const sig = (id: string, metric: string) => result.signals.find((s) => s.entityId === id && s.metric === metric);

    const idle = sig("repo:clownware/gittunes_website", "issues.idle_90d");
    expect(idle?.valueNum).toBe(2);
    expect(idle?.valueText).toBe("#3 · #7");
    expect(idle?.severity).toBe(1);
    expect(idle?.url).toContain("sort%3Aupdated-asc");
    expect(sig("repo:clownware/gittunes_website", "issues.new_7d")?.valueNum).toBe(2);
    expect(sig("repo:clownware/gittunes_website", "issues.oldest_days")?.valueNum).toBe(159);

    // five or more forgotten issues is a medium finding
    expect(sig("repo:clownware/busy", "issues.idle_90d")?.severity).toBe(0);
    // caps are never silent (poller contract)
    expect(result.notes).toEqual([
      "clownware/busy: inspected 30 of 45 open issues",
      "clownware/busy: inspected 20 of 25 open PRs",
    ]);
  });

  it("emits release age, CI duration, and fail streak when the wider grants respond", async () => {
    const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const run = (id: number, conclusion: string) => ({
      id,
      conclusion,
      run_started_at: "2026-08-10T12:00:00Z",
      updated_at: "2026-08-10T12:03:00Z",
      html_url: `https://github.com/clownware/gittunes/actions/runs/${id}`,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/actions/runs")) {
          return Response.json({ workflow_runs: [run(99, "failure"), run(98, "failure"), run(97, "failure")] });
        }
        return gqlResponse([
          repoNode({
            nameWithOwner: "clownware/gittunes",
            defaultBranchRef: { name: "main", target: { oid: "abc", statusCheckRollup: { state: "FAILURE" } } },
            latestRelease: { tagName: "v1.2.0", createdAt: TEN_DAYS_AGO, url: "https://github.com/clownware/gittunes/releases/tag/v1.2.0" },
          }),
        ]);
      }),
    );

    const result = await github.poll(testEnv, { listEntities: async () => [] });
    const sig = (metric: string) => result.signals.find((s) => s.metric === metric);

    expect(sig("release.age_days")?.valueNum).toBe(10);
    expect(sig("release.age_days")?.dedupeKey).toBe("v1.2.0");
    expect(sig("ci.duration_ms")?.valueNum).toBe(180_000);
    expect(sig("ci.duration_ms")?.dedupeKey).toBe("99");
    expect(sig("ci.fail_streak")?.valueNum).toBe(3);
    expect(sig("ci.fail_streak")?.severity).toBe(2); // chronic: 3+ consecutive failures
  });

  it("degrades to core metrics when the token lacks Actions/Contents grants", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/actions/runs")) return new Response("forbidden", { status: 403 });
        return gqlResponse([
          repoNode({
            nameWithOwner: "clownware/gittunes",
            defaultBranchRef: { name: "main", target: { oid: "abc", statusCheckRollup: { state: "SUCCESS" } } },
            latestRelease: null, // GraphQL nulls the field without Contents: read
          }),
        ]);
      }),
    );

    const result = await github.poll(testEnv, { listEntities: async () => [] });
    expect(result.signals.find((s) => s.metric === "ci.status")).toBeDefined();
    expect(result.signals.find((s) => s.metric === "ci.duration_ms")).toBeUndefined();
    expect(result.signals.find((s) => s.metric === "release.age_days")).toBeUndefined();
  });

  it("uses per-owner PAT overrides for fine-grained tokens", async () => {
    const authHeaders: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        authHeaders.push(String((init?.headers as Record<string, string>)?.authorization));
        return gqlResponse([]);
      }),
    );

    const multiEnv = {
      ...env,
      GITHUB_OWNERS: "chrispezza, clownware",
      GITHUB_PAT: "personal-pat",
      GITHUB_PAT_CLOWNWARE: "org-pat",
    } as unknown as Env;
    await github.poll(multiEnv, { listEntities: async () => [] });

    expect(authHeaders).toEqual(["Bearer personal-pat", "Bearer org-pat"]);
  });

  it("scores fully documented repos clean, judging license only when public", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        gqlResponse([
          repoNode({
            nameWithOwner: "clownware/tidy",
            isPrivate: true, // license not applicable
            description: "A tidy private repo",
            readme: { byteSize: 4000 },
            claudeMd: { byteSize: 900 },
          }),
        ]),
      ),
    );
    const result = await github.poll(testEnv, { listEntities: async () => [] });
    const docs = result.signals.find((s) => s.metric === "docs.score");
    expect(docs?.valueNum).toBe(100);
    expect(docs?.severity).toBe(0);
    expect(docs?.valueText).toBe("complete");
  });

  it("fails loudly when unconfigured (error isolation turns this into a signal)", async () => {
    await expect(github.poll({ ...testEnv, GITHUB_OWNERS: "" } as Env, { listEntities: async () => [] })).rejects.toThrow(/GITHUB_OWNERS/);
    await expect(github.poll({ ...testEnv, GITHUB_PAT: undefined } as unknown as Env, { listEntities: async () => [] })).rejects.toThrow(
      /GITHUB_PAT/,
    );
  });

  it("surfaces GraphQL errors with context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ errors: [{ message: "bad credentials" }] })));
    await expect(github.poll(testEnv, { listEntities: async () => [] })).rejects.toThrow(/bad credentials/);
  });
});
