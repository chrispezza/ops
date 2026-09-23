import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildBoard } from "../src/core/board";
import type { DigestResolvedRow, EntityView, SignalRow } from "../src/core/queries";
import { insertSignals, upsertEntities } from "../src/core/store";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function signal(metric: string, over: Partial<SignalRow> = {}): SignalRow {
  return {
    id: 1,
    entity_id: "repo:clownware/ops",
    source: "github",
    metric,
    value_num: null,
    value_text: null,
    severity: 0,
    url: null,
    observed_at: NOW,
    period_start: null,
    period_end: null,
    dedupe_key: "k",
    ...over,
  };
}

function view(id: string, latest: SignalRow[], over: Partial<EntityView> = {}): EntityView {
  const byMetric: Record<string, SignalRow> = {};
  for (const s of latest) byMetric[s.metric] = { ...s, entity_id: id };
  return {
    id,
    kind: "repo",
    category: "web_app",
    name: id.split("/")[1] ?? id,
    owner: "clownware",
    source_url: `https://github.com/${id.slice("repo:".length)}`,
    last_seen_at: NOW,
    latest: byMetric,
    maxSeverity: Math.max(0, ...latest.map((s) => s.severity)),
    ...over,
  };
}

const issueCards = (cards: { n: number; t: string; l: string; s: 1 | 2 | 3; c?: number; u?: number }[]) =>
  signal("issues.cards", { value_num: cards.length, value_text: JSON.stringify(cards.map((c) => ({ c: NOW - 10 * DAY, u: NOW - 2 * DAY, ...c }))) });
const prCards = (cards: { n: number; t: string; a: string; c: number; d?: boolean; b?: boolean; m?: string }[]) =>
  signal("prs.cards", { value_num: cards.length, value_text: JSON.stringify(cards.map((c) => ({ d: false, b: false, ...c }))) });

const column = (cols: ReturnType<typeof buildBoard>, key: string) => cols.find((c) => c.key === key)?.cards ?? [];

describe("buildBoard", () => {
  it("lands issue cards by label severity and signal findings by their severity, one rule", () => {
    const cols = buildBoard(
      [
        view("repo:clownware/ops", [
          issueCards([
            { n: 51, t: "rotate the key", l: "p0", s: 3 },
            { n: 10, t: "hydration", l: "P1", s: 2 },
            { n: 53, t: "polish copy", l: "P2", s: 1 },
          ]),
          signal("issues.flagged", { severity: 3, value_num: 3 }), // shadowed by the cards row
          signal("ci.status", { severity: 3, value_text: "failure", url: "https://github.com/clownware/ops/actions" }),
          signal("deps.vuln_count", { severity: 2, value_num: 4, value_text: "2 high · 2 moderate/low" }),
          signal("docs.score", { severity: 1, value_num: 66, value_text: "missing: license" }),
          signal("issues.open", { severity: 0, value_num: 3 }), // severity 0 never becomes a card
        ]),
      ],
      [],
      NOW,
    );
    expect(column(cols, "now").map((c) => c.title)).toEqual(["#51 rotate the key", "CI status"]);
    expect(column(cols, "now").map((c) => c.kind)).toEqual(["issue", "signal"]);
    expect(column(cols, "now")[0]?.url).toBe("https://github.com/clownware/ops/issues/51");
    expect(column(cols, "now")[0]?.detail).toBe("p0 · updated 2d ago");
    expect(column(cols, "next").map((c) => c.title)).toEqual(["#10 hydration", "Dependabot vulns"]);
    expect(column(cols, "later").map((c) => c.title)).toEqual(["#53 polish copy", "docs health"]);
    // the flagged finding is not a second card for the same issues
    expect(cols.flatMap((c) => c.cards).some((c) => c.title === "flagged issues")).toBe(false);
  });

  it("keeps the flagged finding when no cards row exists yet", () => {
    const cols = buildBoard([view("repo:clownware/old", [signal("issues.flagged", { severity: 2, value_num: 1, value_text: "#4 thing (P1)" })])], [], NOW);
    expect(column(cols, "next").map((c) => c.title)).toEqual(["flagged issues"]);
  });

  it("sorts PRs into in-flight, later, next by age and drops quiet Dependabot PRs", () => {
    const cols = buildBoard(
      [
        view("repo:clownware/ops", [
          prCards([
            { n: 1, t: "fresh", a: "chrispezza", c: NOW - 2 * DAY, d: true },
            { n: 2, t: "two weeks", a: "chrispezza", c: NOW - 15 * DAY },
            { n: 3, t: "a month", a: "chrispezza", c: NOW - 31 * DAY },
            { n: 4, t: "bump x from 1.0 to 1.1", a: "dependabot", c: NOW - 3 * DAY, b: true },
            { n: 5, t: "bump hono from 3.0 to 4.0", a: "dependabot", c: NOW - 3 * DAY, b: true, m: "hono 3→4" },
            { n: 6, t: "bump y from 1.0 to 1.1", a: "dependabot", c: NOW - 40 * DAY, b: true },
          ]),
          signal("prs.oldest_days", { severity: 2, value_num: 31 }), // shadowed by the cards row
          signal("repo.pushed_at", { value_num: NOW - DAY }),
        ]),
      ],
      [],
      NOW,
    );
    expect(column(cols, "inflight").map((c) => c.title)).toEqual(["#1 fresh"]);
    expect(column(cols, "inflight")[0]?.detail).toBe("chrispezza · draft · open 2d");
    expect(column(cols, "later").map((c) => c.title)).toEqual(["#6 bump y from 1.0 to 1.1", "#2 two weeks", "#5 bump hono from 3.0 to 4.0"]);
    expect(column(cols, "next").map((c) => c.title)).toEqual(["#3 a month"]);
    expect(column(cols, "next")[0]?.ageDays).toBe(31);
    // #4 is the bot's queue, not the maintainer's
    expect(cols.flatMap((c) => c.cards).some((c) => c.title.startsWith("#4"))).toBe(false);
  });

  it("marks a recently pushed repo with no open PR as in flight, and shipped work as done", () => {
    const cols = buildBoard(
      [
        view("repo:clownware/busy", [
          signal("repo.pushed_at", { value_num: NOW - 2 * DAY }),
          signal("issues.closed_7d", { value_num: 3 }),
          signal("prs.merged_7d", { value_num: 1 }),
        ]),
        view("repo:clownware/quiet", [signal("repo.pushed_at", { value_num: NOW - 40 * DAY }), signal("issues.closed_7d", { value_num: 0 })]),
      ],
      [
        {
          ...signal("ci.status", { entity_id: "repo:clownware/busy", severity: 0, value_text: "success" }),
          entity_name: "busy",
          entity_kind: "repo",
          peak: 3,
        } as DigestResolvedRow,
        { ...signal("ci.status", { entity_id: "repo:elsewhere/x" }), entity_name: "x", entity_kind: "repo", peak: 3 } as DigestResolvedRow,
      ],
      NOW,
    );
    expect(column(cols, "inflight").map((c) => [c.entityName, c.title])).toEqual([["busy", "recent pushes"]]);
    expect(column(cols, "done").map((c) => [c.entityName, c.title, c.detail])).toEqual([
      ["busy", "3 issues closed · 1 PR merged", "trailing 7d"],
      ["busy", "CI status resolved", "peaked high"],
    ]);
  });

  it("survives a malformed cards row", () => {
    const cols = buildBoard([view("repo:clownware/ops", [signal("issues.cards", { value_num: 1, value_text: "{not json" })])], [], NOW);
    expect(cols.flatMap((c) => c.cards)).toEqual([]);
  });
});

describe("/board page", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM signal_latest"), env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
  });

  it("renders five columns with cards linking to the system of record, scoped by owner", async () => {
    await upsertEntities(
      env.DB,
      [
        { id: "repo:clownware/ops", kind: "repo", category: "web_app", name: "ops", owner: "clownware", sourceUrl: "https://github.com/clownware/ops" },
        { id: "repo:chrispezza/site", kind: "repo", category: "static_site", name: "site", owner: "chrispezza", sourceUrl: "https://github.com/chrispezza/site" },
      ],
      NOW,
    );
    await insertSignals(env.DB, "github", [
      {
        entityId: "repo:clownware/ops",
        metric: "issues.cards",
        valueNum: 1,
        valueText: JSON.stringify([{ n: 7, t: "ship the board", l: "p0", s: 3, c: NOW - DAY, u: NOW }]),
        observedAt: NOW,
        dedupeKey: "h",
      },
      { entityId: "repo:chrispezza/site", metric: "site.up", valueNum: 0, valueText: "down", severity: 3, url: "https://site.example", observedAt: NOW, dedupeKey: "h" },
    ]);
    const html = await (await SELF.fetch("https://ops.local/board")).text();
    expect(html).toContain('id="col-now"');
    expect(html).toContain('id="col-done"');
    expect(html).toContain("#7 ship the board");
    expect(html).toContain('href="https://github.com/clownware/ops/issues/7"');
    expect(html).toContain("site status");
    // the same-column card from the other owner disappears under the scope
    const scoped = await (await SELF.fetch("https://ops.local/board?owner=clownware")).text();
    expect(scoped).toContain("#7 ship the board");
    expect(scoped).not.toContain("site status");
  });

  it("teaches on an empty database", async () => {
    const html = await (await SELF.fetch("https://ops.local/board")).text();
    expect(html).toContain("No cards");
  });
});
