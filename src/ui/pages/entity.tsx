import { DOMAIN_LABELS, labelForMetric } from "../../config";
import { buildAgentPrompt } from "../../core/agent-prompt";
import type { EntityRow, SignalRow } from "../../core/queries";
import { Dot, ExtLink, formatSignalValue, safeHref, timeAgo } from "../components";
import { Sparkline } from "./spend";

// Exported: index.tsx passes the same number to signalHistory — a drifted copy
// would break load-more (dead button or silent truncation).
export const HISTORY_PAGE = 50;

// Hover detail for relative timestamps — "9m ago" alone doesn't say when.
function isoMinute(epoch: number): string {
  return `${new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

// Minimal min-max normalized polyline — the archive turned into a glance.
export function TrendSpark(props: {
  points: { observed_at: number; value: number }[];
  days?: number; // window the points cover — the tooltip said "30d" regardless
  fmt?: (v: number) => string;
}) {
  const { points } = props;
  const days = props.days ?? 30;
  const fmt = props.fmt ?? String;
  const w = 96;
  const h = 14;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - 1 - ((p.value - min) / span) * (h - 2)).toFixed(1)}`)
    .join(" ");
  // A normalized line hides its scale by design; the tooltip restores it — in
  // the metric's own units, since "min 310000" explains nothing about a _ms metric.
  const range =
    min === max ? `steady at ${fmt(min)}` : `min ${fmt(min)} · max ${fmt(max)} · latest ${fmt(values[values.length - 1] ?? min)}`;
  return (
    <svg class="trend" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${days}d trend: ${range}`}>
      <title>{days}d · {range}</title>
      <path d={path} fill="none" stroke-width="1" />
    </svg>
  );
}

export function EntityPage(props: {
  entity: EntityRow;
  latest: SignalRow[];
  history: SignalRow[];
  intervalSeries: { metric: string; points: { period_start: number; total: number }[] }[];
  trends: Map<string, { observed_at: number; value: number }[]>;
  windowDays: number; // ?window=90 used to render 90 days of data labeled "30d"
  now: number;
}) {
  const { entity: e, now, windowDays } = props;
  // Interval metrics (period-windowed) render as series; state metrics as latest-value rows.
  const stateSignals = props.latest.filter((s) => s.period_start == null);
  const domains = groupBy(stateSignals, (s) => s.metric.split(".")[0] ?? "other");
  const homepage = (() => {
    try {
      return safeHref((JSON.parse(e.metadata ?? "{}") as { homepage?: string }).homepage);
    } catch {
      return undefined;
    }
  })();
  const sourceHref = safeHref(e.source_url);

  return (
    <>
      <header class="entity-head">
        <h1>
          {e.name} {e.archived ? <span class="warn-text">archived</span> : null}
        </h1>
        <p class="hint">
          <span class="chip">{e.kind}</span>
          {e.category && <span class="chip">{e.category}</span>}
          {e.owner && <span>{e.owner} · </span>}
          {e.source_url && (sourceHref ? <a href={sourceHref}>{e.source_url}</a> : <span>{e.source_url}</span>)}
          {homepage && (
            <>
              {" "}
              · <a href={homepage}>live site ↗</a>
            </>
          )}{" "}
          · first seen {timeAgo(e.first_seen_at, now)} ago · last seen {timeAgo(e.last_seen_at, now)} ago
        </p>
        <form method="post" action="/archive">
          <input type="hidden" name="entity_id" value={e.id} />
          <input type="hidden" name="archived" value={e.archived ? "0" : "1"} />
          <button type="submit">{e.archived ? "Unarchive in Ops" : "Archive in Ops"}</button>
        </form>
        {/* Ops never writes to GitHub (ADR-001) — retiring the repo itself is a separate act */}
        {!e.archived && e.kind === "repo" && sourceHref && (
          <p class="hint">
            Hides it from this dashboard only — to retire the repo itself,{" "}
            <a href={`${sourceHref}/settings`}>archive it on GitHub ↗</a> and Ops follows on the next poll.
          </p>
        )}
      </header>

      <AgentPrompt entity={e} latest={props.latest} now={now} />

      {/* One table for every domain, not a table per domain: with per-section
          tables the browser sizes columns from each section's content, so the
          value column landed at a different x in every group and nothing lined
          up. A single fixed-layout table makes misalignment impossible, and one
          header row labels the columns for all groups. Domain rows carry no
          .row class, so the existing mobile collapse hides them for free. */}
      {domains.size > 0 && (
        <section class="section">
          <table class="rows metrics">
            <colgroup>
              <col class="w-dot" />
              <col />
              <col class="w-val" />
              <col class="w-trend" />
              <col class="w-obs" />
              <col class="w-links" />
            </colgroup>
            <tr>
              <th />
              <th>metric</th>
              <th class="num">value</th>
              <th>{windowDays}d trend</th>
              <th>observed</th>
              <th />
            </tr>
            {[...domains.entries()].map(([domain, signals]) => (
              <>
                <tr class="domain">
                  <th colspan={6}>{DOMAIN_LABELS[domain] ?? domain}</th>
                </tr>
                {signals.map((s) => (
                  <tr class="row">
                    <td class="c-dot">
                      <Dot severity={s.severity} />
                    </td>
                    <td class="c-name" title={s.metric}>
                      {labelForMetric(s.metric)}
                    </td>
                    {/* value_text as title whenever present: it is both the raw
                        detail behind a formatted number and the recovery for a
                        text value the fixed column truncates */}
                    <td class="num" title={s.value_text ?? undefined}>
                      {formatSignalValue(s, now)}
                    </td>
                    <td class="c-trend">
                      {props.trends.has(s.metric) && (
                        <TrendSpark
                          points={props.trends.get(s.metric) ?? []}
                          days={windowDays}
                          fmt={(v) => formatSignalValue({ ...s, value_num: v, value_text: null }, now)}
                        />
                      )}
                    </td>
                    <td class="c-kind" title={isoMinute(s.observed_at)}>
                      {timeAgo(s.observed_at, now)} ago
                    </td>
                    <td class="c-links"><ExtLink url={s.url} /></td>
                  </tr>
                ))}
              </>
            ))}
          </table>
        </section>
      )}

      {domains.size === 0 && props.intervalSeries.length === 0 && (
        <section class="section">
          {/* spec §0.5: empty states teach — a fresh entity page was a header
              floating over an empty audit trail with no explanation */}
          <p class="hint">
            No signals yet — the next poll fills this in, or push metrics via <code>POST /ingest</code> (see the
            README). Check <a href="/health">/health</a> if nothing arrives.
          </p>
        </section>
      )}

      {props.intervalSeries.map((series) => (
        <section class="section">
          {/* labelForMetric like every other view — this heading rendered raw
              codes like "usage.tokens_in"; sparkline per spec §2.5 */}
          <h2>{labelForMetric(series.metric)}</h2>
          <Sparkline points={series.points} days={windowDays} now={now} label={labelForMetric(series.metric)} />
          <table class="rows">
            {series.points.map((p) => (
              <tr class="row">
                <td class="c-name num">{new Date(p.period_start * 1000).toISOString().slice(0, 10)}</td>
                <td class="num">{p.total}</td>
              </tr>
            ))}
          </table>
        </section>
      ))}

      <section class="section">
        <h2>History</h2>
        {props.history.length === 0 ? (
          <p class="hint">Nothing recorded yet — every signal lands here as it arrives. This is the audit trail.</p>
        ) : (
          <HistoryRows entityId={e.id} history={props.history} offset={0} now={now} />
        )}
      </section>
    </>
  );
}

// Findings → a hand-off prompt for Claude Code (or any agent). Ops supplies
// evidence and poller-verified done-criteria; the agent gathers the rest.
function AgentPrompt(props: { entity: EntityRow; latest: SignalRow[]; now: number }) {
  const prompt = buildAgentPrompt(props.entity, props.latest, props.now);
  if (!prompt) return null;
  return (
    <details class="section agent-prompt" id="agent">
      <summary>
        Agent prompt <span class="rollup">hand these findings to Claude Code</span>
      </summary>
      <textarea readonly rows={Math.min(24, prompt.split("\n").length + 1)}>
        {prompt}
      </textarea>
      {/* aria-live: the button's own label is the copy/fallback feedback */}
      <button type="button" data-copy aria-live="polite">
        copy prompt
      </button>
    </details>
  );
}

// The audit trail (ux §2.5) — reverse-chron, HTMX load-more.
export function HistoryRows(props: { entityId: string; history: SignalRow[]; offset: number; now: number }) {
  const nextOffset = props.offset + HISTORY_PAGE;
  const hasMore = props.history.length === HISTORY_PAGE;
  return (
    <>
      <table class="rows">
        {props.history.map((s) => (
          <tr class="row">
            <td class="c-dot">
              <Dot severity={s.severity} />
            </td>
            <td class="c-kind">{new Date(s.observed_at * 1000).toISOString().replace("T", " ").slice(0, 16)}</td>
            <td class="c-name" title={s.metric}>
              {labelForMetric(s.metric)}
            </td>
            <td class="num">{formatSignalValue(s, props.now)}</td>
            <td class="c-kind">{s.source}</td>
            <td class="c-links"><ExtLink url={s.url} /></td>
          </tr>
        ))}
      </table>
      {hasMore && (
        <button
          hx-get={`/e/${encodeURIComponent(props.entityId)}?offset=${nextOffset}`}
          hx-target="this"
          hx-swap="outerHTML"
        >
          load more
        </button>
      )}
    </>
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
