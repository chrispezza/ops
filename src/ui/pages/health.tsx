import type { PollerHealth } from "../../core/queries";
import { Dot, timeAgo } from "../components";

interface StatusDetail {
  ok: boolean;
  error?: string;
  entities: number;
  signals: number;
  durationMs: number;
}

export function HealthPage(props: { health: PollerHealth[]; now: number }) {
  const { health, now } = props;
  return (
    <>
      <h2>Poller status</h2>
      {health.length === 0 ? (
        <p class="hint">No poller has run yet. Trigger one below or wait for the cron.</p>
      ) : (
        <table class="rows">
          <tr>
            <th />
            <th>poller</th>
            <th>last run</th>
            <th>last success</th>
            <th class="num">duration</th>
            <th class="num">entities</th>
            <th class="num">signals</th>
            {/* "detail", not "error" — this column also holds the calm
                "unconfigured: set X" states, which are not errors */}
            <th>detail</th>
          </tr>
          {health.map((h) => {
            const detail = parseDetail(h.lastRun?.value_text);
            // severity ≤1 = calm (unconfigured); only real failures wear red —
            // README promises "unconfigured pollers listed calmly, a real failure in red"
            const calm = (h.lastRun?.severity ?? 0) <= 1;
            return (
              <tr class="row">
                <td class="c-dot">
                  <Dot severity={h.lastRun?.severity ?? 0} />
                </td>
                <td class="c-name">{h.name}</td>
                <td>{h.lastRun ? `${timeAgo(h.lastRun.observed_at, now)} ago` : "never"}</td>
                <td>{h.lastOk ? `${timeAgo(h.lastOk.observed_at, now)} ago` : "never"}</td>
                <td class="num">{detail ? formatMs(detail.durationMs) : "—"}</td>
                <td class="num">{detail?.entities ?? "—"}</td>
                <td class="num">{detail?.signals ?? "—"}</td>
                <td class={calm ? "status-note" : "error-text"}>{detail?.error ?? ""}</td>
              </tr>
            );
          })}
        </table>
      )}
      <form method="post" action="/health/run" data-busy="running — takes ~15s…">
        {/* aria-live announces the busy label; aria-disabled instead of disabled
            would keep focus, but the form submits and navigates immediately */}
        <button type="submit" aria-live="polite">run all pollers now</button>
      </form>
    </>
  );
}

// same unit rules the metric formatter uses — "15234ms" was the one raw
// duration in an app that formats every other one
function formatMs(n: number): string {
  if (n >= 60_000) return `${Math.floor(n / 60_000)}m${Math.round((n % 60_000) / 1000)}s`;
  if (n >= 1000) return `${Math.round(n / 1000)}s`;
  return `${Math.round(n)}ms`;
}

function parseDetail(text: string | null | undefined): StatusDetail | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as StatusDetail;
  } catch {
    return null;
  }
}
