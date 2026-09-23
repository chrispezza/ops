import { labelForMetric } from "../../config";
import type { EntityView } from "../../core/queries";
import { activityAt, type Score } from "../../core/score";
import { Chip, Dot, ExtLink, newIssueUrl, safeHref, ScoreBar, SortTh } from "../components";

export interface TriageRow {
  view: EntityView;
  score: Score;
  usage30d: number | null; // 30d invocation SUM for usage-kinds; null = no data / not applicable
}

export interface TriageFilters {
  kind?: string;
  category?: string;
  owner?: string;
  minSeverity?: number;
  q?: string;
  sort?: string;
}

// The priority view is the map's other face (ux §2.2, open question 1
// resolved): same URL, `view=priority`, so every link here carries it.
export const PRIORITY_VIEW = "priority";

export function priorityHref(f: TriageFilters, over: Partial<TriageFilters> = {}): string {
  const m = { ...f, ...over };
  const params = new URLSearchParams();
  params.set("view", PRIORITY_VIEW);
  if (m.q) params.set("q", m.q);
  if (m.kind) params.set("kind", m.kind);
  if (m.category) params.set("category", m.category);
  if (m.owner) params.set("owner", m.owner);
  if (m.minSeverity) params.set("min_severity", String(m.minSeverity));
  if (m.sort) params.set("sort", m.sort);
  return `/?${params.toString()}`;
}

const sortHref = (f: TriageFilters, sort: string): string => priorityHref(f, { sort });

// The daily driver: the map flattened and sorted by pain (ux §2.2).
export function TriagePage(props: {
  rows: TriageRow[];
  filters: TriageFilters;
  owners: string[];
  stale?: ReadonlySet<string>;
  now: number;
  viewToggle?: unknown; // the map's category ⇄ priority switch, rendered inside the form
}) {
  return (
    <>
      <form class="filters" hx-get="/" hx-target="#triage-table" hx-select="#triage-table" hx-swap="outerHTML" hx-push-url="true">
        <input type="hidden" name="view" value={PRIORITY_VIEW} />
        <input type="search" name="q" placeholder="filter… ( / )" value={props.filters.q ?? ""} aria-label="filter entities" />
        {/* sort isn't a form control — without the hidden field, applying any
            filter silently reset the sort the user had chosen */}
        {props.filters.sort && <input type="hidden" name="sort" value={props.filters.sort} />}
        <select name="owner" aria-label="owner">
          <option value="">all owners</option>
          {props.owners.map((o) => (
            <option value={o} selected={props.filters.owner === o}>
              {o}
            </option>
          ))}
        </select>
        <select name="category" aria-label="category">
          <option value="">all categories</option>
          {["static_site", "web_app", "plugin_skill", "tooling", "client_project", "vendor_api"].map((c) => (
            <option value={c} selected={props.filters.category === c}>
              {c}
            </option>
          ))}
        </select>
        <select name="min_severity" aria-label="minimum severity">
          {[0, 1, 2, 3, 4].map((s) => (
            <option value={String(s)} selected={(props.filters.minSeverity ?? 0) === s}>
              sev ≥ {s}
            </option>
          ))}
        </select>
        <button type="submit">apply</button>
        {props.viewToggle}
      </form>
      <TriageTable rows={props.rows} filters={props.filters} stale={props.stale} now={props.now} />
    </>
  );
}

export function TriageTable(props: {
  rows: TriageRow[];
  filters: TriageFilters;
  stale?: ReadonlySet<string>;
  now: number;
}) {
  const sort = props.filters.sort ?? "score";
  const maxScore = Math.max(0, ...props.rows.map((r) => r.score.total));
  if (props.rows.length === 0) {
    return (
      <div id="triage-table">
        <p class="hint">Nothing matches. Either the portfolio is healthy or the filters are too tight.</p>
      </div>
    );
  }
  return (
    <table role="table" class="rows" id="triage-table">
      <tr role="row">
        <th role="columnheader" scope="col" />
        <SortTh label="entity" href={sortHref(props.filters, "name")} active={sort === "name"} dir="ascending" />
        <th role="columnheader" scope="col">kind</th>
        <th role="columnheader" scope="col">top signal</th>
        <th role="columnheader" scope="col">why</th>
        {/* no hardcoded numbers: the weights live in /settings, so a tooltip
            quoting the defaults becomes a lie the moment they're edited —
            per-row breakdowns (expand the "why") carry the real arithmetic */}
        <SortTh
          label="score"
          href={sortHref(props.filters, "score")}
          active={sort === "score"}
          dir="descending"
          class="num"
          title="triage score: severity + breadth + staleness + zero-usage — weights in /settings, breakdown under each row's why"
        />
        <SortTh label="issues" href={sortHref(props.filters, "issues")} active={sort === "issues"} dir="descending" class="num" />
        <SortTh label="vulns" href={sortHref(props.filters, "vulns")} active={sort === "vulns"} dir="descending" class="num" />
        {/* most-stale first = descending by the days shown in the column */}
        <SortTh label="stale" href={sortHref(props.filters, "stale")} active={sort === "stale"} dir="descending" class="num" />
        <th role="columnheader" scope="col" />
      </tr>
      {props.rows.map((r) => (
        <Row row={r} now={props.now} stale={props.stale} maxScore={maxScore} />
      ))}
    </table>
  );
}

function Row(props: { row: TriageRow; now: number; stale?: ReadonlySet<string>; maxScore: number }) {
  const { view: e, score } = props.row;
  const worst = Object.values(e.latest)
    .filter((s) => s.severity > 0)
    .sort((a, b) => b.severity - a.severity)[0];
  const staleDays = Math.floor((props.now - activityAt(e)) / 86_400);
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
        {worst ? <Chip label={labelForMetric(worst.metric)} signal={worst} now={props.now} staleSources={props.stale} /> : <span class="hint">—</span>}
      </td>
      <td role="cell" class="c-why">
        {/* score breakdown behind a native disclosure — no endpoint needed.
            No parts = plain dash: an expander opening an empty list is a trap */}
        {score.parts.length === 0 ? (
          <span class="hint">—</span>
        ) : (
          <details>
            <summary>{score.parts.slice(0, 2).map((p) => p.label).join(" · ")}</summary>
            <ul class="breakdown">
              {score.parts.map((p) => (
                <li>
                  <span class="num">+{p.points}</span> {p.label}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td role="cell" class="num c-score">
        {score.total} <ScoreBar total={score.total} max={props.maxScore} />
      </td>
      <td role="cell" class="num c-kind">
        {e.latest["issues.open"]?.value_num != null && (
          <a href={safeHref(e.latest["issues.open"]?.url) ?? `/e/${e.id}`}>{e.latest["issues.open"]?.value_num}</a>
        )}
      </td>
      <td role="cell" class="num c-kind">
        {e.latest["deps.vuln_count"]?.value_num != null && (
          <a href={safeHref(e.latest["deps.vuln_count"]?.url) ?? `/e/${e.id}`}>{e.latest["deps.vuln_count"]?.value_num}</a>
        )}
      </td>
      <td role="cell" class="num c-kind">{staleDays > 0 ? `${staleDays}d` : ""}</td>
      <td role="cell" class="c-links">
        <ExtLink url={e.source_url} />
        {e.kind === "repo" && e.source_url && <ExtLink url={newIssueUrl(e.source_url)}>+issue</ExtLink>}
      </td>
    </tr>
  );
}
