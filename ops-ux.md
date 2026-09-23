# Ops — UX Spec v0.1

Companion to `ops-spec.md`. Defines pages, URLs, layouts, and states. Design philosophy: **an instrument panel, not a product.** One user, zero onboarding, information-dense, every number links somewhere real. Server-rendered HTML + HTMX partial swaps; no client state beyond what's in the URL.

## 0. Principles

1. **URL is the only state.** Every filter, sort, and time window is a query param. Any view is shareable/bookmarkable; HTMX swaps just re-request the same URL with new params. No JS state to reconcile.
2. **Never lie about freshness.** Every data region shows its source's last successful poll. Stale or failed sources get a visible degradation banner, not silently old numbers. (Backed by the `poller:{id}` self-monitoring signals.)
3. **Read here, act there.** Every finding deep-links to the system of record. The only in-app "action" is the pre-filled new-issue link.
4. **Density over whitespace.** Tables and rows, not cards with padding. Target: whole personal portfolio visible on one 14" screen without scrolling on `/`.
5. **Empty states teach.** First-run and zero-result states say what would fill them ("No LHCI data — wire your CI to POST /ingest, see README §x").

## 1. Page inventory & URL scheme

| Route | View | Params |
|---|---|---|
| `/` | Project map (home); `view=priority` is the ranked worklist | `category`, `owner`, `q`; priority adds `kind`, `min_severity`, `sort` |
| `/board` | Derived board (now / next / later / in flight / done) | `owner`, `category`, `q` |
| `/triage` | 301 → `/?view=priority` (query string preserved) | — |
| `/spend` | Consumptive burn | `window` (30d default), `entity` |
| `/findings` | Cross-cutting audit lens | `min_severity` (2), `domain` (metric prefix), `category`, `view` (`heat` = entity × domain grid) |
| `/e/{entity_id}` | Entity detail | `window` for interval charts |
| `/settings` | Budgets + triage weights | — |
| `/health` | Poller status board | — |

Nav: single top bar — `Map · Board · Spend · Findings · Digest · Health · Settings` — plus a global freshness chip (worst-case staleness across sources, links to `/health`).

## 2. Page specs

### 2.1 `/` — Project map

Three category sections (Static Sites / Web Apps / Plugins·MCPs·Skills), then `Uncategorized` **only if non-empty**, styled as a warning ("tag these repos").

Row anatomy (one line per entity):

```
● gittunes            web_app   CI ✓  vulns 2▲  PRs 3   pushed 2d   score 14   [↗] [+issue]
```

- Leading dot = worst open severity (color-coded: gray/blue/yellow/orange/red).
- Middle: the category's **expected metrics** as compact chips (sites: LHCI perf; apps: CI/vulns/PRs; skills: usage 30d/updated). Missing expected metric renders as `—` in warning color — the hygiene gap is visible in place, not just in findings.
- Right: triage score with a bar relative to the highest score on the page, deep link to source, pre-filled new-issue link.
- Row click → `/e/{id}`. Chip click → that finding's URL if one exists.

Section headers show rollups: entity count, count-with-open-severity≥2, and for skills: total 30d invocations.

### 2.2 `/?view=priority` (was `/triage`)

The map's other face (open question 1, resolved after real use: one URL, a `by category ⇄ by priority` toggle in the filter bar). The map flattened, sorted by score desc. Same row anatomy plus a "why" column: top 2 score contributors in words ("critical vuln · stale 94d"). Score breakdown on hover/expand (HTMX inline expand). This page is the daily driver — the answer to "what should I work on."

### 2.3 `/spend`

Top: month-to-date total vs. budget, rendered as a horizontal bar with soft/hard limit ticks. Then per-entity (api_key) rows:

```
clownbot-gateway   MTD $41.20 / $60   ▁▂▁▄▂▇▂ (30d)   today $2.10   [anomaly ⚠ if flagged]
```

- Sparklines are **server-rendered inline SVG** from the daily-sum query. No chart library; ~20 lines of template code. Bars, not lines (spend is discrete daily sums).
- Anomaly and budget-crossing signals render as badges linking to the signal detail.
- `window` param: 30d / 90d / mtd.

### 2.4 `/findings`

Flat table: severity dot, entity, metric, value, observed_at, deep link. Default `min_severity=2` plus all `audit.*` and `hygiene.*`. `domain` param filters by metric prefix — this is how "SEO audit view" exists at work without any new page. Group-by-entity toggle (param, not JS).

`view=heat` renders the same latest rows as a grid: entities down (worst first), metric domains across (hottest column first), each cell the worst severity that domain carries for the entity, with the digit in the cell and the signals in its title. Cells below the severity floor render quiet so the shape of the portfolio stays visible while the floor picks out the problems. One glance answers "one repo, or one domain everywhere".

### 2.5 `/e/{entity_id}`

- Header: name, kind/category badges, owner, source link, first/last seen, archive toggle.
- **State metrics**: table of latest signal per metric (value, severity, observed_at, link), grouped by metric domain.
- **Interval metrics**: sparkline + table per metric over `window`.
- **History**: reverse-chron signal feed (paginated, HTMX load-more). This is the audit trail.

### 2.6 `/health`

One row per poller: last run, last success, duration, entities/signals written, current status signal. Failures show the error text. This page is why principle 2 is cheap to honor.

### 2.7 `/settings`

Two forms (the only writes to Ops-owned data): budget rows (scope/metric/period/limits) and triage weights (the four constants from spec §4.1). Plain POST, full-page render is fine.

### 2.8 `/board`

The findings bands at card granularity, plus the two columns a severity feed cannot show. Five columns, **derived on every render** from stored severity — no board state exists anywhere:

| Column | Derived from |
|---|---|
| Now | severity 3+: P0-labelled issues, CI red, site down, critical vulns |
| Next | severity 2: P1 issues, high vulns, human PRs open 30d+ |
| Later | severity 1: P2 issues, hygiene and docs gaps, PRs open 14d+, Dependabot major bumps |
| In flight | human PRs under 14d (drafts included), repos pushed in the last 7d with no open PR |
| Done this week | issues closed and PRs merged in the trailing 7d, findings that resolved (the digest's list) |

Issue and PR cards come from the `issues.cards` / `prs.cards` rows the GitHub poller stores (one JSON row per repo per hour); a repo without a cards row still gets its `issues.flagged` and `prs.*` findings as cards. Every card links to the issue, PR or finding on GitHub. **Nothing is draggable** — moving a card means changing the system of record (relabel, merge, fix) and the next poll moves it (ADR-001). PR cards carry an age bar scaled to 30 days.

## 3. States & degradation

| Condition | Treatment |
|---|---|
| First run, empty DB | `/` shows setup checklist: set secrets → tag repos → wait for cron / trigger manual poll (`/health` has a "run now" button, dev-only) |
| Poller failing | Amber banner on every page listing the source + age of last good data: "GitHub data is 9h old (poller failing since 03:12) → /health". Numbers from that source render dimmed, never hidden. |
| No entities in a category | Section renders with hint text, not omitted — the IA stays stable. |
| Signal with no URL | Chip renders unlinked; no dead links. |
| Interval metric, partial current day | Today's bar rendered hollow/hatched — visibly provisional (dedupe-key overwrite will settle it). |

## 4. Visual layer (v1 constraints)

- Semantic HTML, one tokens CSS file: type scale (system mono for numerals, system sans for labels), 4px spacing scale, severity palette (the five dot colors), light/dark via `prefers-color-scheme`.
- No component framework, no icon font (severity dots and unicode arrows suffice).
- Everything keyed for a later reskin: severity colors, spacing, and type are *only* referenced via tokens. The LCARS-inspired treatment, when earned, is a token-file + layout-chrome swap.
- Mobile: read-only glance use. Tables collapse to definition-list rows below 640px; no separate mobile IA.

## 5. Interaction notes

- HTMX targets: filter controls swap the table region only; nav is full page. `hx-push-url` on every filter change so back-button and refresh behave.
- Sort: column-header links that set `sort=` param. Server sorts; no client table JS.
- Auto-refresh: `hx-trigger="every 300s"` on the freshness chip only — it's cheap, and it tells you *whether* to reload, rather than reloading heavy views on a timer.
- Keyboard: `/` focuses the filter box on map/triage/findings. That's the whole shortcut system for v1.

## 6. Open questions (decide in first implementation PR, not before)

1. ~~Does `/triage` fold into `/` as a sort toggle?~~ Folded: `/?view=priority`, with `/triage` redirecting.
2. Per-category chip sets are hardcoded in templates v1; move to the expected-metrics config map only if they churn.
3. Archive semantics: hidden from `/` and `/triage`, still visible in `/findings` history? (Leaning yes.)
