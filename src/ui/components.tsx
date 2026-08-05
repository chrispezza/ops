import type { SignalRow } from "../core/queries";

export function Dot(props: { severity: number }) {
  return <span class="dot" data-sev={props.severity} title={`severity ${props.severity}`} />;
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
  const text = props.render
    ? props.render(signal)
    : (signal.value_text ?? (signal.value_num != null ? String(signal.value_num) : "?"));
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
