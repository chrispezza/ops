import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EXPECTED_METRICS } from "../src/config";
import { emitHygieneSignals } from "../src/core/derive";
import { latestSignals } from "../src/core/queries";
import { runPollers } from "../src/core/runner";
import { insertSignals } from "../src/core/store";
import type { Poller, PollerResult } from "../src/pollers/types";

// ADR-008. Own file: storage is shared within a test file.

const NOW = 1_754_400_000;
const HOUR = 3600;

const fake = (result: () => PollerResult | Promise<PollerResult>, overrides: Partial<Poller> = {}): Poller => ({
  id: "fake",
  schedule: "hourly",
  retractUnobserved: true,
  metricSemantics: { "ci.status": "state", "ci.fail_streak": "state", "spend.usd": "interval" },
  poll: async () => result(),
  ...overrides,
});

const repo = (name: string, archived?: true) => ({ id: `repo:a/${name}`, kind: "repo" as const, category: "web_app", name, ...(archived ? { archived } : {}) });
const sig = (name: string, metric: string, observedAt: number, extra: object = {}) => ({
  entityId: `repo:a/${name}`,
  metric,
  valueText: "failure",
  severity: 3 as const,
  observedAt,
  dedupeKey: `${metric}:${observedAt}`,
  ...extra,
});
const metrics = async (name: string) => (await latestSignals(env.DB, `repo:a/${name}`)).map((s) => s.metric).sort();

describe("retraction of unobserved state metrics (ADR-008)", () => {
  it("drops the pointer of a metric the poller stopped emitting and keeps its history", async () => {
    const first = fake(() => ({
      entities: [repo("app"), repo("other"), repo("frozen")],
      signals: [
        sig("app", "ci.status", NOW),
        sig("app", "ci.fail_streak", NOW),
        sig("app", "spend.usd", NOW),
        sig("other", "ci.status", NOW),
        sig("frozen", "ci.status", NOW),
      ],
    }));
    await runPollers(env, "hourly", { pollers: [first], now: NOW });
    // the same metric name pushed by CI is not the poller's to retract
    await insertSignals(env.DB, "ci_ingest", [sig("other", "ci.fail_streak", NOW)]);

    // next hour: app lost its checks, other is not returned at all, frozen was archived
    const second = fake(() => ({
      entities: [repo("app"), repo("frozen", true)],
      signals: [sig("app", "ci.fail_streak", NOW + HOUR, { severity: 0 })],
    }));
    const [summary] = await runPollers(env, "hourly", { pollers: [second], now: NOW + HOUR });

    expect(summary?.retracted).toBe(1);
    expect(await metrics("app")).toEqual(["ci.fail_streak", "spend.usd"]); // interval metric untouched
    expect(await metrics("other")).toEqual(["ci.fail_streak", "ci.status"]); // not seen this run
    expect(await metrics("frozen")).toEqual(["ci.status"]); // archived: frozen, not monitored

    const history = await env.DB.prepare("SELECT COUNT(*) AS n FROM signals WHERE entity_id = 'repo:a/app' AND metric = 'ci.status'").first<{ n: number }>();
    expect(history?.n).toBe(1); // ADR-002: the row itself stays

    // an expected metric that is no longer current is missing again
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW + HOUR);
    const missing = (await latestSignals(env.DB, "repo:a/app")).find((s) => s.metric === "hygiene.missing.ci.status");
    expect(missing?.severity).toBe(1);

    // and it is current again the moment it returns
    const third = fake(() => ({ entities: [repo("app")], signals: [sig("app", "ci.status", NOW + 2 * HOUR), sig("app", "ci.fail_streak", NOW + 2 * HOUR)] }));
    const [back] = await runPollers(env, "hourly", { pollers: [third], now: NOW + 2 * HOUR });
    expect(back?.retracted).toBeUndefined();
    expect(await metrics("app")).toContain("ci.status");
  });

  it("retracts nothing when the run fails or the poller has not opted in", async () => {
    const seed = fake(() => ({ entities: [repo("keep")], signals: [sig("keep", "ci.status", NOW)] }));
    await runPollers(env, "hourly", { pollers: [seed], now: NOW });

    const failing = fake(() => {
      throw new Error("upstream 502");
    });
    const silent = fake(() => ({ entities: [repo("keep")], signals: [] }), { retractUnobserved: undefined });
    const summaries = await runPollers(env, "hourly", { pollers: [failing, silent], now: NOW + HOUR });

    expect(summaries.map((s) => s.ok)).toEqual([false, true]);
    expect(await metrics("keep")).toEqual(["ci.status"]);
  });
});
