import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { insertSignals, upsertEntities } from "../src/core/store";
import { runPollers } from "../src/core/runner";
import type { Poller } from "../src/pollers/types";

const NOW = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

async function seedRepo() {
  await upsertEntities(
    env.DB,
    [
      {
        id: "repo:clownware/gittunes",
        kind: "repo",
        category: "web_app",
        name: "gittunes",
        owner: "clownware",
        sourceUrl: "https://github.com/clownware/gittunes",
      },
      { id: "repo:clownware/mystery", kind: "repo", name: "mystery", owner: "clownware" },
    ],
    NOW,
  );
  await insertSignals(env.DB, "github", [
    {
      entityId: "repo:clownware/gittunes",
      metric: "ci.status",
      valueText: "failure",
      severity: 3,
      url: "https://github.com/clownware/gittunes/actions",
      observedAt: NOW,
      dedupeKey: "abc",
    },
    {
      entityId: "repo:clownware/gittunes",
      metric: "deps.vuln_count",
      valueNum: 2,
      severity: 2,
      observedAt: NOW,
      dedupeKey: "b1",
    },
  ]);
}

describe("map page", () => {
  it("shows the setup checklist on an empty database", async () => {
    const res = await SELF.fetch("https://ops.local/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No data yet");
    expect(html).toContain("GITHUB_PAT");
  });

  it("groups entities by category with uncategorized as a warning section", async () => {
    await seedRepo();
    const html = await (await SELF.fetch("https://ops.local/")).text();

    expect(html).toContain("gittunes");
    expect(html).toContain("Web Apps");
    expect(html).toContain("Uncategorized");
    expect(html).toContain("tag these repos");
    // failing CI chip carries its severity + deep link; missing expected chips render as —
    expect(html).toContain('data-sev="3"');
    expect(html).toContain("https://github.com/clownware/gittunes/actions");
    // stable IA: empty sections still render with hints
    expect(html).toContain("Static Sites");
  });
});

describe("triage page", () => {
  it("sorts by score and explains why", async () => {
    await seedRepo();
    const html = await (await SELF.fetch("https://ops.local/triage")).text();
    // gittunes: sev3 CI (30) + 2 problems (4) = 34
    expect(html).toContain("34");
    expect(html).toContain("high ci.status");
    // filter that excludes everything
    const filtered = await (await SELF.fetch("https://ops.local/triage?min_severity=4")).text();
    expect(filtered).toContain("Nothing matches");
  });
});

describe("entity page", () => {
  it("renders detail, history, and archive toggle round trip", async () => {
    await seedRepo();
    const res = await SELF.fetch("https://ops.local/e/repo:clownware/gittunes");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("gittunes");
    expect(html).toContain("ci.status");
    expect(html).toContain("History");

    // archive → hidden from map, still resolvable on the entity page
    const form = new FormData();
    form.set("entity_id", "repo:clownware/gittunes");
    form.set("archived", "1");
    await SELF.fetch("https://ops.local/archive", { method: "POST", body: form, redirect: "manual" });
    const map = await (await SELF.fetch("https://ops.local/")).text();
    expect(map).not.toContain(">gittunes<");
    const detail = await (await SELF.fetch("https://ops.local/e/repo:clownware/gittunes")).text();
    expect(detail).toContain("archived");
  });

  it("404s for unknown entities", async () => {
    const res = await SELF.fetch("https://ops.local/e/repo:nope/nope");
    expect(res.status).toBe(404);
  });
});

describe("health + degradation", () => {
  it("lists poller failures and shows the amber banner on other pages", async () => {
    const bad: Poller = {
      id: "github",
      schedule: "hourly",
      metricSemantics: {},
      poll: async () => {
        throw new Error("upstream 500");
      },
    };
    await runPollers(env, "hourly", { pollers: [bad], now: NOW });

    const health = await (await SELF.fetch("https://ops.local/health")).text();
    expect(health).toContain("upstream 500");
    expect(health).toContain("never"); // no successful run yet

    const map = await (await SELF.fetch("https://ops.local/")).text();
    expect(map).toContain("banner amber");
    expect(map).toContain("/health");
  });
});
