# Ops — Spec Package v0.1

Read-mostly aggregation dashboard for dev-project portfolios. Two jobs:

1. **Spend** — monitor consumptive cost (API tokens, usage-billed services) over time, against budgets.
2. **Triage** — rank entities (repos, plugins, skills, vendor APIs) by what needs attention, deep-linking out to the real system of record for action.

Non-goals (v1): write actions beyond pre-filled deep links, notifications, workflow state, plugin registry/dynamic loading, auth beyond Cloudflare Access.

---

## 1. Architecture

```
┌──────────────┐   cron    ┌─────────────┐          ┌────────────┐
│ Pollers      │ ────────► │ D1          │ ◄──────  │ HTMX UI    │
│ (Worker)     │  upsert/  │ entities    │  queries │ (Worker,   │
│ github       │  insert   │ signals     │          │  SSR)      │
│ anthropic    │           │ budgets     │          └────────────┘
│ manifests…   │           └─────────────┘
└──────────────┘                 ▲
                                 │ POST /ingest (CI pushes)
                          repo CI pipelines
```

- One Cloudflare Worker, two entry points: `scheduled` (runs pollers) and `fetch` (UI + `/ingest`).
- D1 is the only state. Secrets (PATs, Admin API key) in Worker secrets, never in D1 or the repo.
- Public repo = shell + reference pollers. Deployment-specific config in `wrangler.toml` vars + secrets.

## 2. Data model

Two core tables + one for spend thresholds. Signals are **append-only observations**; current state is always derived by query (latest signal per entity+metric), never mutated.

### 2.1 DDL

```sql
CREATE TABLE entities (
  id           TEXT PRIMARY KEY,          -- "{kind}:{natural_key}", e.g. "repo:clownware/gittunes", "skill:source-digest"
  kind         TEXT NOT NULL,             -- repo | plugin | skill | vendor_api | api_key | ...
  category     TEXT,                      -- presentation bucket: static_site | web_app | plugin_skill | ... (see §2.4)
  name         TEXT NOT NULL,
  owner        TEXT,                      -- org/user/team, freeform
  source_url   TEXT,                      -- canonical deep link (GitHub repo, manifest path, vendor console)
  metadata     TEXT,                      -- JSON blob, poller-specific (language, version, description…)
  first_seen_at INTEGER NOT NULL,         -- unix epoch seconds
  last_seen_at  INTEGER NOT NULL,         -- bumped every time a poller observes it; staleness = now - last_seen_at
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_entities_kind ON entities(kind, archived);

CREATE TABLE signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id    TEXT NOT NULL REFERENCES entities(id),
  source       TEXT NOT NULL,             -- poller id: "github" | "anthropic_usage" | "ci_ingest" | ...
  metric       TEXT NOT NULL,             -- namespaced: "ci.status", "deps.vuln_count", "spend.usd", "usage.invocations", "seo.score"
  value_num    REAL,                      -- one of value_num / value_text set
  value_text   TEXT,
  severity     INTEGER NOT NULL DEFAULT 0,-- 0 info · 1 low · 2 medium · 3 high · 4 critical
  url          TEXT,                      -- deep link to the specific finding (PR, alert, invoice line)
  observed_at  INTEGER NOT NULL,          -- when the condition was true (not when polled)
  period_start INTEGER,                   -- ONLY for interval metrics (spend/usage): the window this value covers
  period_end   INTEGER,
  dedupe_key   TEXT,                      -- source-defined; see §2.3
  UNIQUE(entity_id, metric, dedupe_key)
);
CREATE INDEX idx_signals_entity ON signals(entity_id, metric, observed_at DESC);
CREATE INDEX idx_signals_severity ON signals(severity, observed_at DESC);

CREATE TABLE budgets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL,             -- entity id, kind ("api_key"), or "*"
  metric       TEXT NOT NULL,             -- "spend.usd"
  period       TEXT NOT NULL,             -- "month" | "day"
  soft_limit   REAL NOT NULL,             -- crossing => severity 2 signal
  hard_limit   REAL NOT NULL              -- crossing => severity 4 signal
);
```

### 2.2 Two metric semantics — the one subtlety that matters

- **State metrics** (`ci.status`, `deps.vuln_count`, `manifest.description_missing`): the *latest* signal per (entity, metric) is the truth. Dashboard shows latest; history is a bonus.
- **Interval metrics** (`spend.usd`, `usage.invocations`): each signal covers a `period_start..period_end` window and the truth is a **sum over windows**. Never show "latest" for spend — always an aggregation.

Same table, different queries. Pollers declare which semantics each metric uses (see interface) so the UI can render correctly without per-metric special-casing.

### 2.3 Idempotency

Pollers run on cron and must be safe to re-run. `dedupe_key` makes inserts idempotent via `INSERT OR REPLACE` / upsert:

- State metrics: `dedupe_key = observed_at` bucketed to the poll granularity (or the upstream event id, e.g. Actions run id, Dependabot alert number — preferred when available).
- Interval metrics: `dedupe_key = period_start` (re-polling the same day's spend overwrites, not duplicates — this also handles Anthropic's usage data settling over a few hours).

### 2.4 Categories (project buckets)

`category` groups entities into portfolio buckets: **static_site**, **web_app**, **plugin_skill** (work adds its own). It is *not* `kind` — the GitHub poller sees every project as `repo`; category is classification the API can't infer.

- **Source of truth: GitHub repo topics** (`static-site`, `web-app`, `mcp`, `skill`). The GraphQL query returns topics anyway; the poller maps topic → category. Classification lives in the system of record, not Ops config. Untagged repos land in an `uncategorized` bucket — itself a hygiene finding.
- Non-repo entities (api_key, vendor_api, manifest-derived skills) get category from their poller directly.
- **Expected metrics per category** (config map): `static_site → [lhci.performance]`, `web_app → [ci.status, deps.vuln_count]`, `plugin_skill → [usage.invocations, manifest.description]`. After each poll cycle, core emits a severity-1 `hygiene.missing_metric` signal for any entity lacking a latest signal for an expected metric. Absence becomes queryable — a static site with no Lighthouse data surfaces in triage instead of being invisible.

## 3. Poller interface

Directory convention, no registry. One file per poller in `src/pollers/`, exported and listed in a static array in `src/pollers/index.ts`. That array is the "plugin system."

```ts
// src/pollers/types.ts
export type Kind = "repo" | "plugin" | "skill" | "vendor_api" | "api_key" | (string & {});

export interface EntityUpsert {
  id: string;            // "{kind}:{natural_key}" — poller is responsible for stable natural keys
  kind: Kind;
  name: string;
  owner?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface SignalInsert {
  entityId: string;
  metric: string;        // namespaced: "<domain>.<name>"
  valueNum?: number;
  valueText?: string;
  severity?: 0 | 1 | 2 | 3 | 4;   // default 0
  url?: string;
  observedAt: number;    // epoch seconds
  period?: { start: number; end: number };  // interval metrics only
  dedupeKey: string;
}

export interface PollerResult {
  entities: EntityUpsert[];
  signals: SignalInsert[];
}

export interface Poller {
  id: string;                                    // "github", "anthropic_usage", …
  metricSemantics: Record<string, "state" | "interval">;  // every metric this poller emits
  schedule: "hourly" | "daily";                  // core maps this onto cron triggers
  poll(env: Env, ctx: { since?: number }): Promise<PollerResult>;
}
```

Core responsibilities (pollers never touch D1 directly):
- Upsert entities, bumping `last_seen_at` for every entity in the result.
- Idempotent signal insert keyed on `(entity_id, metric, dedupe_key)`.
- Per-poller error isolation: one poller throwing must not block others; failures are themselves recorded as signals on a synthetic `poller:{id}` entity (`poller.status`, severity 3) — Ops monitors itself with its own machinery.
- After spend pollers run, core evaluates `budgets` and emits threshold-crossing signals (severity 2 soft / 4 hard) attributed to the budget's scope.

### 3.1 Reference pollers (public repo)

| Poller | Kind(s) | Metrics (semantics) | Notes |
|---|---|---|---|
| `github` | repo | `ci.status` (state), `deps.vuln_count` (state), `issues.open` (state), `prs.open` (state), `repo.pushed_at` (state) | One GraphQL query per owner; fine-grained PAT; multi-owner via config var `GITHUB_OWNERS` |
| `anthropic_usage` | api_key | `spend.usd` (interval), `usage.tokens_in/out` (interval) | Admin API cost + usage reports; daily granularity; dedupe on period_start |
| `ci_ingest` | repo | `lhci.performance` (state), `tests.coverage_pct` (state), `audit.vuln_count` (state) | Not a poller — the `POST /ingest` endpoint, bearer-token auth, same SignalInsert shape. Repos push as final CI step. |

Work-only pollers (private, never in public repo): `manifests` (walk repos → parse SKILL.md/plugin manifests → plugin/skill entities + hygiene signals), `skill_usage` (invocation counts, interval), SEO/content audit ingest via `/ingest`.

## 4. Views (queries, not features)

### 4.1 Triage — "what needs addressing"

Rank score per entity, computed in SQL, rendered as a sorted list with deep links:

```
score = 10 * max_open_severity            -- worst latest state-signal
      + 2  * count(severity >= 2)         -- breadth of problems
      + staleness_points                  -- 0 if seen <30d, 3 if 30–90d, 6 if >90d
      + zero_usage_bonus                  -- +5 if usage.invocations sums to 0 over 30d (only for kinds with usage)
```

Weights are config, not code. Each row: entity name, kind badge, top signal, score, `[open →]` (source_url), `[file issue →]` (pre-filled GitHub new-issue URL — the only write-shaped affordance in the app).

### 4.2 Spend — "consumptive burn"

- Month-to-date total per entity + rollup, vs. budget soft/hard lines.
- Daily bar sparkline per api_key (30d window): `SELECT period_start, SUM(value_num) … GROUP BY period_start`.
- Anomaly flag as a derived signal: today > 3× trailing-7-day median → severity 2. Computed by core post-poll, not a poller.

### 4.3 Project map — "what exists"

Home screen: entities grouped by `category` (Static Sites / Web Apps / Plugins·MCPs·Skills), each card showing name, worst open severity, staleness, and its category's expected metrics as a mini status row (LHCI score for sites, CI + vulns for apps, usage for skills). Triage (4.1) is this map flattened and sorted by pain.

### 4.4 Audit findings — a lens, not a domain

Audit results are ordinary signals attached to entities; there is no separate audits table. Two renderings of the same rows:
- **Attached**: entity detail page lists all latest signals, grouped by metric domain, with per-finding deep links.
- **Cross-cutting**: `/findings` — all signals with `severity >= 2` (plus `audit.*` and `hygiene.*` regardless of severity) across every entity, sorted by severity then recency. This is the "audit view"; it is a filter, and adding a new audit source (SEO, content, npm) is just a new poller/ingest metric — the view picks it up with zero changes.

## 5. Cron & config

- `scheduled` handler fans out by `poller.schedule`: hourly cron runs hourly pollers (github), daily cron (~06:00 ET) runs daily (anthropic_usage).
- Config: `GITHUB_OWNERS` (csv), secrets `GITHUB_PAT`, `ANTHROPIC_ADMIN_KEY`, `INGEST_TOKEN`. Budgets seeded via a migration or minimal settings page (the one allowed write to Ops-owned data).
- Auth: Cloudflare Access in front of the whole Worker. No app-level auth in v1.

## 6. Build order

1. Schema + core (entity upsert, idempotent signal insert, poller runner with error isolation). **This PR defines the contract; everything after is additive.**
2. `github` poller + inventory view. Usable day one.
3. Triage view + scoring.
4. `anthropic_usage` poller + budgets + spend view.
5. `/ingest` endpoint + one repo's CI wired to it.
6. Work deployment: private repo importing the public package, work pollers only.

## 7. ADR seeds

- ADR-001: GitHub (etc.) remains system of record; Ops is read-mostly. Only write affordance = pre-filled deep links.
- ADR-002: Append-only signals with query-derived state; two metric semantics (state/interval) declared by pollers.
- ADR-003: Static poller array over dynamic registry until ≥3 deployments diverge.
- ADR-004: Public shell / private config split; work pollers never upstream.
