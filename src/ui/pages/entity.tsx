import { DOMAIN_LABELS, labelForMetric } from "../../config";
import { buildAgentPrompt } from "../../core/agent-prompt";
import type { EntityRow, SignalRow } from "../../core/queries";
import { Dot, formatSignalValue, timeAgo } from "../components";

const HISTORY_PAGE = 50;

// Minimal min-max normalized polyline — the archive turned into a glance.
export function TrendSpark(props: { points: { observed_at: number; value: number }[] }) {
  const { points } = props;
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
  return (
    <svg class="trend" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="30d trend">
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
  now: number;
}) {
  const { entity: e, now } = props;
  // Interval metrics (period-windowed) render as series; state metrics as latest-value rows.
  const stateSignals = props.latest.filter((s) => s.period_start == null);
  const domains = groupBy(stateSignals, (s) => s.metric.split(".")[0] ?? "other");
  const homepage = (() => {
    try {
      return (JSON.parse(e.metadata ?? "{}") as { homepage?: string }).homepage;
    } catch {
      return undefined;
    }
  })();

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
          {e.source_url && (
            <a href={e.source_url}>{e.source_url}</a>
          )}
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
        {!e.archived && e.kind === "repo" && e.source_url && (
          <p class="hint">
            Hides it from this dashboard only — to retire the repo itself,{" "}
            <a href={`${e.source_url}/settings`}>archive it on GitHub ↗</a> and Ops follows on the next poll.
          </p>
        )}
      </header>

      <AgentPrompt entity={e} latest={props.latest} now={now} />

      {[...domains.entries()].map(([domain, signals]) => (
        <section class="section">
          <h2>{DOMAIN_LABELS[domain] ?? domain}</h2>
          <table class="rows">
            {signals.map((s) => (
              <tr class="row">
                <td class="c-dot">
                  <Dot severity={s.severity} />
                </td>
                <td class="c-name" title={s.metric}>
                  {labelForMetric(s.metric)}
                </td>
                <td class="num" title={s.value_num != null && s.value_text ? s.value_text : undefined}>
                  {formatSignalValue(s, now)}
                </td>
                <td class="c-trend">
                  {props.trends.has(s.metric) && <TrendSpark points={props.trends.get(s.metric) ?? []} />}
                </td>
                <td class="c-kind">{timeAgo(s.observed_at, now)} ago</td>
                <td class="c-links">{s.url && <a href={s.url}>↗</a>}</td>
              </tr>
            ))}
          </table>
        </section>
      ))}

      {props.intervalSeries.map((series) => (
        <section class="section">
          <h2>{series.metric}</h2>
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
        <HistoryRows entityId={e.id} history={props.history} offset={0} now={now} />
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
      <button
        type="button"
        onclick="navigator.clipboard.writeText(this.closest('details').querySelector('textarea').value);this.textContent='copied'"
      >
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
            <td class="c-links">{s.url && <a href={s.url}>↗</a>}</td>
          </tr>
        ))}
      </table>
      {hasMore && (
        <button
          hx-get={`/e/${props.entityId}?offset=${nextOffset}`}
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
