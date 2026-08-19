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
    expect(html).toContain("high CI status");
    // filter that excludes everything
    const filtered = await (await SELF.fetch("https://ops.local/triage?min_severity=4")).text();
    expect(filtered).toContain("Nothing matches");
  });

  it("marks the active sort's direction for eyes and AT alike", async () => {
    await seedRepo();
    const byScore = await (await SELF.fetch("https://ops.local/triage")).text();
    expect(byScore).toMatch(/<th[^>]*aria-sort="descending"[^>]*>\s*<a[^>]*>score/);
    expect(byScore).toContain("↓");
    expect(byScore.match(/aria-sort=/g)).toHaveLength(1); // only the active column claims a direction
    const byName = await (await SELF.fetch("https://ops.local/triage?sort=name")).text();
    expect(byName).toMatch(/<th[^>]*aria-sort="ascending"[^>]*>\s*<a[^>]*>entity/);
    expect(byName).toContain("↑");
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
    // one fixed-geometry table for all domains: labeled columns + group rows
    expect(html).toContain(">30d trend<");
    expect(html).toContain(">observed<");
    expect(html).toContain('class="domain"');

    // archive → out of the working sections, into the collapsed Archived section
    const form = new FormData();
    form.set("entity_id", "repo:clownware/gittunes");
    form.set("archived", "1");
    await SELF.fetch("https://ops.local/archive", {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: { origin: "https://ops.local" },
    });
    const map = await (await SELF.fetch("https://ops.local/")).text();
    expect(map).toContain("archived-section");
    expect(map.split("archived-section")[0]).not.toContain(">gittunes<"); // absent before the archived block
    const triage = await (await SELF.fetch("https://ops.local/triage")).text();
    expect(triage).not.toContain(">gittunes<");
    const detail = await (await SELF.fetch("https://ops.local/e/repo:clownware/gittunes")).text();
    expect(detail).toContain("archived");
  });

  it("404s for unknown entities", async () => {
    const res = await SELF.fetch("https://ops.local/e/repo:nope/nope");
    expect(res.status).toBe(404);
  });
});

describe("interval chips + entity scoping", () => {
  it("renders the usage chip as a 30d sum, never the latest daily row", async () => {
    await upsertEntities(
      env.DB,
      [{ id: "repo:chrispezza/shelf", kind: "repo", category: "plugin_skill", name: "shelf" }],
      NOW,
    );
    const day = NOW - (NOW % 86_400);
    await insertSignals(
      env.DB,
      "skill_usage",
      [5, 7, 6].map((n, i) => ({
        entityId: "repo:chrispezza/shelf",
        metric: "usage.invocations",
        valueNum: n,
        observedAt: day - i * 86_400 + 86_400,
        period: { start: day - i * 86_400, end: day - i * 86_400 + 86_400 },
        dedupeKey: String(day - i * 86_400),
      })),
    );
    const html = await (await SELF.fetch("https://ops.local/")).text();
    expect(html).toContain("usage 30d 18"); // 5+7+6 summed
    expect(html).not.toContain("usage 30d 5");
  });

  it("keeps budget bookkeeping entities and vendor chips out of repo sections", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "vendor_api:anthropic", kind: "vendor_api", category: "vendor_api", name: "Anthropic", sourceUrl: "https://console.anthropic.com/settings/usage" },
        { id: "budget:*", kind: "budget", name: "budget *" },
      ],
      NOW,
    );
    const html = await (await SELF.fetch("https://ops.local/")).text();
    expect(html).toContain("Vendor APIs"); // vendors get their own section
    expect(html).not.toContain("budget *"); // internal entity never renders
    // no repo-shaped affordance on a vendor console
    expect(html).not.toContain("https://console.anthropic.com/settings/usage/issues/new");
  });
});

describe("owner filter", () => {
  it("scopes map and triage to one owner via URL param", async () => {
    await seedRepo(); // gittunes + mystery, both owner clownware
    await upsertEntities(
      env.DB,
      [{ id: "repo:chrispezza/deprep", kind: "repo", category: "web_app", name: "deprep", owner: "chrispezza" }],
      NOW,
    );

    const all = await (await SELF.fetch("https://ops.local/")).text();
    expect(all).toContain("gittunes");
    expect(all).toContain("deprep");

    const scoped = await (await SELF.fetch("https://ops.local/?owner=chrispezza")).text();
    expect(scoped).toContain("deprep");
    expect(scoped).not.toContain(">gittunes<");

    const triage = await (await SELF.fetch("https://ops.local/triage?owner=clownware")).text();
    expect(triage).toContain("gittunes");
    expect(triage).not.toContain(">deprep<");
  });
});

describe("archived entities in findings", () => {
  it("stay visible on /findings with an archived badge", async () => {
    await seedRepo();
    await env.DB.prepare("UPDATE entities SET archived = 1 WHERE id = 'repo:clownware/gittunes'").run();
    const html = await (await SELF.fetch("https://ops.local/findings")).text();
    expect(html).toContain("ci.status");
    expect(html).toContain("(archived)");
    // separated into the archived drawer, not interleaved with live findings
    expect(html).toContain("Archived findings");
    expect(html.split("Archived findings")[0]).not.toContain(">gittunes<");
    // out of the working sections; present only in the archived block
    const map = await (await SELF.fetch("https://ops.local/")).text();
    expect(map.split("archived-section")[0]).not.toContain(">gittunes<");
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

  it("collapses more than two failing sources into one summary banner", async () => {
    const dead = (id: string): Poller => ({
      id,
      schedule: "hourly",
      metricSemantics: {},
      poll: async () => {
        throw new Error(`${id} down`);
      },
    });
    await runPollers(env, "hourly", { pollers: [dead("github"), dead("uptime"), dead("cloudflare")], now: NOW });
    const map = await (await SELF.fetch("https://ops.local/")).text();
    expect(map.match(/banner amber/g)).toHaveLength(1);
    expect(map).toContain("3 data sources are failing (Cloudflare, GitHub, Uptime)");
    // two failing sources still get their own, more specific banners
    await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
    await runPollers(env, "hourly", { pollers: [dead("github"), dead("uptime")], now: NOW });
    const two = await (await SELF.fetch("https://ops.local/")).text();
    expect(two.match(/banner amber/g)).toHaveLength(2);
  });
});

describe("table semantics survive the mobile collapse", () => {
  it("carries explicit table roles so display changes cannot strip them", async () => {
    await seedRepo();
    const noop: Poller = { id: "github", schedule: "hourly", metricSemantics: {}, poll: async () => ({ entities: [], signals: [] }) };
    await runPollers(env, "hourly", { pollers: [noop], now: NOW }); // /health only renders a table once a poller has run
    for (const path of ["/", "/triage", "/findings", "/health", "/e/repo:clownware/gittunes"]) {
      const html = await (await SELF.fetch(`https://ops.local${path}`)).text();
      expect(html, path).toContain('<table role="table"');
      expect(html, path).toContain('<tr role="row"');
      expect(html, path).toContain('<td role="cell"');
    }
    const triage = await (await SELF.fetch("https://ops.local/triage")).text();
    expect(triage).toContain('<th role="columnheader"');
  });

  it("titles a truncatable metric cell with its display label, not the raw id", async () => {
    await seedRepo();
    const findings = await (await SELF.fetch("https://ops.local/findings")).text();
    expect(findings).toContain('title="CI status · ci.status"');
    const entity = await (await SELF.fetch("https://ops.local/e/repo:clownware/gittunes")).text();
    expect(entity).toContain('title="CI status · ci.status"');
  });
});

describe("same-origin gate", () => {
  const form = () => {
    const f = new FormData();
    f.set("entity_id", "repo:clownware/gittunes");
    f.set("archived", "1");
    return f;
  };

  it("refuses a state-mutating POST with no Origin (curl against an Access-less deployment)", async () => {
    const res = await SELF.fetch("https://ops.local/archive", { method: "POST", body: form(), redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("refuses a cross-origin POST (CSRF from another site)", async () => {
    const res = await SELF.fetch("https://ops.local/archive", {
      method: "POST",
      body: form(),
      redirect: "manual",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated /health/run, the poller fan-out trigger", async () => {
    const res = await SELF.fetch("https://ops.local/health/run", { method: "POST", redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("allows same-origin POSTs and leaves GETs untouched", async () => {
    await seedRepo();
    const res = await SELF.fetch("https://ops.local/archive", {
      method: "POST",
      body: form(),
      redirect: "manual",
      headers: { origin: "https://ops.local" },
    });
    expect(res.status).toBe(302);
    expect((await SELF.fetch("https://ops.local/")).status).toBe(200);
  });

  it("exempts /ingest, which carries its own bearer token", async () => {
    const res = await SELF.fetch("https://ops.local/ingest", {
      method: "POST",
      headers: { authorization: "Bearer test-ingest-token", "content-type": "application/json" },
      body: JSON.stringify({
        entities: [{ id: "repo:ci/pushed", kind: "repo", name: "pushed" }],
        signals: [
          { entityId: "repo:ci/pushed", metric: "ci.status", valueText: "success", observedAt: NOW, dedupeKey: "run-1" },
        ],
      }),
    });
    expect(res.status).toBe(202);
  });
});

describe("hostile URLs from ingest never become live links", () => {
  it("strips javascript: hrefs from signal and entity URLs", async () => {
    await upsertEntities(
      env.DB,
      [
        {
          id: "repo:evil/x",
          kind: "repo",
          category: "web_app",
          name: "evilrepo",
          owner: "evil",
          sourceUrl: "javascript:alert(1)",
          metadata: { homepage: "javascript:alert(2)" },
        },
      ],
      NOW,
    );
    await insertSignals(env.DB, "ci_ingest", [
      {
        entityId: "repo:evil/x",
        metric: "ci.status",
        valueText: "failure",
        severity: 3,
        url: "javascript:alert(3)",
        observedAt: NOW,
        dedupeKey: "x",
      },
    ]);

    for (const path of ["/", "/triage", "/findings", "/e/repo:evil/x"]) {
      const html = await (await SELF.fetch(`https://ops.local${path}`)).text();
      expect(html, `${path} must not linkify javascript:`).not.toContain('href="javascript:');
    }
    // the entity page still shows the URL as text — only the href is withheld
    const detail = await (await SELF.fetch("https://ops.local/e/repo:evil/x")).text();
    expect(detail).toContain("javascript:alert(1)");
  });
});

describe("response hardening", () => {
  it("sends a CSP that forbids inline script, plus the companion headers", async () => {
    const res = await SELF.fetch("https://ops.local/");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'"); // handlers live in /app.js
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuses a cross-origin POST to a mutating route", async () => {
    const form = new FormData();
    form.set("entity_id", "repo:clownware/gittunes");
    form.set("archived", "1");
    const res = await SELF.fetch("https://ops.local/archive", {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: { origin: "https://evil.test" },
    });
    expect(res.status).toBe(403);

    // and a bare curl with no Origin at all
    const bare = await SELF.fetch("https://ops.local/health/run", { method: "POST", redirect: "manual" });
    expect(bare.status).toBe(403);
  });

  it("survives junk numeric query params instead of 500ing", async () => {
    await seedRepo();
    expect((await SELF.fetch("https://ops.local/e/repo:clownware/gittunes?offset=x")).status).toBe(200);
    expect((await SELF.fetch("https://ops.local/e/repo:clownware/gittunes?window=99999999")).status).toBe(200);
    expect((await SELF.fetch("https://ops.local/findings?min_severity=nope")).status).toBe(200);
    expect((await SELF.fetch("https://ops.local/settings?err=constructor")).status).toBe(200);
  });
});

describe("settings draft preservation", () => {
  it("re-renders a rejected budget form with the typed values intact", async () => {
    const form = new FormData();
    form.set("scope", "repo:a/b");
    form.set("period", "month");
    form.set("soft_limit", "100");
    form.set("hard_limit", "50"); // hard < soft → rejected
    const res = await SELF.fetch("https://ops.local/settings/budgets", {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: { origin: "https://ops.local" },
    });
    expect(res.status).toBe(400); // no redirect — the draft renders in place
    const html = await res.text();
    expect(html).toContain("Budget not saved");
    expect(html).toContain('value="repo:a/b"'); // what the user typed survives
    expect(html).toContain('value="50"');
  });
});

describe("standards mode", () => {
  it("every page ships a doctype — quirks mode broke table font inheritance", async () => {
    const html = await (await SELF.fetch("https://ops.local/")).text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });
});
