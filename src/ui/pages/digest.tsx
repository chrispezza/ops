import { labelForMetric, SEVERITY_NAMES } from "../../config";
import { type Digest, type DigestDay, DIGEST_MAX_DAYS } from "../../core/digest";
import type { SignalRow } from "../../core/queries";
import { Dot, ExtLink, formatSignalValue, timeAgo } from "../components";

const WINDOWS = [1, 7, 14, 30] as const;
const sevWord = (n: number) => SEVERITY_NAMES[n] ?? String(n);

// The time lens (ux §0.1: the window is the URL). Sections in reading order
// for a Friday: what got worse, what got better, what appeared, where the
// backlog stands, what it cost.
export function DigestPage(props: { digest: Digest; hasToken: boolean; now: number }) {
  const d = props.digest;
  return (
    <>
      <section class="section">
        <h2>
          Since {new Date(d.since * 1000).toISOString().slice(0, 10)}
          <span class="rollup">
            {WINDOWS.map((w) => (
              <a href={`/digest?since=${w}d`} class={d.days === w ? "active" : ""}>
                {" "}
                {w}d
              </a>
            ))}
          </span>
        </h2>
        <p class="hint">
          {d.raised.length} raised · {d.resolved.length} resolved · {d.newEntities.length} new · spend ${d.spend.current.toFixed(2)} vs $
          {d.spend.prior.toFixed(2)} prior. Windows run to {DIGEST_MAX_DAYS}d, the retention horizon.
        </p>
        <Timeline days={d.timeline} />
      </section>

      <section class="section">
        <h2>
          Raised <span class="rollup num">{d.raised.length}</span>
        </h2>
        {d.raised.length === 0 ? (
          <p class="hint">No finding reached or escalated past severity 2 in this window.</p>
        ) : (
          <table role="table" class="rows">
            <tr role="row">
              <th role="columnheader" scope="col" />
              <th role="columnheader" scope="col">entity</th>
              <th role="columnheader" scope="col">finding</th>
              <th role="columnheader" scope="col">value</th>
              <th role="columnheader" scope="col">change</th>
              <th role="columnheader" scope="col">observed</th>
              <th role="columnheader" scope="col" />
            </tr>
            {d.raised.map((r) => (
              <ChangeRow row={r} change={r.from == null ? "new" : `${sevWord(r.from)} → ${sevWord(r.severity)}`} now={props.now} />
            ))}
          </table>
        )}
      </section>

      <section class="section">
        <h2>
          Resolved <span class="rollup num">{d.resolved.length}</span>
        </h2>
        {d.resolved.length === 0 ? (
          <p class="hint">
            Nothing dropped below severity 2 in this window. Hygiene flags resolve in place and are not tracked here.
          </p>
        ) : (
          <table role="table" class="rows">
            <tr role="row">
              <th role="columnheader" scope="col" />
              <th role="columnheader" scope="col">entity</th>
              <th role="columnheader" scope="col">finding</th>
              <th role="columnheader" scope="col">now</th>
              <th role="columnheader" scope="col">change</th>
              <th role="columnheader" scope="col">observed</th>
              <th role="columnheader" scope="col" />
            </tr>
            {d.resolved.map((r) => (
              <ChangeRow row={r} change={`peaked ${sevWord(r.peak)}`} now={props.now} />
            ))}
          </table>
        )}
      </section>

      <section class="section">
        <h2>
          New entities <span class="rollup num">{d.newEntities.length}</span>
        </h2>
        {d.newEntities.length === 0 ? (
          <p class="hint">No entity was first seen in this window.</p>
        ) : (
          <table role="table" class="rows">
            {d.newEntities.map((e) => (
              <tr role="row" class="row" data-href={`/e/${e.id}`}>
                <td role="cell" class="c-name">
                  <a href={`/e/${e.id}`}>{e.name}</a>
                </td>
                <td role="cell" class="c-kind">
                  {e.category ?? e.kind}
                  {e.owner && <span class="owner"> · {e.owner}</span>}
                </td>
              </tr>
            ))}
          </table>
        )}
      </section>

      <section class="section">
        <h2>Portfolio now</h2>
        {d.backlog.length === 0 ? (
          <p class="hint">No backlog signals yet — they arrive with the first GitHub poll.</p>
        ) : (
          <table role="table" class="rows">
            <tr role="row">
              <th role="columnheader" scope="col">metric</th>
              <th role="columnheader" scope="col" class="num">total</th>
              <th role="columnheader" scope="col" class="num">entities</th>
            </tr>
            {d.backlog.map((b) => (
              <tr role="row" class="row">
                <td role="cell" title={b.metric}>
                  <a href={`/findings?domain=${encodeURIComponent(b.metric)}&min_severity=0`}>{labelForMetric(b.metric)}</a>
                </td>
                <td role="cell" class="num">{b.total}</td>
                <td role="cell" class="num">{b.entities}</td>
              </tr>
            ))}
          </table>
        )}
        <p class="hint">Current state, not a delta — the same rows as /findings, summed.</p>
      </section>

      <section class="section">
        <h2>Machine-readable</h2>
        <p class="hint">
          <code>GET /digest/md?since={d.days}d</code> with <code>Authorization: Bearer $DIGEST_TOKEN</code> returns this
          digest as markdown for an agent to narrate.{" "}
          {props.hasToken ? "Token configured." : "DIGEST_TOKEN is not set — the endpoint returns 503 until it is."}
        </p>
      </section>
    </>
  );
}

function ChangeRow(props: { row: SignalRow & { entity_name: string }; change: string; now: number }) {
  const r = props.row;
  return (
    <tr role="row" class="row" data-href={`/e/${r.entity_id}`}>
      <td role="cell" class="c-dot">
        <Dot severity={r.severity} />
      </td>
      <td role="cell" class="c-name">
        <a href={`/e/${r.entity_id}`}>{r.entity_name}</a>
      </td>
      <td role="cell" class="c-kind" title={r.metric}>
        {labelForMetric(r.metric)}
      </td>
      <td role="cell">{formatSignalValue(r, props.now)}</td>
      <td role="cell" class="c-kind">{props.change}</td>
      <td role="cell" class="c-kind">{timeAgo(r.observed_at, props.now)} ago</td>
      <td role="cell">
        <ExtLink url={r.url} />
      </td>
    </tr>
  );
}

// The window as a strip: one column per UTC day, raised findings up in the
// warning hue, resolved down in ink. Server-rendered SVG (ux §2.3); the
// numbers ride in each column's title and the label, so the picture is never
// the only copy. Onset is the first observation past the baseline; the
// resolved day is the last observation at severity 2+ (hourly polls put the
// true moment within an hour of it).
function Timeline(props: { days: DigestDay[] }) {
  const { days } = props;
  if (days.length === 0) return null;
  const max = Math.max(1, ...days.map((t) => Math.max(t.raised, t.resolved)));
  const colW = 14;
  const gap = 2;
  const half = 22;
  const w = days.length * (colW + gap);
  const h = half * 2 + 1;
  const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  const totals = days.reduce((acc, t) => ({ raised: acc.raised + t.raised, resolved: acc.resolved + t.resolved }), { raised: 0, resolved: 0 });
  return (
    <figure class="timeline">
      <svg
        class="timeline-strip"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={`${days.length}-day timeline: ${totals.raised} raised, ${totals.resolved} resolved; peak day ${max}`}
      >
        <line class="timeline-axis" x1="0" y1={half + 0.5} x2={w} y2={half + 0.5} />
        {days.map((t, i) => {
          const x = i * (colW + gap);
          const up = Math.round((t.raised / max) * (half - 2));
          const down = Math.round((t.resolved / max) * (half - 2));
          return (
            <g>
              <title>
                {iso(t.day)}: {t.raised} raised · {t.resolved} resolved
              </title>
              {t.raised > 0 && <rect class="timeline-raised" x={x} y={half - up} width={colW} height={up} />}
              {t.resolved > 0 && <rect class="timeline-resolved" x={x} y={half + 1} width={colW} height={down} />}
            </g>
          );
        })}
      </svg>
      <figcaption class="hint">
        {iso(days[0]?.day ?? 0)} → {iso(days[days.length - 1]?.day ?? 0)} · ▲ raised (first seen past baseline) · ▼ resolved (last seen at
        severity 2+) · peak {max}/day
      </figcaption>
    </figure>
  );
}
