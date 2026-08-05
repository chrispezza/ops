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
