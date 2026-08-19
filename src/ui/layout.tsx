import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { PollerHealth } from "../core/queries";
import { timeAgo } from "./components";

const NAV = [
  ["/", "Map"],
  ["/triage", "Triage"],
  ["/spend", "Spend"],
  ["/findings", "Findings"],
  ["/health", "Health"],
  ["/settings", "Settings"],
] as const;

// Human names for poller ids — the banner reads "GitHub data is 9h old", not
// "anthropic_usage data is…". Fallback de-snake_cases unknown ids.
const POLLER_LABELS: Record<string, string> = {
  github: "GitHub",
  anthropic_usage: "Anthropic usage",
  claude_code: "Claude Code",
  openai_costs: "OpenAI costs",
  x_usage: "X usage",
  cloudflare: "Cloudflare",
  uptime: "Uptime",
  manifests: "Marketplace",
};
const pollerLabel = (id: string) => POLLER_LABELS[id] ?? id.replace(/_/g, " ");

// Per-source banners beyond this collapse into one summary banner.
const MAX_BANNERS = 2;

// ux principle 2: never lie about freshness. The chip shows worst-case
// staleness across sources; failing sources get a visible banner.
export function FreshnessChip(props: { health: PollerHealth[]; now: number }) {
  const oks = props.health.map((h) => h.lastOk?.observed_at).filter((t): t is number => t != null);
  // A hard-failing poller that has NEVER succeeded contributes no lastOk, so
  // "data ≤ 2h old" would quietly overclaim. Unconfigured (sev 1) stays out —
  // that's a deliberate calm state, not missing data.
  const neverSucceeded = props.health.some((h) => (h.lastRun?.severity ?? 0) >= 3 && !h.lastOk);
  const label =
    oks.length === 0
      ? "no data yet"
      : neverSucceeded
        ? "some sources have no data"
        : `data ≤ ${timeAgo(Math.min(...oks), props.now)} old`;
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
  hasH1?: boolean; // the entity page renders its own visible h1
  children?: Child;
}) {
  const failing = props.health.filter((h) => (h.lastRun?.severity ?? 0) >= 3);
  return (
    <>
      {/* without the doctype every page rendered in QUIRKS MODE — the UA
          stylesheet then resets table fonts to 16px, which is why table values
          ignored the 13px base and column widths ran out of room */}
      {raw("<!DOCTYPE html>")}
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title ? `${props.title} · Ops` : "Ops"}</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/tokens.css" />
        <script src="/htmx.min.js" defer></script>
        {/* keyboard, row-click, copy and busy-submit behaviour — external so the CSP needs no 'unsafe-inline' */}
        <script src="/app.js" defer></script>
      </head>
      <body>
        <nav class="top">
          <span class="brand">
            {/* sanctioned mono variants per ground — never recolored (Pezza rule 3) */}
            <img class="mark-light" src="/emblem-mono-black.svg" alt="" width="18" height="18" />
            <img class="mark-dark" src="/emblem-mono-white.svg" alt="" width="18" height="18" />
            Ops
          </span>
          {NAV.map(([href, label]) => (
            <a href={href} class={props.path === href ? "active" : ""} aria-current={props.path === href ? "page" : undefined}>
              {label}
            </a>
          ))}
          <FreshnessChip health={props.health} now={props.now} />
        </nav>
        <main>
          {/* inside <main> so landmark navigation reaches it; role=status so its
              presence is announced. failingSince is the outage ONSET — the old
              lastRun-based copy read "failing since 7m ago" through a 4-day outage. */}
          {failing.length > MAX_BANNERS ? (
            // one rail, not N: several sources failing at once used to stack a
            // banner per source and push the page below the fold — the count and
            // names say what's wrong, /health has the per-source detail
            <div class="banner amber" role="status">
              {failing.length} data sources are failing ({failing.map((h) => pollerLabel(h.name)).join(", ")}) →{" "}
              <a href="/health">/health</a>
            </div>
          ) : (
            failing.map((h) => (
              <div class="banner amber" role="status">
                {pollerLabel(h.name)} data is{" "}
                {h.lastOk ? `${timeAgo(h.lastOk.observed_at, props.now)} old` : "unavailable"} (poller
                failing for {h.failingSince ? timeAgo(h.failingSince, props.now) : "?"}) →{" "}
                <a href="/health">/health</a>
              </div>
            ))
          )}
          {props.title && !props.hasH1 && <h1 class="sr-only">{props.title}</h1>}
          {props.children}
        </main>
      </body>
      </html>
    </>
  );
}
