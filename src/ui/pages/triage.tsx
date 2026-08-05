import type { EntityView } from "../../core/queries";
import type { Score } from "../../core/score";
import { Chip, Dot, newIssueUrl } from "../components";

export interface TriageRow {
  view: EntityView;
  score: Score;
}

export interface TriageFilters {
  kind?: string;
  category?: string;
  minSeverity?: number;
  q?: string;
}

// The daily driver: the map flattened and sorted by pain (ux §2.2).
export function TriagePage(props: { rows: TriageRow[]; filters: TriageFilters; now: number }) {
  return (
    <>
      <form class="filters" hx-get="/triage" hx-target="#triage-table" hx-select="#triage-table" hx-swap="outerHTML" hx-push-url="true">
        <input type="search" name="q" placeholder="filter… ( / )" value={props.filters.q ?? ""} />
        <select name="category">
          <option value="">all categories</option>
          {["static_site", "web_app", "plugin_skill"].map((c) => (
            <option value={c} selected={props.filters.category === c}>
              {c}
            </option>
          ))}
        </select>
        <select name="min_severity">
          {[0, 1, 2, 3, 4].map((s) => (
            <option value={String(s)} selected={(props.filters.minSeverity ?? 0) === s}>
              sev ≥ {s}
            </option>
          ))}
        </select>
        <button type="submit">apply</button>
      </form>
      <TriageTable rows={props.rows} now={props.now} />
    </>
  );
}

export function TriageTable(props: { rows: TriageRow[]; now: number }) {
  if (props.rows.length === 0) {
    return (
      <div id="triage-table">
        <p class="hint">Nothing matches. Either the portfolio is healthy or the filters are too tight.</p>
      </div>
    );
  }
  return (
    <table class="rows" id="triage-table">
      <tr>
        <th />
        <th>entity</th>
        <th>kind</th>
        <th>top signal</th>
        <th>why</th>
        <th class="num">score</th>
        <th />
      </tr>
      {props.rows.map((r) => (
        <Row row={r} now={props.now} />
      ))}
    </table>
  );
}

function Row(props: { row: TriageRow; now: number }) {
  const { view: e, score } = props.row;
  const worst = Object.values(e.latest)
    .filter((s) => s.severity > 0)
    .sort((a, b) => b.severity - a.severity)[0];
  return (
    <tr class="row">
      <td class="c-dot">
        <Dot severity={e.maxSeverity} />
      </td>
      <td class="c-name">
        <a href={`/e/${e.id}`}>{e.name}</a>
      </td>
      <td class="c-kind">{e.category ?? e.kind}</td>
      <td class="c-chips">{worst ? <Chip label={worst.metric} signal={worst} now={props.now} /> : <span class="hint">—</span>}</td>
      <td class="c-why">
        {/* score breakdown behind a native disclosure — no endpoint needed */}
        <details>
          <summary>{score.parts.slice(0, 2).map((p) => p.label).join(" · ") || "—"}</summary>
          <ul class="breakdown">
            {score.parts.map((p) => (
              <li>
                <span class="num">+{p.points}</span> {p.label}
              </li>
            ))}
          </ul>
        </details>
      </td>
      <td class="num">{score.total}</td>
      <td class="c-links">
        {e.source_url && <a href={e.source_url}>↗</a>}
        {e.source_url && <a href={newIssueUrl(e.source_url)}>+issue</a>}
      </td>
    </tr>
  );
}
