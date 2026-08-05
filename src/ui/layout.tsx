import type { Child } from "hono/jsx";
import type { PollerHealth } from "../core/queries";
import { timeAgo } from "./components";

const NAV = [
  ["/", "Map"],
  ["/triage", "Triage"],
  ["/spend", "Spend"],
  ["/findings", "Findings"],
  ["/health", "Health"],
] as const;

// ux principle 2: never lie about freshness. The chip shows worst-case
// staleness across sources; failing sources get a visible banner.
export function FreshnessChip(props: { health: PollerHealth[]; now: number }) {
  const oks = props.health.map((h) => h.lastOk?.observed_at).filter((t): t is number => t != null);
  const label =
    oks.length === 0 ? "no data yet" : `data ≤ ${timeAgo(Math.min(...oks), props.now)} old`;
  return (
    <a
      class="freshness"
      href="/health"
      hx-get="/partials/freshness"
      hx-trigger="every 300s"
      hx-swap="outerHTML"
    >
      {label}
    </a>
  );
}

export function Layout(props: {
  title?: string;
  path: string;
  health: PollerHealth[];
  now: number;
  children?: Child;
}) {
  const failing = props.health.filter((h) => (h.lastRun?.severity ?? 0) >= 3);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title ? `${props.title} · Ops` : "Ops"}</title>
        <link rel="stylesheet" href="/tokens.css" />
        <script src="/htmx.min.js" defer></script>
      </head>
      <body>
        <nav class="top">
          <span class="brand">Ops</span>
          {NAV.map(([href, label]) => (
            <a href={href} class={props.path === href ? "active" : ""}>
              {label}
            </a>
          ))}
          <FreshnessChip health={props.health} now={props.now} />
        </nav>
        {failing.map((h) => (
          <div class="banner amber">
            {h.name} data is{" "}
            {h.lastOk ? `${timeAgo(h.lastOk.observed_at, props.now)} old` : "unavailable"} (poller
            failing since {h.lastRun ? `${timeAgo(h.lastRun.observed_at, props.now)} ago` : "?"}) →{" "}
            <a href="/health">/health</a>
          </div>
        ))}
        <main>{props.children}</main>
      </body>
    </html>
  );
}
