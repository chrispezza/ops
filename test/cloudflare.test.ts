import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertSignals, upsertEntities } from "../src/core/store";
import { cloudflare } from "../src/pollers/cloudflare";

const NOW = Math.floor(Date.now() / 1000);
const noCtx = { listEntities: async () => [] };
// Allowances left empty: the tests assert against the free-tier caps whatever
// wrangler.jsonc says this deployment is on.
const cfEnv = {
  ...env,
  CLOUDFLARE_API_TOKEN: "cf-test-token",
  CF_ACCOUNT_ID: "acct123",
  D1_ROW_READS_PER_DAY: "",
  D1_ROW_WRITES_PER_DAY: "",
} as unknown as Env;

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

interface D1Row {
  date: string;
  rowsRead: number;
  rowsWritten?: number;
  databaseId?: string;
}

const DEFAULT_DBS = [{ uuid: "uuid-1", name: "ops", file_size: 12_582_912 }];

// token lists by source; a number is the HTTP status that source answers with
type TokenList = Record<string, unknown>[] | number;
function stubCf(rows: Row[], d1Rows: D1Row[] = [], databases = DEFAULT_DBS, tokens: { user?: TokenList; account?: TokenList } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/graphql") && String(init?.body).includes("d1AnalyticsAdaptiveGroups")) {
        return Response.json({
          data: {
            viewer: {
              accounts: [
                {
                  d1AnalyticsAdaptiveGroups: d1Rows.map((r) => ({
                    dimensions: { databaseId: r.databaseId ?? "uuid-1", date: r.date },
                    sum: { rowsRead: r.rowsRead, rowsWritten: r.rowsWritten ?? 0 },
                  })),
                },
              ],
            },
          },
        });
      }
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
      if (url.includes("/tokens")) {
        const source = url.includes("/user/tokens") ? tokens.user : tokens.account;
        if (typeof source === "number") return new Response("{}", { status: source });
        if (source === undefined) return new Response("{}", { status: 403 });
        return Response.json({ result: source, result_info: { page: 1, total_pages: 1 } });
      }
      if (url.includes("/d1/database")) {
        return Response.json({ result: databases });
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

  it("rates the account's D1 row reads against the daily allowance on the last complete day", async () => {
    stubCf(
      [{ date: day(1), status: "success", requests: 100 }],
      [
        { date: day(2), rowsRead: 4_116_167, rowsWritten: 68_702 },
        { date: day(1), rowsRead: 5_829_841, rowsWritten: 53_703 },
        { date: day(1), rowsRead: 105_487, databaseId: "uuid-2" }, // second database, listed below
        { date: day(0), rowsRead: 5_925_159 }, // today's partial bucket: recorded, never judged
        { date: day(1), rowsRead: 999, databaseId: "uuid-unlisted" }, // not in the list call → dropped
      ],
      [
        { uuid: "uuid-1", name: "ops", file_size: 45_780_992 },
        { uuid: "uuid-2", name: "pantry-intel", file_size: 200_704 },
      ],
    );
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(result.entities.map((e) => e.id).sort()).toEqual(["cf:account", "d1:ops", "d1:pantry-intel", "worker:ops"]);

    const reads = result.signals.filter((s) => s.metric === "d1.rows_read");
    expect(reads).toHaveLength(4); // 3 ops buckets + 1 pantry-intel; the unlisted database emits nothing
    expect(reads.find((s) => s.entityId === "d1:ops" && s.dedupeKey === String(Math.floor(Date.parse(day(1)) / 1000)))?.valueNum).toBe(5_829_841);

    const cap = result.signals.find((s) => s.metric === "d1.read_cap_pct");
    expect(cap?.entityId).toBe("cf:account");
    expect(cap?.valueNum).toBe(118.7); // (5,829,841 + 105,487) / 5,000,000
    expect(cap?.severity).toBe(3);
    expect(cap?.valueText).toBe(`5.94M of 5.00M rows read on ${day(1)} · ops 5.83M, pantry-intel 105k`);

    // Writes are judged the same way against their own, smaller allowance.
    const writes = result.signals.find((s) => s.metric === "d1.write_cap_pct");
    expect(writes?.entityId).toBe("cf:account");
    expect(writes?.valueNum).toBe(53.7); // 53,703 / 100,000; pantry-intel wrote nothing
    expect(writes?.severity).toBe(0);
    expect(writes?.valueText).toBe(`54k of 100k rows written on ${day(1)} · ops 54k, pantry-intel 0`);
  });

  it("rates D1 row writes against the daily write allowance (ADR-007)", async () => {
    // 2026-09-18: a migration's index build over the signals table wrote one
    // row per existing row and spent the day's allowance before 02:00 UTC.
    stubCf([{ date: day(1), status: "success", requests: 100 }], [{ date: day(1), rowsRead: 1_861_015, rowsWritten: 132_164 }]);
    let cap = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "d1.write_cap_pct");
    expect(cap).toMatchObject({ valueNum: 132.2, severity: 3 });
    expect(cap?.valueText).toBe(`132k of 100k rows written on ${day(1)} · ops 132k`);

    // Steady state after 0005 sits in the warning band; a clean day before it did not.
    stubCf([{ date: day(1), status: "success", requests: 100 }], [{ date: day(1), rowsRead: 4_931_499, rowsWritten: 81_400 }]);
    cap = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "d1.write_cap_pct");
    expect(cap).toMatchObject({ valueNum: 81.4, severity: 2 });

    stubCf([{ date: day(1), status: "success", requests: 100 }], [{ date: day(1), rowsRead: 4_931_499, rowsWritten: 74_059 }]);
    cap = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "d1.write_cap_pct");
    expect(cap).toMatchObject({ valueNum: 74.1, severity: 0 });
  });

  it("warns at 80% of the D1 allowance and stays calm below it", async () => {
    stubCf([{ date: day(1), status: "success", requests: 100 }], [{ date: day(1), rowsRead: 4_100_000 }]);
    let cap = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "d1.read_cap_pct");
    expect(cap).toMatchObject({ valueNum: 82, severity: 2 });

    stubCf([{ date: day(1), status: "success", requests: 100 }], [{ date: day(1), rowsRead: 150_000 }]);
    cap = (await cloudflare.poll(cfEnv, noCtx)).signals.find((s) => s.metric === "d1.read_cap_pct");
    expect(cap).toMatchObject({ valueNum: 3, severity: 0 });

    // no D1 activity at all: nothing to judge, no account entity
    stubCf([{ date: day(1), status: "success", requests: 100 }], []);
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(result.signals.find((s) => s.metric === "d1.read_cap_pct")).toBeUndefined();
    expect(result.entities.find((e) => e.id === "cf:account")).toBeUndefined();
  });

  it("warns the same morning when today's running total is already over (#53)", async () => {
    // 2026-09-18 shape: a calm yesterday, then a migration spends the write
    // allowance before 02:00. Judging only the complete day would say nothing
    // until tomorrow's run.
    stubCf(
      [{ date: day(1), status: "success", requests: 100 }],
      [
        { date: day(1), rowsRead: 1_000_000, rowsWritten: 60_000 },
        { date: day(0), rowsRead: 400_000, rowsWritten: 132_164 },
      ],
    );
    const result = await cloudflare.poll(cfEnv, noCtx);
    const writes = result.signals.find((s) => s.metric === "d1.write_cap_pct");
    expect(writes).toMatchObject({ valueNum: 132.2, severity: 3 });
    expect(writes?.valueText).toBe(`132k of 100k rows written so far today (${day(0)}) · ops 132k`);
    // Reads: yesterday is the worse day, so yesterday's figure stands.
    const reads = result.signals.find((s) => s.metric === "d1.read_cap_pct");
    expect(reads).toMatchObject({ valueNum: 20, severity: 0 });
    expect(reads?.valueText).toBe(`1.00M of 5.00M rows read on ${day(1)} · ops 1.00M`);
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

describe("cloudflare token inventory (#98)", () => {
  const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
  const token = (name: string, o: Record<string, unknown> = {}) => ({
    id: `id-${name}`,
    name,
    status: "active",
    issued_on: iso(-200),
    expires_on: null,
    policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.acct123": "*" } }],
    ...o,
  });
  const sig = (result: { signals: { entityId: string; metric: string }[] }, metric: string) =>
    result.signals.find((s) => s.entityId === "cf:account" && s.metric === metric) as
      | { valueNum?: number; valueText?: string; severity?: number }
      | undefined;

  it("emits the five account signals from user- and account-owned lists", async () => {
    stubCf([], [], DEFAULT_DBS, {
      user: [
        token("ops poller", { policies: [{ effect: "allow", resources: { "com.cloudflare.api.account.*": "*" } }], expires_on: iso(3) }),
        token("old ci", { expires_on: iso(20) }),
        token("agent", { issued_on: iso(-1) }),
        token("lapsed", { expires_on: iso(-5) }), // past expiry: not a live surface
        token("off", { status: "disabled" }),
      ],
      account: [token("builds", { expires_on: iso(200) })],
    });
    const result = await cloudflare.poll(cfEnv, noCtx);

    expect(sig(result, "cf.tokens.count")).toMatchObject({ valueNum: 4, valueText: "4 active of 6 listed" });
    expect(sig(result, "cf.tokens.expiring_30d")).toMatchObject({ valueNum: 2, severity: 3 }); // one inside 7d
    expect(sig(result, "cf.tokens.expiring_30d")?.valueText).toContain("ops poller");
    expect(sig(result, "cf.tokens.no_expiry")).toMatchObject({ valueNum: 1, valueText: "agent", severity: 0 });
    expect(sig(result, "cf.tokens.all_accounts")).toMatchObject({ valueNum: 1, valueText: "ops poller", severity: 1 });
    expect(sig(result, "cf.tokens.new_7d")).toMatchObject({ valueNum: 1, valueText: "agent", severity: 1 });
    expect(result.entities.some((e) => e.id === "cf:account")).toBe(true);
    expect(result.notes ?? []).toEqual([]);
  });

  it("keeps the D1 signals and says what to grant when neither list is readable", async () => {
    stubCf([], [{ date: day(1), rowsRead: 1_000, rowsWritten: 10 }], DEFAULT_DBS, { user: 403, account: 403 });
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(result.signals.some((s) => s.metric.startsWith("cf.tokens."))).toBe(false);
    expect(result.signals.some((s) => s.metric === "d1.read_cap_pct")).toBe(true);
    expect(result.notes).toEqual([
      "cloudflare: user token list unavailable (HTTP 403); grant API Tokens Read to inventory them",
      "cloudflare: account token list unavailable (HTTP 403); grant Account API Tokens Read to inventory them",
    ]);
  });

  it("reports zero rather than going silent when the live token set is clean", async () => {
    stubCf([], [], DEFAULT_DBS, { account: [token("builds", { expires_on: iso(300) })], user: 401 });
    const result = await cloudflare.poll(cfEnv, noCtx);
    expect(sig(result, "cf.tokens.expiring_30d")).toMatchObject({ valueNum: 0, severity: 0 });
    expect(sig(result, "cf.tokens.all_accounts")).toMatchObject({ valueNum: 0, severity: 0 });
    expect(result.notes).toEqual(["cloudflare: user token list unavailable (HTTP 401); grant API Tokens Read to inventory them"]);
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
