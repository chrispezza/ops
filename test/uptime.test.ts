import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestSignals, pollerHealth } from "../src/core/queries";
import { runPollers } from "../src/core/runner";
import { upsertEntities } from "../src/core/store";
import { MAX_TARGETS, uptime } from "../src/pollers/uptime";

const NOW = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

afterEach(() => vi.unstubAllGlobals());

async function seed() {
  await upsertEntities(
    env.DB,
    [
      { id: "repo:a/site", kind: "repo", category: "static_site", name: "site", metadata: { homepage: "https://site.example" } },
      { id: "repo:a/app", kind: "repo", category: "web_app", name: "app", metadata: { homepage: "https://app.example" } },
      { id: "repo:a/lib", kind: "repo", category: "tooling", name: "lib" }, // no homepage — never checked
      { id: "repo:a/dead", kind: "repo", category: "static_site", name: "dead", metadata: { homepage: "https://dead.example" } },
    ],
    NOW,
  );
  await env.DB.prepare("UPDATE entities SET archived = 1 WHERE id = 'repo:a/dead'").run();
}

describe("uptime poller", () => {
  it("checks homepages discovered by the github poller via ctx.listEntities", async () => {
    await seed();
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        fetched.push(url);
        if (url.includes("app.example")) return new Response("gone", { status: 503 });
        return new Response("ok");
      }),
    );

    await runPollers(env, "hourly", { pollers: [uptime], now: NOW });

    // archived and homepage-less repos are never fetched
    expect(fetched.sort()).toEqual(["https://app.example", "https://site.example"]);

    const site = await latestSignals(env.DB, "repo:a/site");
    expect(site.find((s) => s.metric === "site.up")?.value_num).toBe(1);
    expect(site.find((s) => s.metric === "site.up")?.severity).toBe(0);
    expect(site.find((s) => s.metric === "site.response_ms")).toBeDefined();

    const app = await latestSignals(env.DB, "repo:a/app");
    const down = app.find((s) => s.metric === "site.up");
    expect(down?.value_num).toBe(0);
    expect(down?.severity).toBe(3); // a down production site is a high-severity finding
    expect(app.find((s) => s.metric === "site.response_ms")).toBeUndefined();
  });

  it("treats network errors as down, not as poller failure", async () => {
    await seed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connection refused");
      }),
    );
    const summaries = await runPollers(env, "hourly", { pollers: [uptime], now: NOW });
    expect(summaries[0]?.ok).toBe(true); // one dead site must not poison the poller
    const site = await latestSignals(env.DB, "repo:a/site");
    expect(site.find((s) => s.metric === "site.up")?.severity).toBe(3);
  });
});

describe("uptime target cap", () => {
  it("never truncates silently: past MAX_TARGETS the run reports its coverage at a calm severity", async () => {
    const many = Array.from({ length: MAX_TARGETS + 3 }, (_, i) => ({
      id: `repo:a/site${String(i).padStart(2, "0")}`,
      kind: "repo",
      category: "static_site",
      name: `site${i}`,
      metadata: { homepage: `https://site${String(i).padStart(2, "0")}.example` },
    }));
    await upsertEntities(env.DB, many, NOW);
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input instanceof Request ? input.url : input));
        return new Response("ok");
      }),
    );

    const [summary] = await runPollers(env, "hourly", { pollers: [uptime], now: NOW });
    expect(fetched).toHaveLength(MAX_TARGETS);
    expect(summary?.ok).toBe(true);
    expect(summary?.notes?.[0]).toContain(`monitoring ${MAX_TARGETS} of ${MAX_TARGETS + 3} sites`);

    // calm sev 1 on /health (like "unconfigured"), never the red banner…
    const status = (await latestSignals(env.DB, "poller:uptime")).find((s) => s.metric === "poller.status");
    expect(status?.severity).toBe(1);
    const health = await pollerHealth(env.DB);
    const row = health.find((h) => h.entityId === "poller:uptime");
    // …and the run still counts as a success, so freshness doesn't age forever
    expect(row?.lastOk?.observed_at).toBe(NOW);
    expect(row?.failingSince).toBeNull();

    // the set is stable across runs: lowest ids, not whatever D1 returned first
    const ids = new Set(fetched);
    expect(ids.has("https://site00.example")).toBe(true);
    expect(ids.has(`https://site${String(MAX_TARGETS + 2).padStart(2, "0")}.example`)).toBe(false);
  });

  it("reports the outage onset from the runner-maintained last-ok pointer, not a history walk", async () => {
    await seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    await runPollers(env, "hourly", { pollers: [uptime], now: NOW - 7200 });
    // two failing runs after the success: onset is the FIRST of them
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const broken = { ...uptime, poll: async () => { throw new Error("upstream down"); } };
    await runPollers(env, "hourly", { pollers: [broken], now: NOW - 3600 });
    await runPollers(env, "hourly", { pollers: [broken], now: NOW });

    const lastOk = (await latestSignals(env.DB, "poller:uptime")).find((s) => s.metric === "poller.last_ok");
    expect(lastOk?.observed_at).toBe(NOW - 7200);
    const row = (await pollerHealth(env.DB)).find((h) => h.entityId === "poller:uptime");
    expect(row?.lastRun?.severity).toBe(3);
    expect(row?.lastOk?.observed_at).toBe(NOW - 7200);
    expect(row?.failingSince).toBe(NOW - 3600);

    // a poller that has never succeeded: onset is its first run
    await runPollers(env, "hourly", { pollers: [{ ...broken, id: "never" }], now: NOW - 60 });
    const never = (await pollerHealth(env.DB)).find((h) => h.entityId === "poller:never");
    expect(never?.lastOk).toBeNull();
    expect(never?.failingSince).toBe(NOW - 60);
  });

  it("under the cap there is no note and the status stays severity 0", async () => {
    await seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const [summary] = await runPollers(env, "hourly", { pollers: [uptime], now: NOW });
    expect(summary?.notes).toBeUndefined();
    const status = (await latestSignals(env.DB, "poller:uptime")).find((s) => s.metric === "poller.status");
    expect(status?.severity).toBe(0);
  });
});
