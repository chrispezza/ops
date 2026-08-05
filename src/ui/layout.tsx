import type { Child } from "hono/jsx";

const NAV = [
  ["/", "Map"],
  ["/triage", "Triage"],
  ["/spend", "Spend"],
  ["/findings", "Findings"],
  ["/health", "Health"],
] as const;

export function Layout(props: { title?: string; path: string; children?: Child }) {
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
          <span class="freshness">no data yet</span>
        </nav>
        <main>{props.children}</main>
      </body>
    </html>
  );
}
