import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { latestSignals } from "../src/core/queries";
import { runPollers } from "../src/core/runner";
import { upsertEntities } from "../src/core/store";
import { uptime } from "../src/pollers/uptime";

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
