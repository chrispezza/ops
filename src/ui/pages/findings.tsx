import type { FindingRow } from "../../core/queries";
import { Dot, formatSignalValue, timeAgo } from "../components";

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

export function FindingsPage(props: { rows: FindingRow[]; filters: FindingsFilters; now: number }) {
  const f = props.filters;
  return (
    <>
      <form class="filters" hx-get="/findings" hx-target="#findings-region" hx-select="#findings-region" hx-swap="outerHTML" hx-push-url="true">
        <input type="search" name="domain" placeholder="domain prefix (e.g. seo)… ( / )" value={f.domain ?? ""} />
        <select name="min_severity">
          {[0, 1, 2, 3, 4].map((s) => (
            <option value={String(s)} selected={f.minSeverity === s}>
              sev ≥ {s}
            </option>
          ))}
        </select>
        <select name="category">
          <option value="">all categories</option>
          {["static_site", "web_app", "plugin_skill", "tooling", "vendor_api"].map((c) => (
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
        {props.rows.length === 0 ? (
          <p class="hint">No findings match. Lower min severity or clear the domain filter.</p>
        ) : f.group === "entity" ? (
          <Grouped rows={props.rows} now={props.now} />
        ) : (
          <FindingsTable rows={props.rows} filters={f} now={props.now} />
        )}
      </div>
    </>
  );
}

function FindingsTable(props: { rows: FindingRow[]; filters?: FindingsFilters; now: number }) {
  const sort = props.filters?.sort ?? "severity";
  return (
    <table class="rows">
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
      {props.rows.map((r) => (
        <tr class="row" data-href={`/e/${r.entity_id}`}>
          <td class="c-dot">
            <Dot severity={r.severity} />
          </td>
          <td class="c-name">
            <a href={`/e/${r.entity_id}`}>{r.entity_name}</a>
            {r.entity_archived ? <span class="c-kind"> (archived)</span> : null}
          </td>
          <td class="c-kind">{r.metric}</td>
          {/* value_text carries the explanation when a number is shown — keep it reachable */}
          <td class="num" title={r.value_num != null && r.value_text ? r.value_text : undefined}>
            {formatSignalValue(r, props.now)}
          </td>
          <td class="c-kind">{timeAgo(r.observed_at, props.now)} ago</td>
          <td class="c-links">{r.url && <a href={r.url}>↗</a>}</td>
        </tr>
      ))}
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
