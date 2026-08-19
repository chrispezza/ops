import type { SignalRow } from "../core/queries";

import { SEVERITY_NAMES as SEV_NAMES } from "../config";

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
  if (s.metric.startsWith("spend.") || s.metric === "budget.status" || s.metric === "balance.usd")
    return `$${n.toFixed(2)}`;
  if (s.metric.endsWith("_pct") || s.metric === "cf.error_rate") return `${n}%`;
  if (s.metric.endsWith("_bytes")) return n >= 1e9 ? `${(n / 1e9).toFixed(2)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1e3)}kB`;
  // sub-second values used to collapse to "0s" — a 180ms site response is a
  // good number that rendered as a broken-looking one
  if (s.metric.endsWith("_ms"))
    return n >= 60_000
      ? `${Math.floor(n / 60_000)}m${Math.round((n % 60_000) / 1000)}s`
      : n >= 1000
        ? `${Math.round(n / 1000)}s`
        : `${Math.round(n)}ms`;
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
export function Chip(props: {
  label: string;
  signal?: SignalRow;
  now: number;
  render?: (s: SignalRow) => string;
  // ids of sources currently hard-failing — their values render dimmed, never
  // hidden (spec §3): the number stays, visibly demoted, with the age in the title
  staleSources?: ReadonlySet<string>;
}) {
  const { label, signal, now } = props;
  if (!signal) {
    return (
      // teach, don't dead-end (spec §0.5): missing expected metrics arrive from
      // a poller or from CI via POST /ingest
      <span class="chip missing" title={`${label}: no data — arrives from a poller or via POST /ingest (see README)`}>
        {label} —
      </span>
    );
  }
  const stale = props.staleSources?.has(signal.source) ?? false;
  const text = props.render ? props.render(signal) : formatSignalValue(signal, now);
  const sev = signal.severity;
  const body = (
    <span
      class={stale ? "chip stale-data" : "chip"}
      data-sev={stale ? undefined : sev}
      title={`${label} · observed ${timeAgo(signal.observed_at, now)} ago${stale ? " · source failing — value may be stale" : ""}`}
    >
      {label} {text}
      {sev >= 2 ? "▲" : ""}
    </span>
  );
  const href = safeHref(signal.url);
  return href ? <a href={href}>{body}</a> : body;
}

// JSX escaping stops markup injection but not `javascript:` — the scheme needs
// no special characters. Ingest sets url/sourceUrl/metadata.homepage freely, so
// every href renders through here (same check the uptime poller already makes).
export function safeHref(url: string | null | undefined): string | undefined {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : undefined;
}

// The "↗" out-link, repeated across every list view. Renders nothing when the
// stored URL fails safeHref, so a poisoned row loses its link, not the page.
export function ExtLink(props: { url: string | null | undefined; children?: unknown }) {
  const href = safeHref(props.url);
  if (!href) return null;
  // Text content wins accname computation, so a bare "↗" announces as "north
  // east arrow" — aria-label gives it a real name; title covers mouse hover.
  const host = (() => {
    try {
      return new URL(href).hostname;
    } catch {
      return href;
    }
  })();
  return (
    <a href={href} title={href} aria-label={props.children ? undefined : `open on ${host}`}>
      {props.children ?? "↗"}
    </a>
  );
}

export function newIssueUrl(sourceUrl: string): string | undefined {
  const safe = safeHref(sourceUrl);
  return safe ? `${safe}/issues/new` : undefined;
}

// A sortable column header. Sorts are single-direction today, so the active
// column says which way it runs — the underline marked WHICH sort was on, but
// asc/desc was invisible to everyone. aria-sort on the <th> gives AT the same
// fact; the arrow is aria-hidden so the link name stays the column name.
export function SortTh(props: {
  label: string;
  href: string;
  active: boolean;
  dir: "ascending" | "descending";
  class?: string;
  title?: string;
}) {
  return (
    <th scope="col" class={props.class} title={props.title} aria-sort={props.active ? props.dir : undefined}>
      <a class={props.active ? "sort active" : "sort"} href={props.href}>
        {props.label}
        {props.active && (
          <span class="sort-dir" aria-hidden="true">
            {props.dir === "descending" ? "↓" : "↑"}
          </span>
        )}
      </a>
    </th>
  );
}
