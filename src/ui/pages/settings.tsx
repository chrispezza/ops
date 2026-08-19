import type { TriageWeights } from "../../config";
import type { BalanceEntry, BudgetRow } from "../../core/derive";

// A rejected form re-renders with what the user typed — the old redirect-with
// ?err= flow blanked every field on failure.
export interface SettingsDraft {
  budget?: { scope: string; period: string; soft: string; hard: string };
  balance?: { entityId: string; name: string; startingUsd: string; asOf: string };
}

// The only writes to Ops-owned data (ux §2.7): budgets, triage weights, balances.
export function SettingsPage(props: {
  budgets: BudgetRow[];
  weights: TriageWeights;
  balances: BalanceEntry[];
  error?: string;
  draft?: SettingsDraft;
}) {
  const draftBudget = props.draft?.budget;
  const draftBalance = props.draft?.balance;
  const w = props.weights;
  const staleness90 = w.staleness.find((t) => t.minDays === 90)?.points ?? 6;
  const staleness30 = w.staleness.find((t) => t.minDays === 30)?.points ?? 3;
  return (
    <>
      {props.error && <div class="banner amber">{props.error}</div>}
      <section class="section">
        <h2>Budgets</h2>
        {props.budgets.length > 0 && (
          <table role="table" class="rows">
            <tr role="row">
              <th role="columnheader" scope="col">scope</th>
              <th role="columnheader" scope="col">metric</th>
              <th role="columnheader" scope="col">period</th>
              <th role="columnheader" scope="col" class="num">soft</th>
              <th role="columnheader" scope="col" class="num">hard</th>
              <th role="columnheader" scope="col" />
            </tr>
            {props.budgets.map((b) => (
              <tr role="row" class="row">
                <td role="cell">{b.scope}</td>
                <td role="cell">{b.metric}</td>
                <td role="cell">{b.period}</td>
                <td role="cell" class="num">${b.soft_limit}</td>
                <td role="cell" class="num">${b.hard_limit}</td>
                <td role="cell" class="c-links">
                  <form method="post" action="/settings/budgets/delete">
                    <input type="hidden" name="id" value={String(b.id)} />
                    <button type="submit">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        )}
        {/* visible labels, same pattern as the weights form below — placeholders
            vanish on input and screen readers get nothing from a bare select */}
        <form method="post" action="/settings/budgets" class="filters">
          <label>
            scope <input name="scope" placeholder='"*", kind, or entity id' value={draftBudget?.scope ?? ""} required />
          </label>
          <label>
            period{" "}
            <select name="period">
              <option value="month" selected={draftBudget?.period !== "day"}>month</option>
              <option value="day" selected={draftBudget?.period === "day"}>day</option>
            </select>
          </label>
          <label>
            soft $ <input name="soft_limit" type="number" step="0.01" min="0" value={draftBudget?.soft ?? ""} required />
          </label>
          <label>
            hard $ <input name="hard_limit" type="number" step="0.01" min="0" value={draftBudget?.hard ?? ""} required />
          </label>
          <button type="submit">add budget</button>
        </form>
        <p class="hint">Metric is spend.usd; crossing soft emits severity 2, hard emits severity 4.</p>
      </section>

      <section class="section">
        <h2>Prepaid balances</h2>
        {props.balances.length > 0 && (
          <table role="table" class="rows">
            <tr role="row">
              <th role="columnheader" scope="col">entity</th>
              <th role="columnheader" scope="col">name</th>
              <th role="columnheader" scope="col" class="num">starting</th>
              <th role="columnheader" scope="col">as of</th>
              <th role="columnheader" scope="col" />
            </tr>
            {props.balances.map((b) => (
              <tr role="row" class="row">
                <td role="cell" class="c-kind">{b.entityId}</td>
                <td role="cell">{b.name}</td>
                <td role="cell" class="num">${b.startingUsd.toFixed(2)}</td>
                <td role="cell" class="c-kind">{new Date(b.asOf * 1000).toISOString().slice(0, 10)}</td>
                <td role="cell" class="c-links">
                  <form method="post" action="/settings/balances/delete">
                    <input type="hidden" name="entity_id" value={b.entityId} />
                    <button type="submit">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        )}
        <form method="post" action="/settings/balances" class="filters">
          <label>
            entity id <input name="entity_id" placeholder="vendor_api:xai" value={draftBalance?.entityId ?? ""} required />
          </label>
          <label>
            name <input name="name" placeholder="xAI" value={draftBalance?.name ?? ""} required />
          </label>
          <label>
            starting $ <input name="starting_usd" type="number" step="0.01" min="0" value={draftBalance?.startingUsd ?? ""} required />
          </label>
          {/* date inputs never render placeholders — without the label this
              was an anonymous mm/dd/yyyy box */}
          <label>
            as of <input name="as_of" type="date" value={draftBalance?.asOf ?? ""} required />
          </label>
          <button type="submit">add balance</button>
        </form>
        <p class="hint">
          No vendor exposes a balance API — record the credit balance once and Ops derives live remaining
          (starting − observed spend since that date). Low balance flags at &lt;20%, empty at $0.
        </p>
      </section>

      <section class="section">
        <h2>Triage weights</h2>
        <form method="post" action="/settings/weights" class="filters">
          <label>
            severity ×<input name="severity_factor" type="number" min="0" value={String(w.severityFactor)} />
          </label>
          <label>
            breadth ×<input name="breadth_factor" type="number" min="0" value={String(w.breadthFactor)} />
          </label>
          <label>
            stale 30d +<input name="staleness_30" type="number" min="0" value={String(staleness30)} />
          </label>
          <label>
            stale 90d +<input name="staleness_90" type="number" min="0" value={String(staleness90)} />
          </label>
          <label>
            zero usage +<input name="zero_usage_bonus" type="number" min="0" value={String(w.zeroUsageBonus)} />
          </label>
          <button type="submit">save weights</button>
        </form>
        <p class="hint">
          Score = worst severity × the severity factor, + breadth × findings at ≥ medium, + staleness points past
          30/90 days without a push. Zero-usage applies only once usage telemetry exists (it is inert until a poller
          reports invocations).
        </p>
      </section>
    </>
  );
}
