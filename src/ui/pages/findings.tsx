import { labelForMetric } from "../../config";
import type { FindingRow } from "../../core/queries";
import { Dot, ExtLink, formatSignalValue, timeAgo } from "../components";

export interface FindingsFilters {
  minSeverity: number;
  domain?: string;
  category?: string;
  group?: string;
  sort?: string;
}

function sortHref(f: FindingsFilters, sort: string): string {
  const params = new URLSearchParams();
  if (f.domain) params.set("domain", f.domain);
  if (f.category) params.set("category", f.category);
  params.set("min_severity", String(f.minSeverity));
  if (f.group) params.set("group", f.group);
  params.set("sort", sort);
  return `/findings?${params.toString()}`;
}

// Severity bands turn the flat gradient into urgency classes: what breaks
// things now, what needs planning, what's routine upkeep.
const BANDS = [
  { title: "Act now", match: (r: FindingRow) => r.severity >= 3 },
  { title: "Plan", match: (r: FindingRow) => r.severity === 2 },
  { title: "Routine", match: (r: FindingRow) => r.severity <= 1 },
] as const;

export function FindingsPage(props: { rows: FindingRow[]; filters: FindingsFilters; now: number }) {
  const f = props.filters;
  const live = props.rows.filter((r) => !r.entity_archived);
  const archived = props.rows.filter((r) => r.entity_archived);
  return (
    <>
      <form class="filters" hx-get="/findings" hx-target="#findings-region" hx-select="#findings-region" hx-swap="outerHTML" hx-push-url="true">
        {/* "e.g. ci", not "e.g. seo" — no seo.* metric exists in this deployment,
            so the old example returned zero rows when typed */}
        <input type="search" name="domain" placeholder="domain prefix (e.g. ci)… ( / )" value={f.domain ?? ""} aria-label="metric domain prefix" />
        {f.sort && <input type="hidden" name="sort" value={f.sort} />}
        <select name="min_severity" aria-label="minimum severity">
          {[0, 1, 2, 3, 4].map((s) => (
            <option value={String(s)} selected={f.minSeverity === s}>
              sev ≥ {s}
            </option>
          ))}
        </select>
        <select name="category" aria-label="category">
          <option value="">all categories</option>
          {["static_site", "web_app", "plugin_skill", "tooling", "client_project", "vendor_api"].map((c) => (
            <option value={c} selected={f.category === c}>
              {c}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" name="group" value="entity" checked={f.group === "entity"} /> group by entity
        </label>
        <button type="submit">apply</button>
      </form>
      <div id="findings-region">
        {live.length === 0 ? (
          <p class="hint">No findings match. Lower min severity, or clear the domain or category filter.</p>
        ) : f.group === "entity" ? (
          <Grouped rows={live} now={props.now} />
        ) : (
          BANDS.map((band) => {
            const rows = live.filter(band.match);
            if (rows.length === 0) return null;
            return (
              <section class="section">
                <h2>
                  {band.title} <span class="rollup num">{rows.length}</span>
                </h2>
                <FindingsTable rows={clusterByEntity(rows)} filters={f} now={props.now} />
              </section>
            );
          })
        )}
        {/* archived findings are history, not work — same drawer pattern as the map */}
        {archived.length > 0 && (
          <details class="archived-section">
            <summary>
              Archived findings <span class="rollup num">{archived.length}</span>
            </summary>
            <FindingsTable rows={archived} now={props.now} />
          </details>
        )}
      </div>
    </>
  );
}

// One finding per row (each keeps its own value, timestamp, deep link), but an
// entity's findings cluster together with the name rendered once — dedup
// without information loss, no interaction required.
function clusterByEntity(rows: FindingRow[]): FindingRow[] {
  const clusters = new Map<string, FindingRow[]>();
  for (const row of rows) {
    const list = clusters.get(row.entity_id);
    if (list) list.push(row);
    else clusters.set(row.entity_id, [row]);
  }
  return [...clusters.values()].flat();
}

function FindingsTable(props: { rows: FindingRow[]; filters?: FindingsFilters; now: number }) {
  const sort = props.filters?.sort ?? "severity";
  let previousEntity = "";
  return (
    // fixed shared geometry: each band/group renders its own table, and auto
    // layout put the value column at a different x per band — same disease the
    // entity page had, same cure
    <table class="rows findings-cols">
      <colgroup>
        <col class="w-dot" />
        <col />
        <col class="w-metric" />
        <col class="w-val" />
        <col class="w-obs" />
        <col class="w-links" />
      </colgroup>
      <tr>
        <th>
          {props.filters ? (
            <a class={`sort ${sort === "severity" ? "active" : ""}`} href={sortHref(props.filters, "severity")}>
              sev
            </a>
          ) : (
            ""
          )}
        </th>
        <th>entity</th>
        <th>metric</th>
        <th>value</th>
        <th>
          {props.filters ? (
            <a class={`sort ${sort === "recent" ? "active" : ""}`} href={sortHref(props.filters, "recent")}>
              observed
            </a>
          ) : (
            "observed"
          )}
        </th>
        <th />
      </tr>
      {props.rows.map((r) => {
        const firstOfCluster = r.entity_id !== previousEntity;
        previousEntity = r.entity_id;
        return (
        <tr class={firstOfCluster ? "row" : "row cluster-cont"} data-href={`/e/${r.entity_id}`}>
          <td class="c-dot">
            <Dot severity={r.severity} />
          </td>
          <td class="c-name">
            {firstOfCluster && (
              <>
                <a href={`/e/${r.entity_id}`}>{r.entity_name}</a>
                {r.entity_archived ? <span class="c-kind"> (archived)</span> : null}
              </>
            )}
          </td>
          <td class="c-kind" title={r.metric}>
            {labelForMetric(r.metric)}
          </td>
          {/* value_text carries the explanation when a number is shown — keep it reachable */}
          <td class="num" title={r.value_num != null && r.value_text ? r.value_text : undefined}>
            {formatSignalValue(r, props.now)}
          </td>
          <td class="c-kind">{timeAgo(r.observed_at, props.now)} ago</td>
          <td class="c-links">
            <ExtLink url={r.url} />
          </td>
        </tr>
        );
      })}
    </table>
  );
}

function Grouped(props: { rows: FindingRow[]; now: number }) {
  const byEntity = new Map<string, FindingRow[]>();
  for (const r of props.rows) {
    const list = byEntity.get(r.entity_id);
    if (list) list.push(r);
    else byEntity.set(r.entity_id, [r]);
  }
  return (
    <>
      {[...byEntity.entries()].map(([id, rows]) => (
        <section class="section">
          <h2>
            <a href={`/e/${id}`}>{rows[0]?.entity_name ?? id}</a>
          </h2>
          <FindingsTable rows={rows} now={props.now} />
        </section>
      ))}
    </>
  );
}
