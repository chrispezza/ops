import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BalanceEntry, deriveBalances } from "../src/core/derive";
import { latestSignals, putSetting } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";
import { openaiCosts } from "../src/pollers/openai-costs";
import { xUsage } from "../src/pollers/x-usage";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const noCtx = { listEntities: async () => [] };

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signals"),
    env.DB.prepare("DELETE FROM entities"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

describe("openai_costs poller", () => {
  it("emits dollar amounts per daily bucket, keyed on bucket start", async () => {
    const start = NOW - (NOW % DAY) - DAY;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          object: "page",
          data: [
            {
              object: "bucket",
              start_time: start,
              end_time: start + DAY,
              results: [
                { object: "organization.costs.result", amount: { value: 0.06, currency: "usd" } },
                { object: "organization.costs.result", amount: { value: 1.94, currency: "usd" } },
              ],
            },
          ],
          has_more: false,
          next_page: null,
        }),
      ),
    );

    const result = await openaiCosts.poll({ ...env, OPENAI_ADMIN_KEY: "sk-admin-test" } as Env, noCtx);
    expect(result.entities[0]?.id).toBe("vendor_api:openai");
    const spend = result.signals[0];
    expect(spend?.metric).toBe("spend.usd");
    expect(spend?.valueNum).toBeCloseTo(2.0); // dollars, not cents
    expect(spend?.dedupeKey).toBe(String(start));
  });

  it("reports unconfigured calmly when the key is missing", async () => {
    await expect(openaiCosts.poll({ ...env, OPENAI_ADMIN_KEY: undefined } as unknown as Env, noCtx)).rejects.toThrow(
      /^unconfigured/,
    );
  });
});

describe("x_usage poller", () => {
  it("computes cap percentage with near-cap severity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ data: { cap_reset_day: 10, project_cap: "10000", project_usage: "8500" } }),
      ),
    );
    const result = await xUsage.poll({ ...env, X_BEARER_TOKEN: "bearer-test" } as Env, noCtx);
    const pct = result.signals.find((s) => s.metric === "usage.cap_pct");
    expect(pct?.valueNum).toBe(85);
    expect(pct?.severity).toBe(2); // >=80%
    expect(result.signals.find((s) => s.metric === "usage.monthly_posts")?.valueText).toBe("8500 of 10000");
  });
});

describe("prepaid balances", () => {
  it("derives remaining from starting balance minus observed spend, with low/empty severities", async () => {
    const asOf = NOW - 10 * DAY;
    await putSetting(env.DB, "balances", [
      { entityId: "vendor_api:anthropic", name: "Anthropic", startingUsd: 40, asOf },
      { entityId: "vendor_api:xai", name: "xAI", startingUsd: 25, asOf }, // no spend data at all
    ] satisfies BalanceEntry[]);

    await upsertEntities(env.DB, [{ id: "vendor_api:anthropic", kind: "vendor_api", name: "Anthropic" }], NOW);
    const day = NOW - (NOW % DAY);
    await insertSignals(env.DB, "anthropic_usage", [
      { entityId: "vendor_api:anthropic", metric: "spend.usd", valueNum: 35, observedAt: NOW, period: { start: day, end: day + DAY }, dedupeKey: String(day) },
    ]);

    await deriveBalances(env.DB, NOW);

    const anthropic = (await latestSignals(env.DB, "vendor_api:anthropic")).find((s) => s.metric === "balance.usd");
    expect(anthropic?.value_num).toBe(5);
    expect(anthropic?.severity).toBe(2); // 5/40 = 12.5% < 20%

    // balance-only vendor: entity auto-created, full balance, calm
    const xai = (await latestSignals(env.DB, "vendor_api:xai")).find((s) => s.metric === "balance.usd");
    expect(xai?.value_num).toBe(25);
    expect(xai?.severity).toBe(0);

    // spend past the starting amount → empty, severity 3
    await insertSignals(env.DB, "anthropic_usage", [
      { entityId: "vendor_api:anthropic", metric: "spend.usd", valueNum: 45, observedAt: NOW, period: { start: day, end: day + DAY }, dedupeKey: String(day) },
    ]);
    await deriveBalances(env.DB, NOW + 60);
    const empty = (await latestSignals(env.DB, "vendor_api:anthropic")).find((s) => s.metric === "balance.usd");
    expect(empty?.value_num).toBe(-5);
    expect(empty?.severity).toBe(3);
  });

  it("shows balance rows on /spend even for vendors with no spend data", async () => {
    await putSetting(env.DB, "balances", [
      { entityId: "vendor_api:xai", name: "xAI", startingUsd: 25, asOf: NOW - DAY },
    ] satisfies BalanceEntry[]);
    await deriveBalances(env.DB, NOW);

    const html = await (await SELF.fetch("https://ops.local/spend")).text();
    expect(html).toContain("xAI");
    expect(html).toContain("bal $25.00");
  });
});

describe("archived section", () => {
  it("lists archived entities in a collapsed section, out of the working set", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "repo:a/dead", kind: "repo", category: "tooling", name: "dead-thing", owner: "chrispezza" },
        { id: "repo:a/alive", kind: "repo", category: "web_app", name: "alive-thing", owner: "chrispezza" },
      ],
      NOW,
    );
    await env.DB.prepare("UPDATE entities SET archived = 1 WHERE id = 'repo:a/dead'").run();

    const html = await (await SELF.fetch("https://ops.local/")).text();
    expect(html).toContain("archived-section");
    expect(html).toContain("dead-thing");
    // archived stays out of the category sections and triage
    const triage = await (await SELF.fetch("https://ops.local/triage")).text();
    expect(triage).not.toContain("dead-thing");
  });
});
