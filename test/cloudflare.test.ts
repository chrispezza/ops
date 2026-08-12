import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertSignals, upsertEntities } from "../src/core/store";
import { cloudflare } from "../src/pollers/cloudflare";

const NOW = Math.floor(Date.now() / 1000);
const noCtx = { listEntities: async () => [] };
const cfEnv = { ...env, CLOUDFLARE_API_TOKEN: "cf-test-token", CF_ACCOUNT_ID: "acct123" } as unknown as Env;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

afterEach(() => vi.unstubAllGlobals());

function stubCf(errors: number, requests: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/graphql")) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    { dimensions: { scriptName: "ops", date: "2026-08-11" }, sum: { requests: 500, errors: 2 } },
                    { dimensions: { scriptName: "ops", date: "2026-08-12" }, sum: { requests, errors } },
                  ],
                },
              ],
            },
          },
        });
      }
      if (url.includes("/d1/database")) {
        return Response.json({ result: [{ uuid: "uuid-1", name: "ops", file_size: 12_582_912 }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

describe("cloudflare poller", () => {
  it("emits per-worker daily traffic and flags elevated error rates", async () => {
    stubCf(30, 1000); // 3% error rate on the latest day
    const result = await cloudflare.poll(cfEnv, noCtx);

    expect(result.entities.map((e) => e.id).sort()).toEqual(["d1:ops", "worker:ops"]);

    const requests = result.signals.filter((s) => s.metric === "cf.requests");
    expect(requests).toHaveLength(2); // one per daily bucket, dedupe on period start
    expect(requests[0]?.dedupeKey).toBe(String(Math.floor(Date.parse("2026-08-11") / 1000)));

    const rate = result.signals.find((s) => s.metric === "cf.error_rate");
    expect(rate?.valueNum).toBe(3);
    expect(rate?.severity).toBe(2); // >1%

    const size = result.signals.find((s) => s.metric === "d1.size_bytes");
    expect(size?.valueNum).toBe(12_582_912);
  });

  it("does not flag error rates on tiny samples", async () => {
    stubCf(5, 50); // 10% but only 50 requests
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(result.signals.find((s) => s.metric === "cf.error_rate")).toBeUndefined();
  });

  it("reports unconfigured calmly without a token", async () => {
    await expect(cloudflare.poll({ ...cfEnv, CLOUDFLARE_API_TOKEN: undefined } as unknown as Env, noCtx)).rejects.toThrow(
      /^unconfigured/,
    );
  });
});

describe("findings bands + entity clustering", () => {
  it("bands by urgency and renders an entity's name once per cluster", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "repo:x/deprep", kind: "repo", category: "web_app", name: "deprep", sourceUrl: "https://github.com/x/deprep" },
        { id: "repo:x/other", kind: "repo", category: "web_app", name: "otherrepo" },
      ],
      NOW,
    );
    await insertSignals(env.DB, "github", [
      { entityId: "repo:x/deprep", metric: "ci.status", valueText: "failure", severity: 3, observedAt: NOW, dedupeKey: "a" },
      { entityId: "repo:x/deprep", metric: "deps.vuln_count", valueNum: 2, severity: 2, observedAt: NOW, dedupeKey: "b" },
      { entityId: "repo:x/deprep", metric: "prs.oldest_days", valueNum: 20, severity: 2, observedAt: NOW, dedupeKey: "c" },
      { entityId: "repo:x/other", metric: "deps.vuln_count", valueNum: 1, severity: 2, observedAt: NOW, dedupeKey: "d" },
    ]);

    const html = await (await SELF.fetch("https://ops.local/findings")).text();

    // bands present with the right membership
    expect(html).toContain("Act now");
    expect(html).toContain("Plan");
    expect(html.split("Plan")[0]).toContain("CI status"); // sev3 in Act now
    expect(html.split("Plan")[1]).toContain("Dependabot vulns"); // sev2 in Plan

    // deprep's two Plan findings cluster: entity link rendered once in that band
    const planBand = html.split("Plan <span")[1] ?? "";
    const deprepLinks = planBand.split('href="/e/repo:x/deprep"').length - 1;
    // one name link + two data-href row attrs = clustering keeps rows but not repeated names
    expect((planBand.match(/>deprep</g) ?? []).length).toBe(1);
    expect(deprepLinks).toBeGreaterThan(0);
  });
});
