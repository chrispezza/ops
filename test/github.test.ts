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
    issues: { totalCount: 0 },
    pullRequests: { totalCount: 0 },
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
            issues: { totalCount: 4 },
            pullRequests: { totalCount: 3 },
            vulnerabilityAlerts: { totalCount: 2 },
            defaultBranchRef: { target: { oid: "abc123", statusCheckRollup: { state: "FAILURE" } } },
          }),
          repoNode({ name: "untagged", nameWithOwner: "clownware/untagged" }),
          repoNode({ name: "old", nameWithOwner: "clownware/old", isArchived: true }),
        ]),
      ),
    );

    const result = await github.poll(testEnv, {});

    // archived repo skipped; categories from topics
    expect(result.entities.map((e) => e.id)).toEqual(["repo:clownware/gittunes", "repo:clownware/untagged"]);
    expect(result.entities[0]?.category).toBe("web_app");
    expect(result.entities[1]?.category).toBeUndefined();

    const sig = (id: string, metric: string) =>
      result.signals.find((s) => s.entityId === id && s.metric === metric);

    const ci = sig("repo:clownware/gittunes", "ci.status");
    expect(ci?.valueText).toBe("failure");
    expect(ci?.severity).toBe(3);
    expect(ci?.dedupeKey).toBe("abc123"); // upstream event id, not time bucket

    const vulns = sig("repo:clownware/gittunes", "deps.vuln_count");
    expect(vulns?.valueNum).toBe(2);
    expect(vulns?.severity).toBe(2);

    // repo without CI emits no ci.status signal at all
    expect(sig("repo:clownware/untagged", "ci.status")).toBeUndefined();

    // pushed_at observed when the push happened, dedupe on the event itself
    const pushed = sig("repo:clownware/gittunes", "repo.pushed_at");
    const pushedEpoch = Math.floor(Date.parse("2026-08-02T12:00:00Z") / 1000);
    expect(pushed?.observedAt).toBe(pushedEpoch);
    expect(pushed?.dedupeKey).toBe(String(pushedEpoch));
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

    const result = await github.poll(testEnv, {});
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

    const result = await github.poll(testEnv, {});
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
    await github.poll(multiEnv, {});

    expect(authHeaders).toEqual(["Bearer personal-pat", "Bearer org-pat"]);
  });

  it("fails loudly when unconfigured (error isolation turns this into a signal)", async () => {
    await expect(github.poll({ ...testEnv, GITHUB_OWNERS: "" } as Env, {})).rejects.toThrow(/GITHUB_OWNERS/);
    await expect(github.poll({ ...testEnv, GITHUB_PAT: undefined } as unknown as Env, {})).rejects.toThrow(
      /GITHUB_PAT/,
    );
  });

  it("surfaces GraphQL errors with context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ errors: [{ message: "bad credentials" }] })));
    await expect(github.poll(testEnv, {})).rejects.toThrow(/bad credentials/);
  });
});
