import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EXPECTED_METRICS } from "../src/config";
import { emitHygieneSignals } from "../src/core/derive";
import { intervalSums, latestSignals } from "../src/core/queries";
import { runPollers } from "../src/core/runner";
import { insertSignals, upsertEntities } from "../src/core/store";
import type { Poller, PollerResult } from "../src/pollers/types";

const NOW = 1_754_400_000;

function fakePoller(id: string, result: PollerResult | (() => PollerResult)): Poller {
  return {
    id,
    schedule: "hourly",
    metricSemantics: {},
    poll: async () => (typeof result === "function" ? result() : result),
  };
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// Storage is shared within a test file; each test starts from a clean slate.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

const repoResult: PollerResult = {
  entities: [
    {
      id: "repo:clownware/gittunes",
      kind: "repo",
      category: "web_app",
      name: "gittunes",
      owner: "clownware",
      sourceUrl: "https://github.com/clownware/gittunes",
    },
  ],
  signals: [
    {
      entityId: "repo:clownware/gittunes",
      metric: "ci.status",
      valueText: "passing",
      severity: 0,
      observedAt: NOW,
      dedupeKey: "run-123",
    },
    {
      entityId: "repo:clownware/gittunes",
      metric: "deps.vuln_count",
      valueNum: 2,
      severity: 2,
      observedAt: NOW,
      dedupeKey: String(NOW),
    },
  ],
};

describe("store + runner round trip", () => {
  it("persists a poller result and derives latest state by query", async () => {
    await runPollers(env, "hourly", { pollers: [fakePoller("fake", repoResult)], now: NOW });

    const latest = await latestSignals(env.DB, "repo:clownware/gittunes");
    expect(latest.map((s) => s.metric).sort()).toEqual(["ci.status", "deps.vuln_count"]);
    expect(latest.find((s) => s.metric === "ci.status")?.value_text).toBe("passing");

    // poller self-monitoring: synthetic entity + ok status signal
    const status = await latestSignals(env.DB, "poller:fake");
    expect(status.find((s) => s.metric === "poller.status")?.severity).toBe(0);
  });

  it("is idempotent: re-running the same result adds zero rows", async () => {
    const poller = fakePoller("fake", repoResult);
    await runPollers(env, "hourly", { pollers: [poller], now: NOW });
    const entitiesBefore = await count("entities");
    const signalsBefore = await count("signals");

    // same observations, later run — only the poller.status row for the new run is added
    await runPollers(env, "hourly", { pollers: [poller], now: NOW + 3600 });
    expect(await count("entities")).toBe(entitiesBefore);
    expect(await count("signals")).toBe(signalsBefore + 1);

    // newest ci.status is still a single row per dedupe key
    const latest = await latestSignals(env.DB, "repo:clownware/gittunes");
    expect(latest).toHaveLength(2);
  });

  it("bumps last_seen_at and preserves first_seen_at on re-observation", async () => {
    const poller = fakePoller("fake", repoResult);
    await runPollers(env, "hourly", { pollers: [poller], now: NOW });
    await runPollers(env, "hourly", { pollers: [poller], now: NOW + 3600 });

    const row = await env.DB.prepare("SELECT first_seen_at, last_seen_at FROM entities WHERE id = ?1")
      .bind("repo:clownware/gittunes")
      .first<{ first_seen_at: number; last_seen_at: number }>();
    expect(row?.first_seen_at).toBe(NOW);
    expect(row?.last_seen_at).toBe(NOW + 3600);
  });

  it("overwrites interval metrics on the same period (settling data)", async () => {
    const day = { start: NOW - 86_400, end: NOW };
    const spend = (usd: number): PollerResult => ({
      entities: [{ id: "api_key:clownbot", kind: "api_key", name: "clownbot" }],
      signals: [
        {
          entityId: "api_key:clownbot",
          metric: "spend.usd",
          valueNum: usd,
          observedAt: NOW,
          period: day,
          dedupeKey: String(day.start),
        },
      ],
    });

    await runPollers(env, "hourly", { pollers: [fakePoller("spend", spend(1.5))], now: NOW });
    await runPollers(env, "hourly", { pollers: [fakePoller("spend", spend(2.25))], now: NOW + 7200 });

    const sums = await intervalSums(env.DB, "api_key:clownbot", "spend.usd", day.start);
    expect(sums).toEqual([{ period_start: day.start, total: 2.25 }]);
  });

  it("isolates poller failures and records them as severity-3 self-signals", async () => {
    const bad = fakePoller("bad", () => {
      throw new Error("upstream 500");
    });
    const summaries = await runPollers(env, "hourly", {
      pollers: [bad, fakePoller("good", repoResult)],
      now: NOW,
    });

    expect(summaries.map((s) => s.ok)).toEqual([false, true]);
    const good = await latestSignals(env.DB, "repo:clownware/gittunes");
    expect(good).toHaveLength(2);

    const badStatus = (await latestSignals(env.DB, "poller:bad")).find((s) => s.metric === "poller.status");
    expect(badStatus?.severity).toBe(3);
    expect(badStatus?.value_text).toContain("upstream 500");
  });

  it("rejects signals with an empty dedupe key", async () => {
    await upsertEntities(env.DB, [{ id: "repo:x", kind: "repo", name: "x" }], NOW);
    await expect(
      insertSignals(env.DB, "test", [
        { entityId: "repo:x", metric: "ci.status", observedAt: NOW, dedupeKey: "" },
      ]),
    ).rejects.toThrow(/dedupeKey/);
  });
});

describe("hygiene pass", () => {
  it("flags missing expected metrics and resolves them in place", async () => {
    await upsertEntities(
      env.DB,
      [{ id: "repo:site", kind: "repo", category: "static_site", name: "site" }],
      NOW,
    );

    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW);
    let hygiene = (await latestSignals(env.DB, "repo:site")).filter(
      (s) => s.metric === "hygiene.missing_metric",
    );
    expect(hygiene).toHaveLength(1);
    expect(hygiene[0]?.value_text).toBe("lhci.performance");
    expect(hygiene[0]?.severity).toBe(1);

    // metric shows up → same row resolves to severity 0, no new rows
    await insertSignals(env.DB, "ci_ingest", [
      { entityId: "repo:site", metric: "lhci.performance", valueNum: 98, observedAt: NOW + 60, dedupeKey: "run-1" },
    ]);
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW + 120);
    hygiene = (await latestSignals(env.DB, "repo:site")).filter(
      (s) => s.metric === "hygiene.missing_metric",
    );
    expect(hygiene).toHaveLength(1);
    expect(hygiene[0]?.severity).toBe(0);
  });

  it("ignores archived and uncategorized entities", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "repo:untagged", kind: "repo", name: "untagged" },
        { id: "repo:old", kind: "repo", category: "web_app", name: "old" },
      ],
      NOW,
    );
    await env.DB.prepare("UPDATE entities SET archived = 1 WHERE id = 'repo:old'").run();

    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW);
    expect(await count("signals")).toBe(0);
  });
});
