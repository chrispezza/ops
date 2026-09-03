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

// Dates relative to now, so "today" is the partial bucket the poller must ignore.
const day = (agoDays: number) => new Date(Date.now() - agoDays * 86_400_000).toISOString().slice(0, 10);
interface Row {
  date: string;
  status: string;
  requests: number;
  script?: string;
}

function stubCf(rows: Row[]) {
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
                  workersInvocationsAdaptive: rows.map((r) => ({
                    dimensions: { scriptName: r.script ?? "ops", date: r.date, status: r.status },
                    sum: { requests: r.requests },
                  })),
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
  it("emits per-worker daily traffic and rates the last complete day, not today's partial bucket", async () => {
    stubCf([
      { date: day(2), status: "success", requests: 498 },
      { date: day(2), status: "scriptThrew", requests: 2 },
      { date: day(1), status: "success", requests: 970 },
      { date: day(1), status: "scriptThrew", requests: 30 },
      // today so far: 5 of 10 failed — a 50% rate that must not be reported
      { date: day(0), status: "success", requests: 5 },
      { date: day(0), status: "scriptThrew", requests: 5 },
    ]);
    const result = await cloudflare.poll(cfEnv, noCtx);

    expect(result.entities.map((e) => e.id).sort()).toEqual(["d1:ops", "worker:ops"]);

    const requests = result.signals.filter((s) => s.metric === "cf.requests");
    expect(requests).toHaveLength(3); // one per daily bucket, dedupe on period start
    expect(requests.find((s) => s.dedupeKey === String(Math.floor(Date.parse(day(2)) / 1000)))?.valueNum).toBe(500);

    const rate = result.signals.find((s) => s.metric === "cf.error_rate");
    expect(rate?.valueNum).toBe(3); // 30 of 1000 on the last complete day
    expect(rate?.severity).toBe(2); // >1%
    expect(rate?.valueText).toBe(`30 of 1000 requests on ${day(1)}`);

    const size = result.signals.find((s) => s.metric === "d1.size_bytes");
    expect(size?.valueNum).toBe(12_582_912);
  });

  it("falls back to the complete window when the last day is thin, and never goes silent", async () => {
    stubCf([
      { date: day(2), status: "success", requests: 396 },
      { date: day(2), status: "scriptThrew", requests: 4 },
      { date: day(1), status: "success", requests: 45 },
      { date: day(1), status: "scriptThrew", requests: 5 },
    ]);
    let rate = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "cf.error_rate");
    expect(rate?.valueNum).toBe(2); // 9 of 450 across both complete days
    expect(rate?.severity).toBe(2);
    expect(rate?.valueText).toBe("9 of 450 requests over 2 days");

    // A thin window is still reported — calmly — so a stale state can't stand as truth
    stubCf([
      { date: day(1), status: "success", requests: 45 },
      { date: day(1), status: "scriptThrew", requests: 5 },
    ]);
    rate = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "cf.error_rate");
    expect(rate?.valueNum).toBe(10);
    expect(rate?.severity).toBe(0);
    expect(rate?.valueText).toBe(`5 of 50 requests on ${day(1)} (small sample)`);
  });

  it("counts only app-caused outcomes as errors (deprep#63)", async () => {
    stubCf([
      { date: day(1), status: "success", requests: 196 },
      { date: day(1), status: "loadShed", requests: 3 },
      { date: day(1), status: "clientDisconnected", requests: 17 },
    ]);
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(result.signals.find((s) => s.metric === "cf.requests")?.valueNum).toBe(216);
    expect(result.signals.find((s) => s.metric === "cf.errors")?.valueNum).toBe(0);
    const rate = result.signals.find((s) => s.metric === "cf.error_rate");
    expect(rate).toMatchObject({ valueNum: 0, severity: 0, valueText: `0 of 216 requests on ${day(1)}` });
  });

  it("skips the rate for a worker with no complete day yet, and reports unconfigured calmly", async () => {
    stubCf([{ date: day(0), status: "scriptThrew", requests: 500 }]);
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(result.signals.find((s) => s.metric === "cf.error_rate")).toBeUndefined();
    expect(result.signals.find((s) => s.metric === "cf.requests")?.valueNum).toBe(500);

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
