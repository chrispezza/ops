import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildHeatmap } from "../src/core/heatmap";
import type { EntityView, SignalRow } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";

const NOW = Math.floor(Date.now() / 1000);

function signal(metric: string, severity: number, over: Partial<SignalRow> = {}): SignalRow {
  return { id: 1, entity_id: "", source: "github", metric, value_num: null, value_text: null, severity, url: null, observed_at: NOW, period_start: null, period_end: null, dedupe_key: "k", ...over };
}
function view(id: string, latest: SignalRow[], category = "web_app"): EntityView {
  const byMetric: Record<string, SignalRow> = {};
  for (const s of latest) byMetric[s.metric] = { ...s, entity_id: id };
  return { id, kind: "repo", category, name: id.split("/")[1] ?? id, owner: "clownware", source_url: null, last_seen_at: NOW, latest: byMetric, maxSeverity: Math.max(0, ...latest.map((s) => s.severity)) };
}

describe("buildHeatmap", () => {
  it("grids entities against domains, hottest column and worst entity first, poller hidden", () => {
    const heat = buildHeatmap(
      [
        view("repo:clownware/calm", [signal("ci.status", 0), signal("docs.score", 0)]),
        view("repo:clownware/broken", [signal("ci.status", 3, { value_text: "failure" }), signal("ci.fail_streak", 2), signal("docs.score", 1), signal("poller.status", 3)]),
        view("repo:clownware/dusty", [signal("docs.score", 1), signal("issues.open", 0)]),
      ],
      {},
    );
    // docs has two hot cells, ci one, issues none
    expect(heat.domains).toEqual(["docs", "ci", "issues"]);
    expect(heat.rows.map((r) => r.entityName)).toEqual(["broken", "dusty", "calm"]);
    const broken = heat.rows[0];
    expect(broken?.cells.map((c) => c.severity)).toEqual([1, 3, -1]); // -1 = no signal in that domain
    // the cell's signals are worst first — its title reads the reason before the detail
    expect(broken?.cells[1]?.signals.map((s) => s.metric)).toEqual(["ci.status", "ci.fail_streak"]);
  });

  it("scopes columns by domain prefix and rows by category", () => {
    const views = [
      view("repo:clownware/a", [signal("ci.status", 3), signal("docs.score", 1)], "web_app"),
      view("repo:clownware/b", [signal("ci.status", 0)], "static_site"),
    ];
    const byDomain = buildHeatmap(views, { domain: "ci" });
    expect(byDomain.domains).toEqual(["ci"]);
    expect(byDomain.rows).toHaveLength(2);
    const byCategory = buildHeatmap(views, { category: "static_site" });
    expect(byCategory.rows.map((r) => r.entityName)).toEqual(["b"]);
    expect(byCategory.domains).toEqual(["ci"]); // docs only existed on the filtered-out row
  });
});

describe("/findings?view=heat", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM signal_latest"), env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
  });

  it("renders the grid with severity cells and a toggle back to the list", async () => {
    await upsertEntities(env.DB, [{ id: "repo:clownware/gittunes", kind: "repo", category: "web_app", name: "gittunes", owner: "clownware" }], NOW);
    await insertSignals(env.DB, "github", [
      { entityId: "repo:clownware/gittunes", metric: "ci.status", valueText: "failure", severity: 3, observedAt: NOW, dedupeKey: "a" },
      { entityId: "repo:clownware/gittunes", metric: "docs.score", valueNum: 66, valueText: "missing: license", severity: 1, observedAt: NOW, dedupeKey: "b" },
    ]);
    const html = await (await SELF.fetch("https://ops.local/findings?view=heat")).text();
    expect(html).toContain('class="heat"');
    expect(html).toMatch(/<td[^>]*class="heat-cell"[^>]*data-sev="3"/);
    // docs sits below the default floor of 2: shape, not alarm
    expect(html).toMatch(/<td[^>]*class="heat-cell quiet"[^>]*data-sev="1"/);
    expect(html).toContain("CI status: failure (high)");
    expect(html).toMatch(/<a href="\/findings\?min_severity=2"[^>]*>\s*list/);
    // the list view is untouched and links to the grid
    const list = await (await SELF.fetch("https://ops.local/findings")).text();
    expect(list).not.toContain('class="heat"');
    expect(list).toMatch(/<a href="\/findings\?min_severity=2&amp;view=heat"[^>]*>\s*grid/);
  });
});
