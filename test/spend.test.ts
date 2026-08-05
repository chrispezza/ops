import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectSpendAnomalies, evaluateBudgets } from "../src/core/derive";
import { latestSignals } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";
import { anthropicUsage } from "../src/pollers/anthropic-usage";

const DAY = 86_400;
const NOW = 1_754_400_000;
const TODAY = NOW - (NOW % DAY);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signals"),
    env.DB.prepare("DELETE FROM entities"),
    env.DB.prepare("DELETE FROM budgets"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

async function seedSpend(days: Record<number, number>, entityId = "vendor_api:anthropic", base = TODAY) {
  await upsertEntities(env.DB, [{ id: entityId, kind: "vendor_api", name: "Anthropic" }], NOW);
  await insertSignals(
    env.DB,
    "anthropic_usage",
    Object.entries(days).map(([daysAgo, usd]) => {
      const start = base - Number(daysAgo) * DAY;
      return {
        entityId,
        metric: "spend.usd",
        valueNum: usd,
        observedAt: start + DAY,
        period: { start, end: start + DAY },
        dedupeKey: String(start),
      };
    }),
  );
}

describe("anthropic_usage poller", () => {
  it("converts cent-strings to USD and keys intervals on period_start", async () => {
    const day1 = { starting_at: "2026-08-01T00:00:00Z", ending_at: "2026-08-02T00:00:00Z" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/cost_report")) {
          return Response.json({
            data: [{ ...day1, results: [{ amount: "123.78912", currency: "USD" }, { amount: "100", currency: "USD" }] }],
            has_more: false,
            next_page: null,
          });
        }
        if (url.includes("/usage_report/messages")) {
          return Response.json({
            data: [
              {
                ...day1,
                results: [
                  {
                    api_key_id: "apikey_01abc",
                    uncached_input_tokens: 1500,
                    cache_read_input_tokens: 200,
                    cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 500 },
                    output_tokens: 500,
                  },
                  { api_key_id: null, uncached_input_tokens: 9, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens: 9 },
                ],
              },
            ],
            has_more: false,
            next_page: null,
          });
        }
        if (url.includes("/api_keys")) {
          return Response.json({ data: [{ id: "apikey_01abc", name: "clownbot-gateway" }] });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const result = await anthropicUsage.poll({ ...env, ANTHROPIC_ADMIN_KEY: "sk-ant-admin-test" } as Env, {});

    const spend = result.signals.find((s) => s.metric === "spend.usd");
    expect(spend?.entityId).toBe("vendor_api:anthropic");
    expect(spend?.valueNum).toBeCloseTo(2.2378912); // (123.78912 + 100) cents
    const periodStart = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
    expect(spend?.dedupeKey).toBe(String(periodStart));
    expect(spend?.period).toEqual({ start: periodStart, end: periodStart + DAY });

    // per-key usage, named from the api_keys listing; null-key rows skipped
    const key = result.entities.find((e) => e.id === "api_key:apikey_01abc");
    expect(key?.name).toBe("clownbot-gateway");
    const tokensIn = result.signals.find((s) => s.metric === "usage.tokens_in");
    expect(tokensIn?.valueNum).toBe(1500 + 200 + 1000 + 500);
    expect(result.signals.filter((s) => s.metric === "usage.tokens_out")).toHaveLength(1);
  });
});

describe("budget evaluation", () => {
  it("emits soft/hard crossings once per period and resolves in place", async () => {
    await seedSpend({ 0: 30 });
    await env.DB.prepare(
      "INSERT INTO budgets (scope, metric, period, soft_limit, hard_limit) VALUES ('*', 'spend.usd', 'month', 25, 60)",
    ).run();

    await evaluateBudgets(env.DB, NOW);
    let status = (await latestSignals(env.DB, "budget:*")).find((s) => s.metric === "budget.status");
    expect(status?.severity).toBe(2); // soft crossed

    // re-evaluation with more spend updates the same row to hard severity
    await seedSpend({ 0: 70 });
    await evaluateBudgets(env.DB, NOW + 3600);
    const all = (await latestSignals(env.DB, "budget:*")).filter((s) => s.metric === "budget.status");
    expect(all).toHaveLength(1);
    expect(all[0]?.severity).toBe(4);
  });

  it("scopes budgets to a single entity", async () => {
    await seedSpend({ 0: 10 }, "api_key:a");
    await seedSpend({ 0: 50 }, "api_key:b");
    await env.DB.prepare(
      "INSERT INTO budgets (scope, metric, period, soft_limit, hard_limit) VALUES ('api_key:a', 'spend.usd', 'month', 25, 60)",
    ).run();
    await evaluateBudgets(env.DB, NOW);
    const status = (await latestSignals(env.DB, "api_key:a")).find((s) => s.metric === "budget.status");
    expect(status?.severity).toBe(0); // a spent 10 < 25; b's 50 must not leak in
  });
});

describe("spend anomaly", () => {
  it("flags today > 3× trailing-7-day median, resolves when normal", async () => {
    await seedSpend({ 7: 2, 6: 2, 5: 2, 4: 2.5, 3: 2, 2: 1.5, 1: 2, 0: 9 });
    await detectSpendAnomalies(env.DB, NOW);
    let anomaly = (await latestSignals(env.DB, "vendor_api:anthropic")).find((s) => s.metric === "spend.anomaly");
    expect(anomaly?.severity).toBe(2); // 9 > 3×2

    // the day settles back down → same row resolves to severity 0
    await seedSpend({ 0: 3 });
    await detectSpendAnomalies(env.DB, NOW + 3600);
    anomaly = (await latestSignals(env.DB, "vendor_api:anthropic")).find((s) => s.metric === "spend.anomaly");
    expect(anomaly?.severity).toBe(0);
  });
});

describe("spend + settings pages", () => {
  it("renders MTD, sparkline, and budget bars", async () => {
    // the route uses the real clock — seed relative to it
    const realToday = Math.floor(Date.now() / 1000 / DAY) * DAY;
    await seedSpend({ 2: 5, 1: 4, 0: 2.1 }, "vendor_api:anthropic", realToday);
    await env.DB.prepare(
      "INSERT INTO budgets (scope, metric, period, soft_limit, hard_limit) VALUES ('*', 'spend.usd', 'month', 25, 60)",
    ).run();
    const html = await (await SELF.fetch("https://ops.local/spend")).text();
    expect(html).toContain("svg");
    expect(html).toContain("spark-bar today"); // provisional hollow bar
    expect(html).toContain("budget-bar");
    expect(html).toContain("Anthropic");
  });

  it("stores weight overrides that change triage scoring", async () => {
    const form = new FormData();
    form.set("severity_factor", "100");
    form.set("breadth_factor", "2");
    form.set("staleness_30", "3");
    form.set("staleness_90", "6");
    form.set("zero_usage_bonus", "5");
    await SELF.fetch("https://ops.local/settings/weights", { method: "POST", body: form, redirect: "manual" });

    await upsertEntities(env.DB, [{ id: "repo:x", kind: "repo", category: "web_app", name: "xrepo" }], NOW);
    await insertSignals(env.DB, "github", [
      { entityId: "repo:x", metric: "ci.status", valueText: "failure", severity: 3, observedAt: NOW, dedupeKey: "r" },
    ]);
    const html = await (await SELF.fetch("https://ops.local/triage")).text();
    expect(html).toContain("300"); // 100 × severity 3 — override in effect
  });
});
