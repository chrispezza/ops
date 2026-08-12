import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_METRICS } from "../src/config";
import { emitHygieneSignals } from "../src/core/derive";
import { notifyNewAlerts } from "../src/core/notify";
import { latestSignals } from "../src/core/queries";
import { activityAt, computeScore } from "../src/core/score";
import { insertSignals, upsertEntities } from "../src/core/store";
import { claudeCode } from "../src/pollers/claude-code";
import type { EntityView } from "../src/core/queries";

const DAY = 86_400;
const NOW = 1_754_400_000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signals"),
    env.DB.prepare("DELETE FROM entities"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

describe("activity-based staleness", () => {
  it("scores staleness from push activity even when the poller sees the repo hourly", () => {
    const view: EntityView = {
      id: "repo:x",
      kind: "repo",
      category: "web_app",
      name: "x",
      owner: null,
      source_url: null,
      last_seen_at: NOW, // polled this hour — the old basis would score 0
      latest: {
        "repo.pushed_at": {
          id: 1, entity_id: "repo:x", source: "github", metric: "repo.pushed_at",
          value_num: NOW - 100 * DAY, value_text: null, severity: 0, url: null,
          observed_at: NOW - 100 * DAY, period_start: null, period_end: null, dedupe_key: "p",
        },
      },
      maxSeverity: 0,
    };
    expect(activityAt(view)).toBe(NOW - 100 * DAY);
    const score = computeScore(view, NOW, null);
    expect(score.parts.find((p) => p.label === "stale 100d")?.points).toBe(6);
  });
});

describe("hygiene.inactive triage path", () => {
  it("flags 90d/180d inactivity from push signals and resolves on activity", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "repo:a/old", kind: "repo", category: "tooling", name: "old" },
        { id: "repo:a/ancient", kind: "repo", category: "tooling", name: "ancient" },
        { id: "repo:a/fresh", kind: "repo", category: "tooling", name: "fresh" },
      ],
      NOW,
    );
    const push = (id: string, daysAgo: number) => ({
      entityId: id,
      metric: "repo.pushed_at",
      valueNum: NOW - daysAgo * DAY,
      observedAt: NOW - daysAgo * DAY,
      dedupeKey: String(NOW - daysAgo * DAY),
    });
    await insertSignals(env.DB, "github", [push("repo:a/old", 100), push("repo:a/ancient", 200), push("repo:a/fresh", 5)]);

    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW);
    const sev = async (id: string) =>
      (await latestSignals(env.DB, id)).find((s) => s.metric === "hygiene.inactive")?.severity;
    expect(await sev("repo:a/old")).toBe(1);
    expect(await sev("repo:a/ancient")).toBe(2);
    expect(await sev("repo:a/fresh")).toBe(0);

    // new push resolves the flag in place
    await insertSignals(env.DB, "github", [push("repo:a/ancient", 0)]);
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW + 60);
    expect(await sev("repo:a/ancient")).toBe(0);
  });
});

describe("ntfy notifications", () => {
  const seedAlert = async (severity: 0 | 3 | 4 = 3) => {
    await upsertEntities(env.DB, [{ id: "repo:a/site", kind: "repo", category: "static_site", name: "site" }], NOW);
    await insertSignals(env.DB, "uptime", [
      { entityId: "repo:a/site", metric: "site.up", valueNum: severity ? 0 : 1, valueText: severity ? "down" : "up", severity, observedAt: NOW, dedupeKey: "h1" },
    ]);
  };

  it("notifies once per alert, again only on escalation or recurrence", async () => {
    const posts: { body: string; priority: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        posts.push({
          body: String(init?.body),
          priority: String((init?.headers as Record<string, string>)?.priority),
        });
        return new Response("ok");
      }),
    );
    const testEnv = { ...env, NTFY_URL: "https://ntfy.example/ops" } as Env;

    await seedAlert(3);
    await notifyNewAlerts(env.DB, testEnv, NOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toContain("site: site status down (sev 3)");
    expect(posts[0]?.priority).toBe("high");

    // same alert next cycle — silence
    await notifyNewAlerts(env.DB, testEnv, NOW + 3600);
    expect(posts).toHaveLength(1);

    // resolved, then recurs — notify again
    await seedAlert(0);
    await notifyNewAlerts(env.DB, testEnv, NOW + 7200);
    await seedAlert(4);
    await notifyNewAlerts(env.DB, testEnv, NOW + 10_800);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.priority).toBe("urgent");
  });

  it("deep-links a single alert to its entity, several to triage", async () => {
    const clicks: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        clicks.push((init?.headers as Record<string, string>)?.click);
        return new Response("ok");
      }),
    );
    const testEnv = { ...env, NTFY_URL: "https://ntfy.example/ops", OPS_URL: "https://ops.example" } as unknown as Env;

    await seedAlert(3);
    await notifyNewAlerts(env.DB, testEnv, NOW);
    expect(clicks[0]).toBe("https://ops.example/e/repo:a/site");

    // second entity joins → batched alert points at triage
    await upsertEntities(env.DB, [{ id: "repo:a/app", kind: "repo", category: "web_app", name: "app" }], NOW);
    await insertSignals(env.DB, "github", [
      { entityId: "repo:a/app", metric: "ci.status", valueText: "failure", severity: 3, observedAt: NOW, dedupeKey: "c" },
    ]);
    await env.DB.prepare("DELETE FROM settings").run(); // reset notified state → both fresh
    await notifyNewAlerts(env.DB, testEnv, NOW + 60);
    expect(clicks[1]).toBe("https://ops.example/triage");
  });

  it("does nothing without NTFY_URL configured", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await seedAlert(3);
    await notifyNewAlerts(env.DB, { ...env, NTFY_URL: undefined } as unknown as Env, NOW);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("claude_code poller", () => {
  it("aggregates per-user records into daily org signals, cents to USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input instanceof Request ? input.url : input));
        const date = url.searchParams.get("starting_at");
        const today = new Date().toISOString().slice(0, 10);
        if (date !== today) return Response.json({ data: [], has_more: false, next_page: null });
        return Response.json({
          data: [
            {
              core_metrics: { num_sessions: 5, lines_of_code: { added: 1543, removed: 892 }, commits_by_claude_code: 12 },
              model_breakdown: [
                { estimated_cost: { amount: 141, currency: "USD" } },
                { estimated_cost: { amount: 60, currency: "USD" } },
              ],
            },
            {
              core_metrics: { num_sessions: 2, lines_of_code: { added: 100, removed: 5 }, commits_by_claude_code: 1 },
              model_breakdown: [{ estimated_cost: { amount: 99, currency: "USD" } }],
            },
          ],
          has_more: false,
          next_page: null,
        });
      }),
    );

    const result = await claudeCode.poll({ ...env, ANTHROPIC_ADMIN_KEY: "sk-ant-admin-test" } as Env, {
      listEntities: async () => [],
    });

    expect(result.entities[0]?.id).toBe("vendor_api:claude_code");
    const spend = result.signals.find((s) => s.metric === "spend.usd");
    expect(spend?.valueNum).toBeCloseTo(3.0); // (141+60+99) cents
    expect(result.signals.find((s) => s.metric === "usage.sessions")?.valueNum).toBe(7);
    expect(result.signals.find((s) => s.metric === "usage.commits")?.valueNum).toBe(13);
    // empty days emit nothing rather than zero rows
    expect(result.signals).toHaveLength(4);
  });
});
