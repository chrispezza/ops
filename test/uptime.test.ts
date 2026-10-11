import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestSignals, POLLER_ONSET_SQL, pollerHealth } from "../src/core/queries";
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

    // #53: one index seek per poller on (metric, entity_id, observed_at), not a
    // pass over every poller.status row — this runs on every page view.
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${POLLER_ONSET_SQL}`).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join("\n")).toMatch(/idx_signals_metric \(metric=\? AND entity_id=\? AND observed_at>\?\)/);
  });

  it("under the cap there is no note and the status stays severity 0", async () => {
    await seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    // blanked so the assertion holds whatever wrangler.jsonc lists for this deployment
    const quiet = { ...env, UPTIME_ACCESS_HOSTS: "" } as unknown as Env;
    const [summary] = await runPollers(quiet, "hourly", { pollers: [uptime], now: NOW });
    expect(summary?.notes).toBeUndefined();
    const status = (await latestSignals(env.DB, "poller:uptime")).find((s) => s.metric === "poller.status");
    expect(status?.severity).toBe(0);
  });
});

describe("sites behind Cloudflare Access (#111)", () => {
  const LOGIN = "https://team.cloudflareaccess.com/cdn-cgi/access/login/gated.example?kid=abc";
  const target = (id: string, homepage: string) => ({
    id,
    kind: "repo",
    category: "web_app",
    name: id,
    metadata: { homepage },
    archived: false,
  });
  const ctx = (...entities: ReturnType<typeof target>[]) => ({ listEntities: async () => entities });
  const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
  const headerOf = (init: RequestInit | undefined, name: string) => new Headers(init?.headers).get(name);
  // placeholder pair, not a real service token
  const PAIR = { id: "id-fixture", value: "value-fixture" };
  const withToken = (hosts: string) =>
    ({ ...env, UPTIME_ACCESS_HOSTS: hosts, UPTIME_ACCESS_CLIENT_ID: PAIR.id, UPTIME_ACCESS_CLIENT_SECRET: PAIR.value }) as unknown as Env;
  const noToken = { ...env, UPTIME_ACCESS_HOSTS: "" } as unknown as Env;
  const up = (result: { signals: { entityId: string; metric: string }[] }, id: string) =>
    result.signals.find((s) => s.entityId === id && s.metric === "site.up") as
      | { valueNum?: number; valueText?: string; severity?: number }
      | undefined;

  it("does not call a login page 'up': a gated site is its own calm state with no number", async () => {
    // the login page itself answers 200, which is what used to pass as success
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => (String(input).includes("cloudflareaccess.com") ? new Response("sign in") : redirect(LOGIN))),
    );
    const result = await uptime.poll(noToken, ctx(target("repo:a/gated", "https://gated.example/")));

    expect(up(result, "repo:a/gated")).toMatchObject({ severity: 1, valueText: expect.stringContaining("behind Cloudflare Access") });
    expect(up(result, "repo:a/gated")?.valueNum).toBeUndefined();
    expect(result.signals.some((s) => s.metric === "site.response_ms")).toBe(false);
    // the login page is never fetched: the redirect is recognised, not followed
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1);
  });

  it("checks the real site when the host is listed and a service token is set", async () => {
    const seen: { url: string; id: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), id: headerOf(init, "cf-access-client-id") });
        return headerOf(init, "cf-access-client-secret") === PAIR.value ? new Response("app") : redirect(LOGIN);
      }),
    );
    const result = await uptime.poll(withToken("gated.example"), ctx(target("repo:a/gated", "https://gated.example/")));

    expect(up(result, "repo:a/gated")).toMatchObject({ valueNum: 1, valueText: "up", severity: 0 });
    expect(seen).toEqual([{ url: "https://gated.example/", id: PAIR.id }]);
  });

  it("sends the token to listed hosts only, never to another site or across a redirect", async () => {
    const seen: { url: string; id: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, id: headerOf(init, "cf-access-client-id") });
        if (url === "https://gated.example/") return redirect("https://elsewhere.example/landing");
        return new Response("ok");
      }),
    );
    await uptime.poll(
      withToken("gated.example"),
      ctx(target("repo:a/gated", "https://gated.example/"), target("repo:a/other", "https://other.example/"), target("repo:a/plain", "http://gated.example/")),
    );

    const sent = seen.filter((s) => s.id !== null).map((s) => s.url);
    expect(sent).toEqual(["https://gated.example/"]); // not the redirect target, not another site, not plain http
    expect(seen.map((s) => s.url)).toContain("https://elsewhere.example/landing");
  });

  it("reports a refused token as a broken monitor, not as up or down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => redirect(LOGIN)));
    const result = await uptime.poll(withToken("gated.example"), ctx(target("repo:a/gated", "https://gated.example/")));

    expect(up(result, "repo:a/gated")).toMatchObject({ severity: 2, valueText: expect.stringContaining("refused the service token") });
    expect(up(result, "repo:a/gated")?.valueNum).toBeUndefined();
  });

  it("still follows an ordinary redirect to the site, and gives up on a loop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://moved.example/") return redirect("/home");
        if (url === "https://moved.example/home") return new Response("ok");
        return redirect(url); // loop.example redirects to itself
      }),
    );
    const result = await uptime.poll(noToken, ctx(target("repo:a/moved", "https://moved.example/"), target("repo:a/loop", "https://loop.example/")));

    expect(up(result, "repo:a/moved")).toMatchObject({ valueNum: 1, severity: 0 });
    expect(up(result, "repo:a/loop")).toMatchObject({ valueNum: 0, severity: 3 });
  });

  it("says so when hosts are listed but the token is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const result = await uptime.poll({ ...env, UPTIME_ACCESS_HOSTS: "gated.example" } as unknown as Env, ctx(target("repo:a/x", "https://x.example/")));
    expect(result.notes?.[0]).toContain("UPTIME_ACCESS_HOSTS is set but the service token is not");
  });
});
