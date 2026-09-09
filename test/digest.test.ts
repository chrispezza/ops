import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { buildDigest, notifyDigest, parseSinceDays, renderDigestMarkdown } from "../src/core/digest";
import { insertSignals, upsertEntities } from "../src/core/store";
import type { SignalInsert } from "../src/pollers/types";

// Routes use the real clock, so the fixture is anchored to it.
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const DIGEST_TOKEN = "test-digest-token";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signal_latest"),
    env.DB.prepare("DELETE FROM signals"),
    env.DB.prepare("DELETE FROM entities"),
  ]);
});
afterEach(() => vi.unstubAllGlobals());

const sig = (
  entityId: string,
  metric: string,
  severity: 0 | 1 | 2 | 3 | 4,
  observedAt: number,
  dedupeKey: string,
  value: Partial<Pick<SignalInsert, "valueNum" | "valueText" | "url">> = {},
): SignalInsert => ({ entityId, metric, severity, observedAt, dedupeKey, ...value });

async function seed() {
  const repo = (slug: string) => ({
    id: `repo:clownware/${slug}`,
    kind: "repo",
    category: "web_app",
    name: slug,
    owner: "clownware",
    sourceUrl: `https://github.com/clownware/${slug}`,
  });
  await upsertEntities(env.DB, [repo("gittunes"), repo("deprep"), repo("dusty"), repo("newmetric"), repo("site")], NOW - 20 * DAY);
  await upsertEntities(env.DB, [{ id: "vendor_api:anthropic", kind: "vendor_api", category: "vendor_api", name: "anthropic" }], NOW - 20 * DAY);
  await upsertEntities(env.DB, [repo("fresh")], NOW - DAY);

  // An in-place hygiene row (fixed dedupe, observed_at bumped every pass) that
  // predates the window — inserted BEFORE the watermark run below.
  await insertSignals(env.DB, "core", [
    sig("repo:clownware/dusty", "hygiene.inactive", 2, NOW, "activity", { valueNum: 200, valueText: "no pushes for 200d" }),
  ]);
  await upsertEntities(env.DB, [{ id: "poller:github", kind: "poller", name: "github" }], NOW - 20 * DAY);
  await insertSignals(env.DB, "core", [
    sig("poller:github", "poller.status", 0, NOW - 8 * DAY, String(NOW - 8 * DAY), { valueText: '{"ok":true}' }),
  ]);

  await insertSignals(env.DB, "github", [
    // CI went red inside the window
    sig("repo:clownware/gittunes", "ci.status", 0, NOW - 10 * DAY, "sha-old", { valueText: "success" }),
    sig("repo:clownware/gittunes", "ci.status", 3, NOW - 2 * DAY, "sha-new", { valueText: "failure", url: "https://github.com/clownware/gittunes/actions" }),
    // a steady medium finding — present before and after, not news
    sig("repo:clownware/gittunes", "deps.vuln_count", 2, NOW - 10 * DAY, "h-old", { valueNum: 2 }),
    sig("repo:clownware/gittunes", "deps.vuln_count", 2, NOW - DAY, "h-new", { valueNum: 2 }),
    // vulns escalated medium → high
    sig("repo:clownware/deprep", "deps.vuln_count", 2, NOW - 10 * DAY, "h-old", { valueNum: 1 }),
    sig("repo:clownware/deprep", "deps.vuln_count", 3, NOW - DAY, "h-new", { valueNum: 3, valueText: "1 critical · 2 high" }),
    // a metric never seen before, straight in at medium
    sig("repo:clownware/newmetric", "prs.oldest_days", 2, NOW - DAY, "h1", { valueNum: 31 }),
    // down and back up within the window
    sig("repo:clownware/site", "site.up", 3, NOW - 3 * DAY, "h1", { valueNum: 0, valueText: "down" }),
    sig("repo:clownware/site", "site.up", 0, NOW - DAY, "h2", { valueNum: 1, valueText: "up" }),
    // backlog now
    sig("repo:clownware/gittunes", "issues.open", 0, NOW, "hb", { valueNum: 5 }),
    sig("repo:clownware/deprep", "issues.open", 0, NOW, "hb", { valueNum: 7 }),
    sig("repo:clownware/gittunes", "issues.idle_90d", 1, NOW, "hb", { valueNum: 2, valueText: "#3 · #7" }),
  ]);
  // spend: $2/day in the window, $1/day in the one before
  const spend = (daysAgo: number, usd: number): SignalInsert => {
    const start = NOW - (NOW % DAY) - daysAgo * DAY;
    return {
      entityId: "vendor_api:anthropic",
      metric: "spend.usd",
      valueNum: usd,
      observedAt: start + DAY,
      period: { start, end: start + DAY },
      dedupeKey: String(start),
    };
  };
  await insertSignals(env.DB, "anthropic_usage", [spend(1, 2), spend(2, 2), spend(3, 2), spend(8, 1), spend(9, 1), spend(10, 1)]);
}

describe("buildDigest", () => {
  it("reads raised, resolved, new entities, backlog and spend from history alone", async () => {
    await seed();
    const d = await buildDigest(env.DB, 7, NOW);

    expect(d.raised.map((r) => [r.entity_name, r.metric, r.from, r.severity])).toEqual([
      ["deprep", "deps.vuln_count", 2, 3],
      ["gittunes", "ci.status", 0, 3],
      ["newmetric", "prs.oldest_days", null, 2],
    ]);
    // the steady finding and the pre-existing in-place hygiene row are not news
    expect(d.raised.some((r) => r.entity_name === "dusty")).toBe(false);

    expect(d.resolved.map((r) => [r.entity_name, r.metric, r.peak, r.severity])).toEqual([["site", "site.up", 3, 0]]);
    expect(d.newEntities.map((e) => e.name)).toEqual(["fresh"]);
    expect(d.spend).toEqual({ current: 6, prior: 3 });
    expect(d.backlog).toEqual([
      { metric: "issues.open", total: 12, entities: 2 },
      { metric: "issues.idle_90d", total: 2, entities: 1 },
      { metric: "deps.vuln_count", total: 5, entities: 2 },
    ]);
  });

  it("treats every finding as new on a fresh database (no watermark yet)", async () => {
    await upsertEntities(env.DB, [{ id: "repo:a/b", kind: "repo", name: "b" }], NOW);
    await insertSignals(env.DB, "github", [sig("repo:a/b", "ci.status", 3, NOW, "sha", { valueText: "failure" })]);
    const d = await buildDigest(env.DB, 7, NOW);
    expect(d.raised).toHaveLength(1);
    expect(d.raised[0]?.from).toBeNull();
  });
});

describe("parseSinceDays", () => {
  it("accepts Nd or N, clamps to the retention horizon, defaults otherwise", () => {
    expect(parseSinceDays("7d")).toBe(7);
    expect(parseSinceDays("14")).toBe(14);
    expect(parseSinceDays("0d")).toBe(1);
    expect(parseSinceDays("999d")).toBe(30);
    expect(parseSinceDays("soon")).toBe(7);
    expect(parseSinceDays(undefined)).toBe(7);
  });
});

describe("renderDigestMarkdown", () => {
  it("carries a headline, every change with its deep link and signal name, and the now strip", async () => {
    await seed();
    const md = renderDigestMarkdown(await buildDigest(env.DB, 7, NOW), "https://ops.example/");
    expect(md).toContain("# Ops digest — 7d ending");
    expect(md).toContain("**3 raised · 1 resolved · 1 new entity · spend $6.00 (prior $3.00)**");
    expect(md).toContain(
      "- **gittunes** — CI status: failure — high, was ok — https://github.com/clownware/gittunes/actions (ops signal: ci.status, entity: https://ops.example/e/repo:clownware/gittunes)",
    );
    expect(md).toContain("- **newmetric** — oldest human PR: 31 — medium, new —");
    expect(md).toContain("- **site** — site status: now up (peaked high) — https://ops.example/e/repo:clownware/site");
    expect(md).toContain("- fresh (repo, web_app) — https://ops.example/e/repo:clownware/fresh");
    expect(md).toContain("| open issues (issues.open) | 12 | 2 |");
  });
});

describe("/digest page", () => {
  it("renders the window, the changes and the machine-readable hint", async () => {
    await seed();
    const res = await SELF.fetch("https://ops.local/digest?since=7d");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/digest?since=7d" class="active"');
    expect(html).toContain(">deprep<");
    expect(html).toContain("medium → high");
    expect(html).toContain("peaked high");
    expect(html).toContain(">fresh<");
    expect(html).toContain("Token configured.");
    expect(html).toContain('href="/digest" class="active"'); // nav entry
  });

  it("clamps an oversized window to the retention horizon", async () => {
    const html = await (await SELF.fetch("https://ops.local/digest?since=400d")).text();
    expect(html).toContain('href="/digest?since=30d" class="active"');
  });
});

describe("GET /digest/md", () => {
  it("requires the bearer token and returns markdown", async () => {
    await seed();
    expect((await SELF.fetch("https://ops.local/digest/md")).status).toBe(401);
    expect((await SELF.fetch("https://ops.local/digest/md", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const ok = await SELF.fetch("https://ops.local/digest/md?since=7d", { headers: { authorization: `Bearer ${DIGEST_TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/markdown");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.text()).toContain("# Ops digest — 7d ending");
  });

  it("is disabled without DIGEST_TOKEN", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://ops.local/digest/md", { headers: { authorization: `Bearer ${DIGEST_TOKEN}` } }),
      { ...env, DIGEST_TOKEN: undefined } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
  });
});

describe("weekly digest push", () => {
  it("posts the headline and top movers to ntfy with a click-through to /digest", async () => {
    await seed();
    const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        posts.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
        return new Response("ok");
      }),
    );
    const testEnv = { ...env, NTFY_URL: "https://ntfy.example/ops", OPS_URL: "https://ops.example" } as unknown as Env;
    await notifyDigest(env.DB, testEnv, NOW);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers.title).toMatch(/^Ops weekly digest — \d{4}-\d{2}-\d{2}$/);
    expect(posts[0]?.headers.priority).toBe("default");
    expect(posts[0]?.headers.click).toBe("https://ops.example/digest?since=7d");
    expect(posts[0]?.body).toContain("3 raised · 1 resolved · 1 new entity");
    expect(posts[0]?.body).toContain("▲ deprep: Dependabot vulns 1 critical · 2 high");
    expect(posts[0]?.body).toContain("✓ site: site status up");
  });

  it("is dormant without NTFY_URL", async () => {
    const fetchSpy = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchSpy);
    await notifyDigest(env.DB, { ...env, NTFY_URL: undefined } as unknown as Env, NOW);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs from the Friday cron without polling anything", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL) => {
        urls.push(String(url));
        return new Response("ok");
      }),
    );
    const ctx = createExecutionContext();
    await worker.scheduled(
      { cron: "0 12 * * 5", scheduledTime: NOW * 1000, noRetry() {} } as ScheduledController,
      { ...env, NTFY_URL: "https://ntfy.example/ops" } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(urls).toEqual(["https://ntfy.example/ops"]);
  });
});
