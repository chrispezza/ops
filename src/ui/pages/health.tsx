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
            <th>error</th>
          </tr>
          {health.map((h) => {
            const detail = parseDetail(h.lastRun?.value_text);
            return (
              <tr class="row">
                <td class="c-dot">
                  <Dot severity={h.lastRun?.severity ?? 0} />
                </td>
                <td class="c-name">{h.name}</td>
                <td>{h.lastRun ? `${timeAgo(h.lastRun.observed_at, now)} ago` : "never"}</td>
                <td>{h.lastOk ? `${timeAgo(h.lastOk.observed_at, now)} ago` : "never"}</td>
                <td class="num">{detail ? `${detail.durationMs}ms` : "—"}</td>
                <td class="num">{detail?.entities ?? "—"}</td>
                <td class="num">{detail?.signals ?? "—"}</td>
                <td class="error-text">{detail?.error ?? ""}</td>
              </tr>
            );
          })}
        </table>
      )}
      <form
        method="post"
        action="/health/run"
        onsubmit="const b=this.querySelector('button');b.disabled=true;b.textContent='running — takes ~15s…'"
      >
        <button type="submit">Run all pollers now</button>
      </form>
    </>
  );
}

function parseDetail(text: string | null | undefined): StatusDetail | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as StatusDetail;
  } catch {
    return null;
  }
}
