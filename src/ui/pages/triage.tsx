import { labelForMetric } from "../../config";
import type { EntityView } from "../../core/queries";
import { activityAt, type Score } from "../../core/score";
import { Chip, Dot, ExtLink, newIssueUrl, safeHref } from "../components";

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

function sortHref(f: TriageFilters, sort: string): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.kind) params.set("kind", f.kind);
  if (f.category) params.set("category", f.category);
  if (f.owner) params.set("owner", f.owner);
  if (f.minSeverity) params.set("min_severity", String(f.minSeverity));
  params.set("sort", sort);
  return `/triage?${params.toString()}`;
}

// The daily driver: the map flattened and sorted by pain (ux §2.2).
export function TriagePage(props: {
  rows: TriageRow[];
  filters: TriageFilters;
  owners: string[];
  stale?: ReadonlySet<string>;
  now: number;
}) {
  return (
    <>
      <form class="filters" hx-get="/triage" hx-target="#triage-table" hx-select="#triage-table" hx-swap="outerHTML" hx-push-url="true">
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
        <th scope="col" />
        <th scope="col">
          <a class={`sort ${sort === "name" ? "active" : ""}`} href={sortHref(props.filters, "name")}>
            entity
          </a>
        </th>
        <th scope="col">kind</th>
        <th scope="col">top signal</th>
        <th scope="col">why</th>
        {/* no hardcoded numbers: the weights live in /settings, so a tooltip
            quoting the defaults becomes a lie the moment they're edited —
            per-row breakdowns (expand the "why") carry the real arithmetic */}
        <th scope="col" class="num" title="triage score: severity + breadth + staleness + zero-usage — weights in /settings, breakdown under each row's why">
          <a class={`sort ${sort === "score" ? "active" : ""}`} href={sortHref(props.filters, "score")}>
            score
          </a>
        </th>
        <th scope="col" class="num">
          <a class={`sort ${sort === "issues" ? "active" : ""}`} href={sortHref(props.filters, "issues")}>
            issues
          </a>
        </th>
        <th scope="col" class="num">
          <a class={`sort ${sort === "vulns" ? "active" : ""}`} href={sortHref(props.filters, "vulns")}>
            vulns
          </a>
        </th>
        <th scope="col" class="num">
          <a class={`sort ${sort === "stale" ? "active" : ""}`} href={sortHref(props.filters, "stale")}>
            stale
          </a>
        </th>
        <th scope="col" />
      </tr>
      {props.rows.map((r) => (
        <Row row={r} now={props.now} stale={props.stale} />
      ))}
    </table>
  );
}

function Row(props: { row: TriageRow; now: number; stale?: ReadonlySet<string> }) {
  const { view: e, score } = props.row;
  const worst = Object.values(e.latest)
    .filter((s) => s.severity > 0)
    .sort((a, b) => b.severity - a.severity)[0];
  const staleDays = Math.floor((props.now - activityAt(e)) / 86_400);
  return (
    <tr class="row" data-href={`/e/${e.id}`}>
      <td class="c-dot">
        <Dot severity={e.maxSeverity} />
      </td>
      <td class="c-name">
        <a href={`/e/${e.id}`}>{e.name}</a>
      </td>
      <td class="c-kind">
        {e.category ?? e.kind}
        {e.owner && <span class="owner"> · {e.owner}</span>}
      </td>
      <td class="c-chips">
        {worst ? <Chip label={labelForMetric(worst.metric)} signal={worst} now={props.now} staleSources={props.stale} /> : <span class="hint">—</span>}
      </td>
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
      <td class="num c-kind">
        {e.latest["issues.open"]?.value_num != null && (
          <a href={safeHref(e.latest["issues.open"]?.url) ?? `/e/${e.id}`}>{e.latest["issues.open"]?.value_num}</a>
        )}
      </td>
      <td class="num c-kind">
        {e.latest["deps.vuln_count"]?.value_num != null && (
          <a href={safeHref(e.latest["deps.vuln_count"]?.url) ?? `/e/${e.id}`}>{e.latest["deps.vuln_count"]?.value_num}</a>
        )}
      </td>
      <td class="num c-kind">{staleDays > 0 ? `${staleDays}d` : ""}</td>
      <td class="c-links">
        <ExtLink url={e.source_url} />
        {e.kind === "repo" && e.source_url && <ExtLink url={newIssueUrl(e.source_url)}>+issue</ExtLink>}
      </td>
    </tr>
  );
}
