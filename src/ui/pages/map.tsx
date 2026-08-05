import type { EntityView } from "../../core/queries";
import { Chip, Dot, newIssueUrl, timeAgo } from "../components";
import type { TriageRow } from "./triage";

const SECTIONS: { category: string; title: string }[] = [
  { category: "static_site", title: "Static Sites" },
  { category: "web_app", title: "Web Apps" },
  { category: "plugin_skill", title: "Plugins · MCPs · Skills" },
];

export function MapPage(props: { rows: TriageRow[]; q?: string; now: number }) {
  const { rows, now } = props;
  if (rows.length === 0 && !props.q) return <SetupChecklist />;

  const known = new Set(SECTIONS.map((s) => s.category));
  const uncategorized = rows.filter((r) => !r.view.category || !known.has(r.view.category));

  return (
    <>
      <form class="filters" hx-get="/" hx-target="#map-region" hx-select="#map-region" hx-swap="outerHTML" hx-push-url="true">
        <input type="search" name="q" placeholder="filter… ( / )" value={props.q ?? ""} />
        <button type="submit">apply</button>
      </form>
      <div id="map-region">
        {SECTIONS.map((s) => (
          <Section
            title={s.title}
            rows={rows.filter((r) => r.view.category === s.category)}
            now={now}
            hint={`No ${s.title.toLowerCase()} yet — tag repos with the matching topic.`}
          />
        ))}
        {uncategorized.length > 0 && (
          <Section
            title="Uncategorized"
            rows={uncategorized}
            now={now}
            warning="tag these repos with a topic: static-site · web-app · mcp · skill"
          />
        )}
      </div>
    </>
  );
}

function Section(props: { title: string; rows: TriageRow[]; now: number; hint?: string; warning?: string }) {
  const { title, rows, now } = props;
  const problems = rows.filter((r) => r.view.maxSeverity >= 2).length;
  return (
    <section class={props.warning ? "section warn" : "section"}>
      <h2>
        {title} <span class="rollup num">{rows.length}</span>
        {problems > 0 && <span class="rollup num sev">{problems} ▲</span>}
        {props.warning && <span class="rollup warn-text">{props.warning}</span>}
      </h2>
      {/* ux §3: empty sections render with hint text, not omitted — the IA stays stable */}
      {rows.length === 0 ? (
        <p class="hint">{props.hint}</p>
      ) : (
        <table class="rows">
          {rows.map((r) => (
            <Row row={r} now={now} />
          ))}
        </table>
      )}
    </section>
  );
}

function Row(props: { row: TriageRow; now: number }) {
  const { view: e, score } = props.row;
  return (
    <tr class="row">
      <td class="c-dot">
        <Dot severity={e.maxSeverity} />
      </td>
      <td class="c-name">
        <a href={`/e/${e.id}`}>{e.name}</a>
      </td>
      <td class="c-kind">{e.category ?? e.kind}</td>
      <td class="c-chips">
        <Chips entity={e} now={props.now} />
      </td>
      <td class="num">{score.total > 0 ? score.total : ""}</td>
      <td class="c-links">
        {e.source_url && <a href={e.source_url}>↗</a>}
        {e.source_url && <a href={newIssueUrl(e.source_url)}>+issue</a>}
      </td>
    </tr>
  );
}

// Per-category chip sets, hardcoded v1 (ux §6 decision: move to config only if they churn).
function Chips(props: { entity: EntityView; now: number }) {
  const { entity: e, now } = props;
  const l = e.latest;
  const pushed = (
    <Chip label="pushed" signal={l["repo.pushed_at"]} now={now} render={(s) => timeAgo(s.value_num ?? 0, now)} />
  );
  switch (e.category) {
    case "static_site":
      return (
        <>
          <Chip label="LHCI" signal={l["lhci.performance"]} now={now} />
          {pushed}
        </>
      );
    case "web_app":
      return (
        <>
          <Chip label="CI" signal={l["ci.status"]} now={now} render={(s) => (s.value_text === "success" ? "✓" : (s.value_text ?? "?"))} />
          <Chip label="vulns" signal={l["deps.vuln_count"]} now={now} />
          <Chip label="PRs" signal={l["prs.open"]} now={now} />
          {pushed}
        </>
      );
    case "plugin_skill":
      return (
        <>
          <Chip label="usage 30d" signal={l["usage.invocations"]} now={now} />
          {pushed}
        </>
      );
    default:
      return (
        <>
          <Chip label="issues" signal={l["issues.open"]} now={now} />
          <Chip label="PRs" signal={l["prs.open"]} now={now} />
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
        <li>Tag repos with topics: static-site · web-app · mcp · skill</li>
        <li>
          Wait for the hourly cron, or trigger a poll from <a href="/health">/health</a>
        </li>
      </ol>
    </div>
  );
}
