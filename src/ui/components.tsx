import type { SignalRow } from "../core/queries";

const SEV_NAMES = ["ok", "low", "medium", "high", "critical"] as const;

export function Dot(props: { severity: number }) {
  const name = SEV_NAMES[props.severity] ?? "unknown";
  return (
    <span
      class="dot"
      data-sev={props.severity}
      role="img"
      aria-label={`severity: ${name}`}
      title={`severity: ${name}`}
    />
  );
}

// Per-metric display formatting — raw numbers never reach the UI unlabeled.
export function formatSignalValue(
  s: Pick<SignalRow, "metric" | "value_num" | "value_text" | "severity">,
  now: number,
): string {
  const n = s.value_num;
  // the metric label already names what's expected — the value is just the verdict
  if (s.metric.startsWith("hygiene.missing")) return s.severity > 0 ? "missing" : "present";
  if (s.metric === "hygiene.uncategorized") return s.severity > 0 ? "untagged" : `tagged ${s.value_text}`;
  if (s.metric === "hygiene.inactive") return s.value_text ?? "—";
  if (s.metric === "site.up") return s.value_num === 1 ? "up" : "down";
  if (n == null) return s.value_text ?? "—";
  if (s.metric === "repo.pushed_at") return `${timeAgo(n, now)} ago`;
  if (s.metric.startsWith("spend.") || s.metric === "budget.status") return `$${n.toFixed(2)}`;
  if (s.metric.endsWith("_ms")) return n >= 60_000 ? `${Math.floor(n / 60_000)}m${Math.round((n % 60_000) / 1000)}s` : `${Math.round(n / 1000)}s`;
  if (s.metric.endsWith("_days")) return `${n}d`;
  if (s.metric.startsWith("usage.tokens")) return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
  return String(n);
}

export function timeAgo(epoch: number, now: number): string {
  const s = Math.max(0, now - epoch);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

// A metric rendered compactly; missing expected metrics render as a warning "—" (ux §2.1).
export function Chip(props: { label: string; signal?: SignalRow; now: number; render?: (s: SignalRow) => string }) {
  const { label, signal, now } = props;
  if (!signal) {
    return (
      <span class="chip missing" title={`${label}: no data`}>
        {label} —
      </span>
    );
  }
  const text = props.render ? props.render(signal) : formatSignalValue(signal, now);
  const sev = signal.severity;
  const body = (
    <span class="chip" data-sev={sev} title={`${label} · observed ${timeAgo(signal.observed_at, now)} ago`}>
      {label} {text}
      {sev >= 2 ? "▲" : ""}
    </span>
  );
  return signal.url ? <a href={signal.url}>{body}</a> : body;
}

export function newIssueUrl(sourceUrl: string): string {
  return `${sourceUrl}/issues/new`;
}
