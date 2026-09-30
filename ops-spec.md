# Ops — Spec Package v0.2

Read-mostly aggregation dashboard for dev-project portfolios. Two jobs:

1. **Spend** — monitor consumptive cost (API tokens, usage-billed services) over time, against budgets.
2. **Triage** — rank entities (repos, plugins, skills, vendor APIs) by what needs attention, deep-linking out to the real system of record for action.

Non-goals: write actions beyond pre-filled deep links, workflow state (nothing is draggable; see [ADR-001](docs/adr/001-read-mostly-system-of-record.md)), plugin registry/dynamic loading ([ADR-003](docs/adr/003-static-poller-array.md)), and a login of its own — Cloudflare Access is the authentication layer, optionally verified inside the Worker (§5). Push notifications, a v0.1 non-goal, exist in one narrow form: severity ≥ 3 findings and the weekly digest go out through ntfy (`src/core/notify.ts`), one-way, never a write path.

> **Revision note (v0.2, 2026-09-30).** Reconciled with the code as built. Section numbers are cited from `src/` (`spec §2.4`, `spec §4.1`, …) and are stable; content within a section describes the current code, and where the code deliberately departed from v0.1 the section says so. [CLAUDE.md](CLAUDE.md) is the operating manual and wins on any conflict.

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

- One Cloudflare Worker, two entry points: `scheduled` (runs pollers, the retention sweep and the weekly digest push) and `fetch` (UI + `/ingest` + `/digest/md`).
- D1 is the only state. Secrets (PATs, Admin API key) in Worker secrets, never in D1 or the repo.
- Public repo = shell + reference pollers. Deployment-specific config in `wrangler.jsonc` vars + secrets ([ADR-004](docs/adr/004-public-shell-private-config.md)).

## 2. Data model

Two core tables + one for spend thresholds, plus two added by later migrations (below). Signals are **append-only observations**; current state is always derived by query (latest signal per entity+metric), never mutated.

### 2.1 DDL

The three v0.1 tables as shipped in `migrations/0001_init.sql`. `dedupe_key` is `NOT NULL` — SQLite treats NULLs as distinct in a UNIQUE constraint, which would silently defeat idempotency ([ADR-002](docs/adr/002-append-only-signals.md)).

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
  dedupe_key   TEXT NOT NULL,             -- source-defined; see §2.3
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

Later migrations, each append-only (never edit an applied migration):

| Migration | Adds | Why |
|---|---|---|
| `0002_settings.sql` | `settings(key, value JSON)` | triage weight overrides, notified-alert state, balances |
| `0003_signal_latest.sql` | `signal_latest(entity_id, metric) → signal_id, observed_at` + `idx_signals_metric` | "latest per (entity, metric)" as two index seeks instead of a window scan; maintained in the same batch as every signal write ([ADR-005](docs/adr/005-signal-latest-pointer.md)) |
| `0004_read_budget.sql` | partial index on `signals(observed_at) WHERE period_start IS NULL`; backfilled `poller.last_ok` rows | bounds the retention sweep and `/health` reads |
| `0005_signal_latest_fk_index.sql` | index on `signal_latest(signal_id)` | the cascade lookup on every retention delete was a full scan |

Every row write has a cost on D1; a migration that adds an index over `signals` writes one row per existing row ([ADR-007](docs/adr/007-d1-row-write-budget.md)).

### 2.2 Two metric semantics — the one subtlety that matters

- **State metrics** (`ci.status`, `deps.vuln_count`, `manifest.description_missing`): the *latest* signal per (entity, metric) is the truth. Dashboard shows latest; history is a bonus.
- **Interval metrics** (`spend.usd`, `usage.invocations`): each signal covers a `period_start..period_end` window and the truth is a **sum over windows**. Never show "latest" for spend — always an aggregation.

Same table, different queries. Pollers declare which semantics each metric uses (see interface) so the UI can render correctly without per-metric special-casing.

### 2.3 Idempotency

Pollers run on cron and must be safe to re-run. `dedupe_key` makes inserts idempotent via `INSERT OR REPLACE` / upsert:

- State metrics: `dedupe_key = observed_at` bucketed to the poll granularity (or the upstream event id, e.g. Actions run id, Dependabot alert number — preferred when available).
- Interval metrics: `dedupe_key = period_start` (re-polling the same day's spend overwrites, not duplicates — this also handles Anthropic's usage data settling over a few hours).

### 2.4 Categories (project buckets)

`category` groups entities into portfolio buckets: **static_site**, **web_app**, **plugin_skill**, **tooling** (templates, libraries, experiments — nothing is demanded of them) and **client_project** (mixed shapes; per-repo expectations don't generalise). It is *not* `kind` — the GitHub poller sees every project as `repo`; category is classification the API can't infer.

- **Source of truth: GitHub repo topics.** The map is `TOPIC_CATEGORY` in `src/config.ts` (`static-site`, `web-app`, `mcp`, `skill`, `claude-plugin`, `claude-code-plugin`, `tool`, `template`, `client`). The GraphQL query returns topics anyway; the poller maps topic → category, and the map's empty-state hints name the same topics, so a topic added to the config is both accepted and taught. Classification lives in the system of record, not Ops config. Untagged repos land in an `uncategorized` bucket — itself a hygiene finding (`hygiene.uncategorized`).
- Non-repo entities (api_key, vendor_api, manifest-derived skills) get category from their poller directly.
- **Expected metrics per category** (`EXPECTED_METRICS` in `src/config.ts`): `static_site → [lhci.performance]`, `web_app → [ci.status, deps.vuln_count]`, `plugin_skill → [audit.finding_count]`. Only metrics a poller *in this deployment* can provide belong in the map — v0.1 listed `usage.invocations` and `manifest.description` for skills, and every skill repo collected a phantom finding for data nobody emitted. After each poll cycle, core emits a severity-1 `hygiene.missing.<metric>` signal for any entity lacking a latest signal for an expected metric (the v0.1 packed name `hygiene.missing_metric` is still read for old rows). Absence becomes queryable — a static site with no Lighthouse data surfaces in triage instead of being invisible.
- Two more hygiene checks run in the same pass: `hygiene.inactive` (no push for 90 days, severity 1) and `hygiene.uncategorized` above.

## 3. Poller interface

Directory convention, no registry. One file per poller in `src/pollers/`, exported and listed in a static array in `src/pollers/index.ts`. That array is the "plugin system."

```ts
// src/pollers/types.ts (abridged; the file is the contract, this is the shape)
export type Kind = "repo" | "plugin" | "skill" | "vendor_api" | "api_key" | (string & {});

export interface EntityUpsert {
  id: string;            // "{kind}:{natural_key}" — poller is responsible for stable natural keys
  kind: Kind;
  category?: string;     // §2.4: repos from topic mapping, other kinds from their poller
  name: string;
  owner?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  archived?: true;       // one-way: pollers may set it, never clear it (unarchiving is a human act)
}

export interface SignalInsert {
  entityId: string;
  metric: string;        // namespaced: "<domain>.<name>"
  valueNum?: number;
  valueText?: string;
  severity?: 0 | 1 | 2 | 3 | 4;   // default 0
  url?: string;
  observedAt: number;    // epoch seconds — when the condition was true, not when polled
  period?: { start: number; end: number };  // interval metrics only
  dedupeKey: string;
}

export interface PollerResult {
  entities: EntityUpsert[];
  signals: SignalInsert[];
  notes?: string[];      // non-fatal coverage caveats ("monitoring 25 of 31 sites"); no silent caps
}

export interface PollerCtx {
  since?: number;
  listEntities(kind?: Kind): Promise<KnownEntity[]>;  // read-only view of what other pollers found
}

export interface Poller {
  id: string;                                    // "github", "anthropic_usage", …
  metricSemantics: Record<string, "state" | "interval">;  // every metric this poller emits
  schedule: "hourly" | "daily";                  // core maps this onto cron triggers
  poll(env: Env, ctx: PollerCtx): Promise<PollerResult>;
}
```

Three additions since v0.1, each earned by a poller that needed it: `category` and `archived` on the upsert (the interface had omitted the field §2.4 depends on), `notes` on the result (the uptime poller caps its targets and has to say so), and `listEntities` on the context (uptime derives its target list from the homepages `github` recorded; judge keeps its working state in its own `poller:judge` entity's metadata and reads it back the same way — [ADR-006](docs/adr/006-advisory-judge-signals.md)). Writing stays core-only.

**Unconfigured is not failed.** A poller whose credential is absent throws `new Error("unconfigured: set the X secret to enable this poller")`. The runner recognises the prefix and records a calm severity-1 state on `/health` instead of a failure, so a fresh deployment with only `GITHUB_PAT` does not trip the degradation banner.

Core responsibilities (pollers never touch D1 directly):
- Upsert entities, bumping `last_seen_at` for every entity in the result; coalesce a missing `metadata` so a status-only upsert cannot clobber a poller's stored state.
- Idempotent signal insert keyed on `(entity_id, metric, dedupe_key)`, refreshing the `signal_latest` pointer in the same batch ([ADR-005](docs/adr/005-signal-latest-pointer.md)). `insertSignals` is the only write path; raw `INSERT INTO signals` is out of bounds.
- Per-poller error isolation: one poller throwing must not block others; failures are themselves recorded as signals on a synthetic `poller:{id}` entity (`poller.status`, severity 3; `poller.last_ok` moves only on success) — Ops monitors itself with its own machinery. A failed status write goes to the Worker log rather than aborting the loop ([ADR-007](docs/adr/007-d1-row-write-budget.md)).
- After every poll cycle, the derive pass (`src/core/derive.ts`) evaluates `budgets` and emits threshold-crossing signals (severity 2 soft / 4 hard) attributed to the budget's scope, the spend anomaly check (§4.2), the hygiene checks (§2.4), and push notifications for new or escalated severity ≥ 3 findings.
- Once a day, before the pollers, the retention sweep (`src/core/retention.ts`) compacts state rows older than 30 days to one per (entity, metric, UTC day). It is the one sanctioned deleter ([ADR-002](docs/adr/002-append-only-signals.md)).

### 3.1 Reference pollers (public repo)

The README's *Bundled pollers* table is the maintained list (schedule, credentials, metrics). The rule for what belongs here is [ADR-004](docs/adr/004-public-shell-private-config.md)'s: a poller ships in the public repo when its target is deployment config (a var or secret), not a private resource named in code. `manifests`, classified work-only in v0.1, moved under that rule on 2026-08-13; it reads whatever `MARKETPLACE_REPO` names and is dormant when the var is unset.

| Poller | Kind(s) | Notes |
|---|---|---|
| `github` | repo | One GraphQL query per owner; fine-grained PAT per owner (`GITHUB_PAT_<OWNER>`, fallback `GITHUB_PAT`); topics → category (§2.4); issue and PR cards for the board; docs health score |
| `uptime` | repo | Targets are the homepages `github` recorded; capped at 25 per run and says so in `notes` |
| `anthropic_usage`, `claude_code`, `openai_costs`, `x_usage` | vendor_api | Admin/usage APIs; daily interval signals dedupe on `period_start` (§2.3) |
| `cloudflare` | account | Worker request/error rates, D1 size, and the D1 row read/write allowance watchers ([ADR-007](docs/adr/007-d1-row-write-budget.md)) |
| `manifests` | plugin, skill | Claude Code plugin marketplace inventory |
| `judge` | repo | Advisory issue tiering; every metric pinned at severity 0 ([ADR-006](docs/adr/006-advisory-judge-signals.md)); runs last |
| `ci_ingest` | any | Not a poller — the `POST /ingest` endpoint, bearer-token auth, same `SignalInsert` shape, unknown fields rejected with `400`. Repos push `lhci.*`, `tests.*`, `audit.*`, `eval.*` as a final CI step. |

Still work-only and still private: `skill_usage` (invocation counts, interval) and any poller that names an internal resource in code.

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
- **Cross-cutting**: `/findings` — all latest signals with `severity >= min_severity` (default 2), plus every `ADVISORY_DOMAINS` hit (`audit.*`, `judge.*`) at any severity, plus `hygiene.*` at severity > 0 (a hygiene check that passes is not a finding), across every entity, sorted by severity then recency. This is the "audit view"; it is a filter, and adding a new audit source (SEO, content, npm) is just a new poller/ingest metric — the view picks it up with zero changes. The same rows fold into an entity × domain heatmap (`?view=heat`) and, at issue and PR granularity, into the derived board (`/board`).

## 5. Cron & config

- `scheduled` handler fans out by `poller.schedule` across three crons in `wrangler.jsonc`: hourly (`github`, `uptime`), daily at 10:00 UTC (retention sweep first, then every daily poller, `judge` last so an advisory poller can only starve itself — ADR-006), and Fridays at 12:00 UTC (no pollers; pushes the 7-day digest through ntfy). `limits.subrequests` is declared explicitly because the daily invocation runs every daily poller in one go.
- Config: non-secret vars in `wrangler.jsonc` (`GITHUB_OWNERS`, `OPS_URL`, `CF_ACCOUNT_ID`, `MARKETPLACE_REPO`, `JUDGE_*`, `D1_ROW_*_PER_DAY`, `ACCESS_*`); secrets via `wrangler secret put`, all optional. The README's *Configuration* section is the maintained list. Budgets, balances and triage weights are edited on `/settings`; the archive toggle lives on the entity page. Those and nothing else are writes to Ops-owned data ([ADR-001](docs/adr/001-read-mostly-system-of-record.md)).
- Auth: Cloudflare Access in front of the whole Worker; Ops has no login of its own. Defense in depth inside the app: the `Cf-Access-Jwt-Assertion` is verified in the Worker when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set (RS256 only; `aud`, `iss`, expiry — `src/core/access.ts`); every state-mutating `POST` requires a same-origin `Origin` header; `POST /ingest` and `GET /digest/md` are the only routes exempt from both, each behind its own bearer token compared in constant time.

## 6. Build order

The v0.1 sequence, kept for the record. Phases 0–5 shipped on 2026-08-04 (public release 2026-08-13, #13); phase 6 is open as [#3](https://github.com/chrispezza/ops/issues/3) and deferred until a second deployment exists.

1. Schema + core (entity upsert, idempotent signal insert, poller runner with error isolation). **This PR defines the contract; everything after is additive.** — shipped
2. `github` poller + inventory view. Usable day one. — shipped
3. Triage view + scoring. — shipped; folded into the map as `?view=priority` on 2026-09-23
4. `anthropic_usage` poller + budgets + spend view. — shipped
5. `/ingest` endpoint + one repo's CI wired to it. — shipped
6. Work deployment: private repo importing the public package, work pollers only. — open (#3)

## 7. Architecture decision records

The seeds below became [docs/adr/](docs/adr/); three more were written as the system met production.

- [ADR-001](docs/adr/001-read-mostly-system-of-record.md): GitHub (etc.) remains system of record; Ops is read-mostly. Only write affordance = pre-filled deep links.
- [ADR-002](docs/adr/002-append-only-signals.md): Append-only signals with query-derived state; two metric semantics (state/interval) declared by pollers.
- [ADR-003](docs/adr/003-static-poller-array.md): Static poller array over dynamic registry until ≥3 deployments diverge.
- [ADR-004](docs/adr/004-public-shell-private-config.md): Public shell / private config split; work pollers never upstream.
- [ADR-005](docs/adr/005-signal-latest-pointer.md): `signal_latest` pointer table maintained in the write path, so current-state reads stop scaling with history.
- [ADR-006](docs/adr/006-advisory-judge-signals.md): `judge.*` signals are advisory model output, pinned at severity 0, graded against a reference chain.
- [ADR-007](docs/adr/007-d1-row-write-budget.md): the D1 row-write budget — what a signal costs, and why the account moved to Workers Paid.
