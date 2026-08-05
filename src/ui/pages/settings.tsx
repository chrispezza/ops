import type { TriageWeights } from "../../config";
import type { BudgetRow } from "../../core/derive";

// The only writes to Ops-owned data (ux §2.7): budgets and triage weights.
export function SettingsPage(props: { budgets: BudgetRow[]; weights: TriageWeights }) {
  const w = props.weights;
  const staleness90 = w.staleness.find((t) => t.minDays === 90)?.points ?? 6;
  const staleness30 = w.staleness.find((t) => t.minDays === 30)?.points ?? 3;
  return (
    <>
      <section class="section">
        <h2>Budgets</h2>
        {props.budgets.length > 0 && (
          <table class="rows">
            <tr>
              <th>scope</th>
              <th>metric</th>
              <th>period</th>
              <th class="num">soft</th>
              <th class="num">hard</th>
              <th />
            </tr>
            {props.budgets.map((b) => (
              <tr class="row">
                <td>{b.scope}</td>
                <td>{b.metric}</td>
                <td>{b.period}</td>
                <td class="num">${b.soft_limit}</td>
                <td class="num">${b.hard_limit}</td>
                <td class="c-links">
                  <form method="post" action="/settings/budgets/delete">
                    <input type="hidden" name="id" value={String(b.id)} />
                    <button type="submit">delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        )}
        <form method="post" action="/settings/budgets" class="filters">
          <input name="scope" placeholder='scope ("*", kind, or entity id)' required />
          <select name="period">
            <option value="month">month</option>
            <option value="day">day</option>
          </select>
          <input name="soft_limit" type="number" step="0.01" min="0" placeholder="soft $" required />
          <input name="hard_limit" type="number" step="0.01" min="0" placeholder="hard $" required />
          <button type="submit">add budget</button>
        </form>
        <p class="hint">Metric is spend.usd; crossing soft emits severity 2, hard emits severity 4.</p>
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
      </section>
    </>
  );
}
