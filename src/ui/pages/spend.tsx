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
  balance: SignalRow | undefined;
}

// Server-rendered inline SVG bars — no chart library (ux §2.3). Today's bar is
// hollow: the day is partial and the dedupe-key overwrite will settle it.
export function Sparkline(props: {
  points: { period_start: number; total: number }[];
  days: number;
  now: number;
  label?: string; // aria naming — defaults to spend, callers with other units say so
}) {
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
    <svg class="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${props.label ?? "daily spend"}, ${days} days`}>
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
  allEntities: SpendEntity[]; // unfiltered — budget-bar labels must resolve even under ?entity=
  entityFilter?: string;
  budgets: (BudgetRow & { spent: number })[]; // period-correct, from budgetSpent()
  orgMtd: number;
  windowDays: number;
  window: "30d" | "90d" | "mtd";
  now: number;
}) {
  const { budgets, orgMtd, now } = props;
  // budget scopes are entity ids — label bars with the display name the
  // by-entity table already uses, not "vendor_api:anthropic"
  const names = new Map(props.allEntities.map((e) => [e.id, e.name]));
  const windowHref = (w: string) => `/spend?window=${w}${props.entityFilter ? `&entity=${encodeURIComponent(props.entityFilter)}` : ""}`;
  return (
    <>
      <section class="section">
        <h2>Month to date</h2>
        <p class="mtd num">${orgMtd.toFixed(2)}</p>
        {budgets.map((b) => (
          <BudgetBar budget={b} spent={b.spent} label={names.get(b.scope)} />
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
            {(["30d", "90d", "mtd"] as const).map((w) => (
              <a href={windowHref(w)} class={props.window === w ? "active" : ""}>
                {" "}
                {w}
              </a>
            ))}
            {props.entityFilter && (
              <>
                {" "}
                · showing {names.get(props.entityFilter) ?? props.entityFilter} — <a href={`/spend?window=${props.window}`}>all entities</a>
              </>
            )}
          </span>
        </h2>
        {props.entities.length === 0 ? (
          <p class="hint">
            No spend data — set <code>ANTHROPIC_ADMIN_KEY</code> or <code>OPENAI_ADMIN_KEY</code> and wait for the
            daily poll, or record a prepaid balance in <a href="/settings">/settings</a>.
          </p>
        ) : (
          <table class="rows">
            {props.entities.map((e) => {
              // spec §2.3's row anatomy is "MTD $41.20 / $60" — the denominator
              // comes from a budget scoped to this entity, when one exists
              const budget = budgets.find((b) => b.scope === e.id);
              return (
                <tr class="row">
                  <td class="c-name">
                    <a href={`/e/${e.id}`}>{e.name}</a>
                  </td>
                  <td class="num" title={budget ? `soft $${budget.soft_limit} · hard $${budget.hard_limit} (${budget.period})` : undefined}>
                    MTD ${e.mtd.toFixed(2)}
                    {budget ? ` / $${budget.soft_limit}` : ""}
                  </td>
                  <td>
                    <Sparkline points={e.points} days={props.windowDays} now={now} />
                  </td>
                  <td class="num">today ${e.today.toFixed(2)}</td>
                  <td class="num">
                    {/* badges link to the entity page, where the signal's full
                        history lives — they were inert spans (spec §2.3 wants
                        badges "linking to the signal detail") */}
                    {e.balance && (
                      <a href={`/e/${e.id}`} class="chip" data-sev={e.balance.severity} title={e.balance.value_text ?? ""}>
                        bal ${(e.balance.value_num ?? 0).toFixed(2)}
                        {e.balance.severity >= 2 ? "▲" : ""}
                      </a>
                    )}
                  </td>
                  <td>
                    {e.anomaly && e.anomaly.severity >= 2 && (
                      <a href={`/e/${e.id}`} class="chip" data-sev="2" title={e.anomaly.value_text ?? ""}>
                        anomaly ▲
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </table>
        )}
      </section>
    </>
  );
}

// Horizontal bar with soft/hard limit ticks (ux §2.3).
function BudgetBar(props: { budget: BudgetRow; spent: number; label?: string }) {
  const { budget: b, spent } = props;
  const scale = Math.max(b.hard_limit * 1.1, spent, 0.01);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const sev = spent >= b.hard_limit ? 4 : spent >= b.soft_limit ? 2 : 0;
  return (
    <div class="budget">
      <span class="budget-label">
        {b.scope === "*" ? "all entities" : (props.label ?? b.scope)} <span class="num">${spent.toFixed(2)}</span> / ${b.soft_limit} soft · ${b.hard_limit} hard ({b.period})
      </span>
      <div class="budget-bar">
        <div class="budget-fill" data-sev={sev} style={`width:${pct(spent)}`} />
        <div class="budget-tick soft" style={`left:${pct(b.soft_limit)}`} />
        <div class="budget-tick hard" style={`left:${pct(b.hard_limit)}`} />
      </div>
    </div>
  );
}
