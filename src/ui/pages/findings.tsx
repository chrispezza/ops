import { labelForMetric, SEVERITY_NAMES } from "../../config";
import { domainLabel, type Heatmap } from "../../core/heatmap";
import type { FindingRow } from "../../core/queries";
import { Dot, ExtLink, formatSignalValue, SortTh, timeAgo } from "../components";

export interface FindingsFilters {
  minSeverity: number;
  domain?: string;
  category?: string;
  group?: string;
  sort?: string;
  view?: string; // "heat" = the entity × domain grid; anything else = the list
}

function findingsHref(f: FindingsFilters, over: Partial<FindingsFilters>): string {
  const m = { ...f, ...over };
  const params = new URLSearchParams();
  if (m.domain) params.set("domain", m.domain);
  if (m.category) params.set("category", m.category);
  params.set("min_severity", String(m.minSeverity));
  if (m.group) params.set("group", m.group);
  if (m.sort) params.set("sort", m.sort);
  if (m.view) params.set("view", m.view);
  return `/findings?${params.toString()}`;
}

const sortHref = (f: FindingsFilters, sort: string): string => findingsHref(f, { sort });

// Severity bands turn the flat gradient into urgency classes: what breaks
// things now, what needs planning, what's routine upkeep.
const BANDS = [
  { title: "Act now", match: (r: FindingRow) => r.severity >= 3 },
  { title: "Plan", match: (r: FindingRow) => r.severity === 2 },
  { title: "Routine", match: (r: FindingRow) => r.severity <= 1 },
] as const;

export function FindingsPage(props: {
  rows: FindingRow[];
  filters: FindingsFilters;
  heatmap?: Heatmap; // present when the grid view was asked for
  stale?: ReadonlySet<string>;
  now: number;
}) {
  const f = props.filters;
  const heat = f.view === "heat";
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
        {heat && <input type="hidden" name="view" value="heat" />}
        <button type="submit">apply</button>
        {/* the view switch is a link pair, not a control: URL is the state (ux §0.1) */}
        <span class="view-toggle" role="group" aria-label="view">
          <a href={findingsHref(f, { view: undefined })} class={heat ? "" : "active"} aria-current={heat ? undefined : "page"}>
            list
          </a>
          <a href={findingsHref(f, { view: "heat" })} class={heat ? "active" : ""} aria-current={heat ? "page" : undefined}>
            grid
          </a>
        </span>
      </form>
      <div id="findings-region">
        {heat && props.heatmap ? (
          <HeatGrid heatmap={props.heatmap} minSeverity={f.minSeverity} now={props.now} />
        ) : live.length === 0 ? (
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
                <FindingsTable rows={clusterByEntity(rows)} filters={f} stale={props.stale} now={props.now} />
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

function FindingsTable(props: {
  rows: FindingRow[];
  filters?: FindingsFilters;
  stale?: ReadonlySet<string>;
  now: number;
}) {
  const sort = props.filters?.sort ?? "severity";
  let previousEntity = "";
  return (
    // fixed shared geometry: each band/group renders its own table, and auto
    // layout put the value column at a different x per band — same disease the
    // entity page had, same cure
    <table role="table" class="rows findings-cols">
      <colgroup>
        <col class="w-dot" />
        <col />
        <col class="w-metric" />
        <col class="w-val" />
        <col class="w-obs" />
        <col class="w-links" />
      </colgroup>
      <tr role="row">
        {props.filters ? (
          <SortTh label="sev" href={sortHref(props.filters, "severity")} active={sort === "severity"} dir="descending" />
        ) : (
          <th role="columnheader" scope="col" />
        )}
        <th role="columnheader" scope="col">entity</th>
        <th role="columnheader" scope="col">metric</th>
        <th role="columnheader" scope="col">value</th>
        {props.filters ? (
          // newest first
          <SortTh label="observed" href={sortHref(props.filters, "recent")} active={sort === "recent"} dir="descending" />
        ) : (
          <th role="columnheader" scope="col">observed</th>
        )}
        <th role="columnheader" scope="col" />
      </tr>
      {props.rows.map((r) => {
        const firstOfCluster = r.entity_id !== previousEntity;
        previousEntity = r.entity_id;
        return (
        <tr role="row" class={firstOfCluster ? "row" : "row cluster-cont"} data-href={`/e/${r.entity_id}`}>
          <td role="cell" class="c-dot">
            <Dot severity={r.severity} />
          </td>
          <td role="cell" class="c-name">
            {firstOfCluster && (
              <>
                <a href={`/e/${r.entity_id}`}>{r.entity_name}</a>
                {r.entity_archived ? <span class="c-kind"> (archived)</span> : null}
              </>
            )}
          </td>
          {/* title = the display label first (truncation recovery must show the
              text that was cut, not a raw id), then the metric code — the
              query contract for ?domain= */}
          <td role="cell" class="c-kind" title={`${labelForMetric(r.metric)} · ${r.metric}`}>
            {labelForMetric(r.metric)}
          </td>
          {/* value_text carries the explanation when a number is shown — keep it
              reachable; stale = the source poller is failing (spec §3: dimmed,
              never hidden) */}
          <td
            role="cell"
            class={props.stale?.has(r.source) ? "num stale-data" : "num"}
            title={`${r.value_num != null && r.value_text ? r.value_text : ""}${props.stale?.has(r.source) ? " · source failing — value may be stale" : ""}`.trim() || undefined}
          >
            {formatSignalValue(r, props.now)}
          </td>
          <td role="cell" class="c-kind">{timeAgo(r.observed_at, props.now)} ago</td>
          <td role="cell" class="c-links">
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

// Entities down, domains across, worst severity per cell. Cells at or above
// the severity floor are colored; below it they render as quiet ok marks so
// the shape of the portfolio stays visible while the floor picks out the
// problems. Not a .rows table: the mobile collapse would destroy a grid, so
// it scrolls sideways instead.
function HeatGrid(props: { heatmap: Heatmap; minSeverity: number; now: number }) {
  const { heatmap } = props;
  if (heatmap.rows.length === 0) {
    return <p class="hint">No signals to grid. Clear the domain or category filter, or wait for the first poll.</p>;
  }
  const sevWord = (n: number) => SEVERITY_NAMES[n] ?? String(n);
  return (
    <div class="heat-scroll">
      <table class="heat" role="table">
        <tr role="row">
          <th role="columnheader" scope="col">entity</th>
          {heatmap.domains.map((d) => (
            <th role="columnheader" scope="col" title={d}>
              <a href={`/findings?domain=${encodeURIComponent(d)}&min_severity=0`}>{domainLabel(d)}</a>
            </th>
          ))}
        </tr>
        {heatmap.rows.map((row) => (
          <tr role="row">
            <th role="rowheader" scope="row" class="heat-entity">
              <Dot severity={row.maxSeverity} /> <a href={`/e/${row.entityId}`}>{row.entityName}</a>
            </th>
            {row.cells.map((cell) => {
              if (cell.severity < 0) return <td role="cell" class="heat-cell none" aria-label={`${domainLabel(cell.domain)}: no signal`} />;
              const quiet = cell.severity < props.minSeverity;
              const title = cell.signals
                .map((s) => `${labelForMetric(s.metric)}: ${s.value_text ?? formatSignalValue(s, props.now)} (${sevWord(s.severity)})`)
                .join("\n");
              return (
                <td role="cell" class={quiet ? "heat-cell quiet" : "heat-cell"} data-sev={cell.severity}>
                  <a href={`/e/${row.entityId}`} title={title} aria-label={`${row.entityName} · ${domainLabel(cell.domain)}: ${sevWord(cell.severity)}`}>
                    {cell.severity > 0 ? cell.severity : "·"}
                  </a>
                </td>
              );
            })}
          </tr>
        ))}
      </table>
    </div>
  );
}
