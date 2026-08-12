import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { budgetSpent } from "../src/core/derive";
import { compactSignals } from "../src/core/retention";
import { insertSignals, upsertEntities } from "../src/core/store";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signals"),
    env.DB.prepare("DELETE FROM entities"),
    env.DB.prepare("DELETE FROM budgets"),
  ]);
});

describe("signal compaction (issue #4)", () => {
  it("keeps the newest row per day for old state signals, leaves recent and interval rows alone", async () => {
    await upsertEntities(env.DB, [{ id: "repo:a/x", kind: "repo", name: "x" }], NOW);

    const oldDay = NOW - 40 * DAY - ((NOW - 40 * DAY) % DAY);
    // six hourly observations on one old day + two on a recent day
    await insertSignals(
      env.DB,
      "github",
      [0, 1, 2, 3, 4, 5].map((h) => ({
        entityId: "repo:a/x",
        metric: "issues.open",
        valueNum: h,
        observedAt: oldDay + h * 3600,
        dedupeKey: String(oldDay + h * 3600),
      })),
    );
    await insertSignals(env.DB, "github", [
      { entityId: "repo:a/x", metric: "issues.open", valueNum: 8, observedAt: NOW - 3600, dedupeKey: String(NOW - 3600) },
      { entityId: "repo:a/x", metric: "issues.open", valueNum: 9, observedAt: NOW, dedupeKey: String(NOW) },
    ]);
    // old interval signal must never be compacted
    await insertSignals(env.DB, "anthropic_usage", [
      { entityId: "repo:a/x", metric: "spend.usd", valueNum: 5, observedAt: oldDay, period: { start: oldDay - DAY, end: oldDay }, dedupeKey: String(oldDay - DAY) },
    ]);

    const removed = await compactSignals(env.DB, NOW);
    expect(removed).toBe(5); // six old hourly rows → one survivor

    const rows = await env.DB.prepare(
      "SELECT metric, value_num FROM signals WHERE entity_id='repo:a/x' ORDER BY observed_at",
    ).all<{ metric: string; value_num: number }>();
    const issueValues = rows.results.filter((r) => r.metric === "issues.open").map((r) => r.value_num);
    expect(issueValues).toEqual([5, 8, 9]); // newest-of-old-day survives; recent rows untouched
    expect(rows.results.some((r) => r.metric === "spend.usd")).toBe(true);
  });
});

describe("kind-scoped budget bars (issue #7)", () => {
  it("computes true kind-scoped spend, not the org total", async () => {
    const day = NOW - (NOW % DAY);
    await upsertEntities(
      env.DB,
      [
        { id: "api_key:a", kind: "api_key", name: "a" },
        { id: "vendor_api:anthropic", kind: "vendor_api", name: "Anthropic" },
      ],
      NOW,
    );
    const spend = (entityId: string, usd: number) => ({
      entityId,
      metric: "spend.usd",
      valueNum: usd,
      observedAt: day + DAY,
      period: { start: day, end: day + DAY },
      dedupeKey: String(day),
    });
    await insertSignals(env.DB, "t", [spend("api_key:a", 10), spend("vendor_api:anthropic", 40)]);

    const kindBudget = { id: 1, scope: "api_key", metric: "spend.usd", period: "month", soft_limit: 25, hard_limit: 60 };
    expect(await budgetSpent(env.DB, kindBudget, NOW)).toBe(10); // not 50
    const orgBudget = { ...kindBudget, scope: "*" };
    expect(await budgetSpent(env.DB, orgBudget, NOW)).toBe(50);
  });
});

describe("trend sparklines (issue #5)", () => {
  it("renders a trend for metrics with history, none for two-point metrics", async () => {
    await upsertEntities(env.DB, [{ id: "repo:a/x", kind: "repo", category: "web_app", name: "x" }], NOW);
    await insertSignals(
      env.DB,
      "github",
      [5, 4, 3, 2, 1].map((d) => ({
        entityId: "repo:a/x",
        metric: "ci.duration_ms",
        valueNum: 100_000 + d * 10_000,
        observedAt: NOW - d * DAY,
        dedupeKey: String(NOW - d * DAY),
      })),
    );
    await insertSignals(env.DB, "github", [
      { entityId: "repo:a/x", metric: "deps.vuln_count", valueNum: 1, observedAt: NOW - DAY, dedupeKey: "a" },
      { entityId: "repo:a/x", metric: "deps.vuln_count", valueNum: 2, observedAt: NOW, dedupeKey: "b" },
    ]);

    const html = await (await SELF.fetch("https://ops.local/e/repo:a/x")).text();
    // one trend svg (ci.duration_ms has 5 points; vulns only 2 → no trend)
    expect(html.match(/class="trend"/g)?.length).toBe(1);
  });
});
