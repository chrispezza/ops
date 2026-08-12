import { DOMAIN_LABELS, labelForMetric } from "../../config";
import type { EntityRow, SignalRow } from "../../core/queries";
import { Dot, formatSignalValue, timeAgo } from "../components";

const HISTORY_PAGE = 50;

export function EntityPage(props: {
  entity: EntityRow;
  latest: SignalRow[];
  history: SignalRow[];
  intervalSeries: { metric: string; points: { period_start: number; total: number }[] }[];
  now: number;
}) {
  const { entity: e, now } = props;
  // Interval metrics (period-windowed) render as series; state metrics as latest-value rows.
  const stateSignals = props.latest.filter((s) => s.period_start == null);
  const domains = groupBy(stateSignals, (s) => s.metric.split(".")[0] ?? "other");

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
          )}{" "}
          · first seen {timeAgo(e.first_seen_at, now)} ago · last seen {timeAgo(e.last_seen_at, now)} ago
        </p>
        <form method="post" action="/archive">
          <input type="hidden" name="entity_id" value={e.id} />
          <input type="hidden" name="archived" value={e.archived ? "0" : "1"} />
          <button type="submit">{e.archived ? "Unarchive" : "Archive"}</button>
        </form>
      </header>

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
