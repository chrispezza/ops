import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { latestSignals } from "../src/core/queries";

const NOW = Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

// INGEST_TOKEN comes from .dev.vars in dev; in tests it flows via the env binding.
const TOKEN = "test-ingest-token";

function post(body: unknown, token: string | null = TOKEN) {
  return SELF.fetch("https://ops.local/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validPayload = {
  entities: [
    {
      id: "repo:clownware/gittunes",
      kind: "repo",
      name: "gittunes",
      category: "web_app",
      sourceUrl: "https://github.com/clownware/gittunes",
    },
  ],
  signals: [
    {
      entityId: "repo:clownware/gittunes",
      metric: "lhci.performance",
      valueNum: 97,
      observedAt: NOW,
      url: "https://github.com/clownware/gittunes/actions/runs/42",
      dedupeKey: "run-42",
    },
  ],
};

describe("POST /ingest", () => {
  it("rejects missing or wrong bearer tokens", async () => {
    expect((await post(validPayload, null)).status).toBe(401);
    expect((await post(validPayload, "wrong")).status).toBe(401);
  });

  it("accepts a valid CI push and makes it queryable", async () => {
    const res = await post(validPayload);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, entities: 1, signals: 1 });

    const latest = await latestSignals(env.DB, "repo:clownware/gittunes");
    expect(latest.find((s) => s.metric === "lhci.performance")?.value_num).toBe(97);
    expect(latest[0]?.source).toBe("ci_ingest");

    // idempotent: same push again adds nothing
    await post(validPayload);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM signals").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects malformed payloads with specific errors", async () => {
    expect((await post("not json{{")).status).toBe(400);
    expect((await post({ signals: [] })).status).toBe(400);
    expect(
      (await post({ signals: [{ entityId: "repo:x", metric: "not-namespaced", observedAt: NOW, dedupeKey: "k" }] }))
        .status,
    ).toBe(400);
    expect(
      (await post({ signals: [{ entityId: "repo:x", metric: "a.b", observedAt: NOW, dedupeKey: "" }] })).status,
    ).toBe(400);
    expect(
      (await post({ signals: [{ entityId: "repo:x", metric: "a.b", observedAt: NOW, severity: 9, dedupeKey: "k" }] }))
        .status,
    ).toBe(400);
  });

  it("rejects signals for entities Ops has never seen", async () => {
    const res = await post({
      signals: [{ entityId: "repo:ghost/ghost", metric: "a.b", observedAt: NOW, dedupeKey: "k" }],
    });
    expect(res.status).toBe(400);
  });
});

describe("/findings", () => {
  it("applies the default lens: sev>=2 plus hygiene/audit hits", async () => {
    await post({
      entities: [
        { id: "repo:a", kind: "repo", name: "a", category: "web_app" },
        { id: "repo:b", kind: "repo", name: "b", category: "static_site" },
      ],
      signals: [
        { entityId: "repo:a", metric: "audit.vuln_count", valueNum: 3, severity: 3, observedAt: NOW, dedupeKey: "k1" },
        { entityId: "repo:a", metric: "tests.coverage_pct", valueNum: 81, severity: 0, observedAt: NOW, dedupeKey: "k2" },
        { entityId: "repo:b", metric: "hygiene.missing_metric", valueText: "lhci.performance", severity: 1, observedAt: NOW, dedupeKey: "lhci.performance" },
        { entityId: "repo:b", metric: "seo.score", valueNum: 55, severity: 2, observedAt: NOW, dedupeKey: "k3" },
      ],
    });

    const html = await (await SELF.fetch("https://ops.local/findings")).text();
    expect(html).toContain("audit.vuln_count");
    expect(html).toContain("hygiene.missing_metric"); // below min_severity but hygiene.* always shows
    expect(html).toContain("seo.score");
    expect(html).not.toContain("tests.coverage_pct"); // sev 0, not audit/hygiene

    // the "SEO audit view" is just a domain filter (ux §2.4)
    const seo = await (await SELF.fetch("https://ops.local/findings?domain=seo&min_severity=0")).text();
    expect(seo).toContain("seo.score");
    expect(seo).not.toContain("audit.vuln_count");

    // category filter + group toggle
    const grouped = await (await SELF.fetch("https://ops.local/findings?group=entity&category=web_app")).text();
    expect(grouped).toContain("audit.vuln_count");
    expect(grouped).not.toContain("seo.score");
  });
});
