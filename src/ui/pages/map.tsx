import { TOPIC_CATEGORY } from "../../config";
import type { ArchivedEntity, EntityView } from "../../core/queries";
import { Chip, Dot, ExtLink, formatSignalValue, newIssueUrl, ScoreBar, timeAgo } from "../components";
import { PRIORITY_VIEW, priorityHref, type TriageFilters, TriagePage, type TriageRow } from "./triage";

// The empty-state hint must name the actual topic — "tag with the matching
// topic" taught nothing. Derived from TOPIC_CATEGORY so the hint can never
// drift from what the github poller accepts (#61).
const topicsFor = (category: string): string => {
  const topics = Object.keys(TOPIC_CATEGORY).filter((t) => TOPIC_CATEGORY[t] === category);
  return topics.length > 1 ? `${topics.slice(0, -1).join(", ")} or ${topics.at(-1)}` : (topics[0] ?? "");
};

const SECTIONS: { category: string; title: string; topics: string }[] = [
  { category: "static_site", title: "Static Sites" },
  { category: "web_app", title: "Web Apps" },
  { category: "plugin_skill", title: "Plugins · MCPs · Skills" },
  { category: "tooling", title: "Tools · Templates · Experiments" },
  { category: "client_project", title: "Client Projects" },
].map((s) => ({ ...s, topics: topicsFor(s.category) }));

const ALL_TOPICS = Object.keys(TOPIC_CATEGORY).join(" · ");

// by category (the map) ⇄ by priority (the flattened, scored worklist) —
// two faces of "/", switched by a param so either is a bookmark (ux §0.1)
function ViewToggle(props: { priority: boolean; categoryHref: string; priorityHref: string }) {
  return (
    <span class="view-toggle" role="group" aria-label="view">
      <a href={props.categoryHref} class={props.priority ? "" : "active"} aria-current={props.priority ? undefined : "page"}>
        by category
      </a>
      <a href={props.priorityHref} class={props.priority ? "active" : ""} aria-current={props.priority ? "page" : undefined}>
        by priority
      </a>
    </span>
  );
}

function categoryHref(f: { q?: string; owner?: string; category?: string }): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.owner) params.set("owner", f.owner);
  if (f.category) params.set("category", f.category);
  const qs = params.toString();
  return qs ? `/?${qs}` : "/";
}

export function MapPage(props: {
  rows: TriageRow[];
  archived: ArchivedEntity[];
  q?: string;
  owner?: string;
  category?: string; // ux §1: /?category=web_app narrows to one section
  owners: string[];
  stale: ReadonlySet<string>;
  now: number;
  // present = the priority view: the worklist replaces the category sections
  priority?: { rows: TriageRow[]; filters: TriageFilters };
}) {
  const { rows, now, stale } = props;
  if (rows.length === 0 && !props.q && !props.owner && !props.priority) return <SetupChecklist />;
  const sections = props.category ? SECTIONS.filter((s) => s.category === props.category) : SECTIONS;
  const maxScore = Math.max(0, ...rows.map((r) => r.score.total));

  if (props.priority) {
    const f = props.priority.filters;
    return (
      <>
        <TriagePage
          rows={props.priority.rows}
          filters={f}
          owners={props.owners}
          stale={stale}
          now={now}
          viewToggle={<ViewToggle priority categoryHref={categoryHref(f)} priorityHref={priorityHref(f)} />}
        />
      </>
    );
  }

  const known = new Set(SECTIONS.map((s) => s.category));
  // Portfolio sections hold repos; vendor/spend entities get their own section;
  // "tag these repos" only ever applies to actual repos (spec §2.4).
  const vendors = rows.filter((r) => r.view.category === "vendor_api");
  const untagged = rows.filter((r) => r.view.kind === "repo" && (!r.view.category || !known.has(r.view.category)));
  const other = rows.filter(
    (r) => r.view.kind !== "repo" && r.view.category !== "vendor_api" && !known.has(r.view.category ?? ""),
  );

  return (
    <>
      <form class="filters" hx-get="/" hx-target="#map-region" hx-select="#map-region" hx-swap="outerHTML" hx-push-url="true">
        <input type="search" name="q" placeholder="filter… ( / )" value={props.q ?? ""} aria-label="filter entities" />
        {/* the owner toggle is anchors, not a field — without this hidden input,
            submitting the filter silently dropped the active owner scope */}
        {props.owner && <input type="hidden" name="owner" value={props.owner} />}
        {props.category && <input type="hidden" name="category" value={props.category} />}
        <button type="submit">apply</button>
        <ViewToggle priority={false} categoryHref={categoryHref(props)} priorityHref={priorityHref({ q: props.q, owner: props.owner, category: props.category })} />
        {/* ux §1: owner is a first-class map param */}
        <span class="owner-toggle">
          <a href={props.q ? `/?q=${encodeURIComponent(props.q)}` : "/"} class={!props.owner ? "active" : ""}>
            all
          </a>
          {props.owners.map((o) => (
            <a
              href={`/?owner=${encodeURIComponent(o)}${props.q ? `&q=${encodeURIComponent(props.q)}` : ""}`}
              class={props.owner === o ? "active" : ""}
            >
              {o}
            </a>
          ))}
        </span>
      </form>
      <AttentionStrip rows={rows} />
      <div id="map-region">
        {props.category && (
          <p class="hint">
            showing {SECTIONS.find((s) => s.category === props.category)?.title ?? props.category} —{" "}
            <a href="/">all categories</a>
          </p>
        )}
        {sections.map((s) => (
          <Section
            title={s.title}
            // individual skills would flood the one-screen map: repos and
            // plugins get rows, skills roll up into the section header
            rows={rows.filter((r) => r.view.category === s.category && r.view.kind !== "skill")}
            now={now}
            // filtered-empty is "no matches", not "go tag repos on GitHub" —
            // the old hint was factually wrong whenever a filter was active
            hint={
              props.q || props.owner
                ? `No matches${props.q ? ` for “${props.q}”` : ""} here.`
                : `No ${s.title} yet — tag repos with topic ${s.topics}.`
            }
            rollup={s.category === "plugin_skill" ? skillsRollup(rows) : undefined}
            note={uptimeHint(s.category, rows)}
            stale={stale}
            maxScore={maxScore}
          />
        ))}
        {!props.category && vendors.length > 0 && <Section title="Vendor APIs & Keys" rows={vendors} now={now} stale={stale} maxScore={maxScore} />}
        {!props.category && untagged.length > 0 && (
          <Section
            title="Uncategorized"
            rows={untagged}
            now={now}
            stale={stale}
            maxScore={maxScore}
            warning={`tag these repos with a topic: ${ALL_TOPICS}`}
          />
        )}
        {!props.category && other.length > 0 && <Section title="Other" rows={other} now={now} stale={stale} maxScore={maxScore} />}
        {props.archived.length > 0 && (
          <details class="section archived-section">
            <summary>
              Archived <span class="rollup num">{props.archived.length}</span>
            </summary>
            <table role="table" class="rows">
              {props.archived
                .filter((a) => !props.owner || a.owner === props.owner)
                .map((a) => (
                  <tr role="row" class="row" data-href={`/e/${a.id}`}>
                    <td role="cell" class="c-dot">
                      <Dot severity={0} />
                    </td>
                    <td role="cell" class="c-name">
                      <a href={`/e/${a.id}`}>{a.name}</a>
                    </td>
                    <td role="cell" class="c-kind">
                      {a.category ?? a.kind}
                      {a.owner && <span class="owner"> · {a.owner}</span>}
                    </td>
                  </tr>
                ))}
            </table>
          </details>
        )}
      </div>
    </>
  );
}

// The daily question answered in zero clicks: top scorers, right at the top.
function AttentionStrip(props: { rows: TriageRow[] }) {
  const top = [...props.rows].sort((a, b) => b.score.total - a.score.total).filter((r) => r.score.total > 0).slice(0, 3);
  if (top.length === 0) return null;
  return (
    <p class="attention">
      <span class="attention-label">needs attention</span>
      {top.map((r) => (
        <a href={`/e/${r.view.id}`} title={r.score.parts.map((p) => `+${p.points} ${p.label}`).join(" · ")}>
          <Dot severity={r.view.maxSeverity} /> {r.view.name} <span class="num">{r.score.total}</span>
        </a>
      ))}
      <a href="/board" class="attention-more">
        board →
      </a>
      <a href={`/?view=${PRIORITY_VIEW}`} class="attention-more attention-more-2">
        by priority →
      </a>
    </p>
  );
}

// Teach the Website-field enrollment exactly when it applies: a deployed-site
// section containing repos with no uptime signal.
function uptimeHint(category: string, rows: TriageRow[]): string | undefined {
  if (category !== "static_site" && category !== "web_app") return undefined;
  const inSection = rows.filter((r) => r.view.category === category);
  if (inSection.length === 0 || !inSection.some((r) => !r.view.latest["site.up"])) return undefined;
  return "repos with a Website field on GitHub get uptime monitoring";
}

// ux §2.1: skills section header rolls up skill inventory + 30d invocations.
function skillsRollup(rows: TriageRow[]): string | undefined {
  const parts: string[] = [];
  const skills = rows.filter((r) => r.view.category === "plugin_skill" && r.view.kind === "skill");
  if (skills.length > 0) {
    const flagged = skills.filter((r) => r.view.maxSeverity >= 1).length;
    parts.push(`${skills.length} skills${flagged > 0 ? ` (${flagged} flagged)` : ""}`);
  }
  const sums = rows.filter((r) => r.view.category === "plugin_skill" && r.usage30d != null);
  if (sums.length > 0) parts.push(`Σ ${sums.reduce((total, r) => total + (r.usage30d ?? 0), 0)} invocations 30d`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function Section(props: {
  title: string;
  rows: TriageRow[];
  now: number;
  hint?: string;
  warning?: string;
  rollup?: string;
  note?: string;
  stale?: ReadonlySet<string>;
  maxScore: number;
}) {
  const { title, rows, now } = props;
  const stale = props.stale ?? new Set<string>();
  const problems = rows.filter((r) => r.view.maxSeverity >= 2).length;
  return (
    <section class={props.warning ? "section warn" : "section"}>
      <h2>
        {title} <span class="rollup num">{rows.length}</span>
        {problems > 0 && <span class="rollup num sev">{problems} ▲</span>}
        {props.rollup && <span class="rollup num">{props.rollup}</span>}
        {props.warning && <span class="rollup warn-text">{props.warning}</span>}
      </h2>
      {/* ux §3: empty sections render with hint text, not omitted — the IA stays stable */}
      {rows.length === 0 ? (
        <p class="hint">{props.hint}</p>
      ) : (
        <>
          {/* shared fixed geometry across every section — auto layout sized
              name/kind/score per section from content, so columns wandered
              between Static Sites and Web Apps (same disease entity and
              findings had; chips stay the one flexible column) */}
          <table role="table" class="rows map-cols">
            <colgroup>
              <col class="w-dot" />
              <col class="w-name" />
              <col class="w-kind" />
              <col />
              <col class="w-score" />
              <col class="w-links" />
            </colgroup>
            {rows.map((r) => (
              <Row row={r} now={now} stale={stale} maxScore={props.maxScore} />
            ))}
          </table>
          {props.note && <p class="hint">{props.note}</p>}
        </>
      )}
    </section>
  );
}

function Row(props: { row: TriageRow; now: number; stale: ReadonlySet<string>; maxScore: number }) {
  const { view: e, score } = props.row;
  return (
    <tr role="row" class="row" data-href={`/e/${e.id}`}>
      <td role="cell" class="c-dot">
        <Dot severity={e.maxSeverity} />
      </td>
      <td role="cell" class="c-name">
        <a href={`/e/${e.id}`}>{e.name}</a>
      </td>
      <td role="cell" class="c-kind">
        {e.category ?? e.kind}
        {e.owner && <span class="owner"> · {e.owner}</span>}
      </td>
      <td role="cell" class="c-chips">
        <Chips row={props.row} now={props.now} stale={props.stale} />
      </td>
      {/* the map has no header row, so the tooltip must say what the naked number IS */}
      <td role="cell" class="num c-score" title={`triage score${score.parts.length ? ` — ${score.parts.map((p) => `+${p.points} ${p.label}`).join(" · ")}` : ""}`}>
        {score.total > 0 ? score.total : ""} <ScoreBar total={score.total} max={props.maxScore} />
      </td>
      <td role="cell" class="c-links">
        {/* the uptime signal's url IS the deployed site — one link, straight to prod */}
        <ExtLink url={e.latest["site.up"]?.url}>live</ExtLink>
        <ExtLink url={e.source_url} />
        {/* pre-filled new-issue is a repo affordance — meaningless on vendor consoles */}
        {e.kind === "repo" && e.source_url && <ExtLink url={newIssueUrl(e.source_url)}>+issue</ExtLink>}
      </td>
    </tr>
  );
}

// Per-category chip sets, hardcoded v1 (ux §6 decision: move to config only if they churn).
function Chips(props: { row: TriageRow; now: number; stale: ReadonlySet<string> }) {
  const { view: e, usage30d } = props.row;
  const { now, stale } = props;
  const l = e.latest;
  // every chip in this set carries the failing-source dimming (spec §3)
  const C = (p: Parameters<typeof Chip>[0]) => <Chip {...p} staleSources={stale} />;
  const pushed = (
    <C label="pushed" signal={l["repo.pushed_at"]} now={now} render={(s) => timeAgo(s.value_num ?? 0, now)} />
  );
  // site.up appears only for repos with a deployed homepage — not expected of
  // every repo, so absence renders nothing rather than a warning dash
  const site = l["site.up"] && (
    <C label="site" signal={l["site.up"]} now={now} render={(s) => (s.value_num === 1 ? "up" : "DOWN")} />
  );
  const branches = l["repo.branches"] && <C label="branches" signal={l["repo.branches"]} now={now} />; // "br" decoded to nothing, even in its tooltip
  // docs health earns a chip only while incomplete — complete docs are silence
  const docs = l["docs.score"] && (l["docs.score"]?.value_num ?? 100) < 100 && (
    <C label="docs" signal={l["docs.score"]} now={now} render={(s) => String(s.value_num ?? "?")} />
  );
  switch (e.category) {
    case "static_site":
      return (
        <>
          {site}
          <C label="LHCI" signal={l["lhci.performance"]} now={now} />
          {branches}
          {docs}
          {pushed}
        </>
      );
    case "web_app":
      return (
        <>
          {site}
          <C label="CI" signal={l["ci.status"]} now={now} render={(s) => (s.value_text === "success" ? "✓" : (s.value_text ?? "?"))} />
          <C label="vulns" signal={l["deps.vuln_count"]} now={now} render={(s) => String(s.value_num ?? 0)} />
          <C label="PRs" signal={l["prs.open"]} now={now} />
          {branches}
          {docs}
          {pushed}
        </>
      );
    case "tooling":
      return (
        <>
          <C label="issues" signal={l["issues.open"]} now={now} />
          {branches}
          {docs}
          {pushed}
        </>
      );
    case "plugin_skill":
      if (e.kind === "plugin") {
        return (
          <>
            <C label="skills" signal={l["manifest.skill_count"]} now={now} />
            <C label="manifest" signal={l["manifest.description"]} now={now} />
          </>
        );
      }
      return (
        <>
          {/* interval metric: 30d SUM, never the latest row (spec §2.2) */}
          {usage30d == null ? (
            <span class="chip missing" title="usage 30d: no data">
              usage 30d —
            </span>
          ) : (
            <span class="chip" title="invocations, 30d sum">
              usage 30d {usage30d}
            </span>
          )}
          {pushed}
        </>
      );
    case "vendor_api": {
      if (e.kind === "worker") {
        return <C label="errors" signal={l["cf.error_rate"]} now={now} render={(s) => formatSignalValue(s, now)} />;
      }
      if (e.kind === "database") {
        return <C label="size" signal={l["d1.size_bytes"]} now={now} render={(s) => formatSignalValue(s, now)} />;
      }
      const anomaly = l["spend.anomaly"];
      const budget = l["budget.status"];
      return (
        <>
          {anomaly && anomaly.severity >= 2 && <C label="anomaly" signal={anomaly} now={now} render={(s) => formatSignalValue(s, now)} />}
          {budget && budget.severity >= 2 && <C label="budget" signal={budget} now={now} render={(s) => formatSignalValue(s, now)} />}
          <a href="/spend" class="chip">
            spend →
          </a>
        </>
      );
    }
    default:
      return (
        <>
          <C label="issues" signal={l["issues.open"]} now={now} />
          <C label="PRs" signal={l["prs.open"]} now={now} />
          {branches}
          {docs}
          {pushed}
        </>
      );
  }
}

// ux §3: first-run empty state teaches setup
export function SetupChecklist() {
  return (
    <div class="empty-state">
      <strong>No data yet.</strong> To fill this dashboard:
      <ol>
        <li>
          Set secrets: <code>wrangler secret put GITHUB_PAT</code>
        </li>
        <li>
          Set <code>GITHUB_OWNERS</code> in wrangler.jsonc vars
        </li>
        <li>Tag repos with topics: {ALL_TOPICS}</li>
        <li>
          Wait for the hourly cron, or trigger a poll from <a href="/health">/health</a>
        </li>
      </ol>
    </div>
  );
}
