import type { BudgetRow } from "../../core/derive";
import type { SignalRow } from "../../core/queries";

const DAY = 86_400;

export interface SpendEntity {
  id: string;
  name: string;
  points: { period_start: number; total: number }[];
  mtd: number;
  today: number;
  anomaly: SignalRow | undefined;
}

// Server-rendered inline SVG bars — no chart library (ux §2.3). Today's bar is
// hollow: the day is partial and the dedupe-key overwrite will settle it.
export function Sparkline(props: { points: { period_start: number; total: number }[]; days: number; now: number }) {
  const { days, now } = props;
  const today = now - (now % DAY);
  const start = today - (days - 1) * DAY;
  const byDay = new Map(props.points.map((p) => [p.period_start, p.total]));
  const values = Array.from({ length: days }, (_, i) => byDay.get(start + i * DAY) ?? 0);
  const max = Math.max(...values, 0.01);

  const barW = 4;
  const gap = 1;
  const h = 16;
  const w = days * (barW + gap);
  return (
    <svg class="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`daily spend, ${days} days`}>
      {values.map((v, i) => {
        const barH = Math.max(1, Math.round((v / max) * (h - 2)));
        const isToday = start + i * DAY === today;
        return (
          <rect
            x={i * (barW + gap)}
            y={h - barH}
            width={barW}
            height={barH}
            class={isToday ? "spark-bar today" : "spark-bar"}
          />
        );
      })}
    </svg>
  );
}

export function SpendPage(props: {
  entities: SpendEntity[];
  budgets: BudgetRow[];
  orgMtd: number;
  windowDays: number;
  now: number;
}) {
  const { budgets, orgMtd, now } = props;
  return (
    <>
      <section class="section">
        <h2>Month to date</h2>
        <p class="mtd num">${orgMtd.toFixed(2)}</p>
        {budgets.map((b) => (
          <BudgetBar budget={b} spent={spentForScope(b, props.entities, orgMtd)} />
        ))}
        {budgets.length === 0 && (
          <p class="hint">
            No budgets configured — add soft/hard limits in <a href="/settings">/settings</a>.
          </p>
        )}
      </section>

      <section class="section">
        <h2>
          By entity
          <span class="rollup">
            {[30, 90].map((d) => (
              <a href={`/spend?window=${d}`} class={props.windowDays === d ? "active" : ""}>
                {" "}
                {d}d
              </a>
            ))}
          </span>
        </h2>
        {props.entities.length === 0 ? (
          <p class="hint">
            No spend data — set <code>ANTHROPIC_ADMIN_KEY</code> and wait for the daily poll.
          </p>
        ) : (
          <table class="rows">
            {props.entities.map((e) => (
              <tr class="row">
                <td class="c-name">
                  <a href={`/e/${e.id}`}>{e.name}</a>
                </td>
                <td class="num">MTD ${e.mtd.toFixed(2)}</td>
                <td>
                  <Sparkline points={e.points} days={props.windowDays} now={now} />
                </td>
                <td class="num">today ${e.today.toFixed(2)}</td>
                <td>
                  {e.anomaly && e.anomaly.severity >= 2 && (
                    <span class="chip" data-sev="2" title={e.anomaly.value_text ?? ""}>
                      anomaly ⚠
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </table>
        )}
      </section>
    </>
  );
}

function spentForScope(b: BudgetRow, entities: SpendEntity[], orgMtd: number): number {
  if (b.scope === "*") return orgMtd;
  const entity = entities.find((e) => e.id === b.scope);
  return entity?.mtd ?? orgMtd;
}

// Horizontal bar with soft/hard limit ticks (ux §2.3).
function BudgetBar(props: { budget: BudgetRow; spent: number }) {
  const { budget: b, spent } = props;
  const scale = Math.max(b.hard_limit * 1.1, spent, 0.01);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const sev = spent >= b.hard_limit ? 4 : spent >= b.soft_limit ? 2 : 0;
  return (
    <div class="budget">
      <span class="budget-label">
        {b.scope} <span class="num">${spent.toFixed(2)}</span> / ${b.soft_limit} soft · ${b.hard_limit} hard ({b.period})
      </span>
      <div class="budget-bar">
        <div class="budget-fill" data-sev={sev} style={`width:${pct(spent)}`} />
        <div class="budget-tick soft" style={`left:${pct(b.soft_limit)}`} />
        <div class="budget-tick hard" style={`left:${pct(b.hard_limit)}`} />
      </div>
    </div>
  );
}
