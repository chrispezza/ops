# Metric catalogue

Every metric Ops stores, where it comes from, what the value means and how it
earns a severity. This is the reference for the extension point CLAUDE.md
describes: a signal with a brand-new domain shows up on `/findings` with zero
view changes, and this file is where a new domain gets written down.

`test/metrics-doc.test.ts` fails when a poller declares a metric in its
`metricSemantics` (or `src/config.ts` labels one) that this file does not
mention, so the catalogue cannot silently fall behind the code.

## How to read the tables

- **Semantics** is `state` (the latest row per entity and metric is the truth)
  or `interval` (each row covers `period_start..period_end` and the truth is a
  sum over windows). Declared per metric by the emitting poller
  ([ADR-002](adr/002-append-only-signals.md)).
- **Severity** is `0` ok · `1` low · `2` medium · `3` high · `4` critical.
  A state metric resolves when a newer row lands at a lower severity; there is
  no separate "resolved" write. Fixed-dedupe rows (one row per entity that is
  overwritten in place) resolve the same way, by being re-observed at 0.
- **Dedupe** is what makes a re-run idempotent
  (`UNIQUE(entity_id, metric, dedupe_key)`). *hour* and *day* mean the
  observation time bucketed to that granularity; *fixed* means one row per
  entity, overwritten in place; an upstream id (run id, commit oid, tag) is
  preferred where one exists.
- Severity ≥ 3 triggers a push notification (`NTFY_URL`); severity ≥ 2 counts
  in the digest's raised/resolved sections and the triage score's breadth term;
  severity > 0 feeds the triage score (`src/core/score.ts`). Advisory domains
  are visible on `/findings` at any severity (`ADVISORY_DOMAINS`: `audit`,
  `judge`); `hygiene.*` shows there at severity > 0 only.

Metric names match `^[a-z0-9_]+\.[a-z0-9_.]+$`; the prefix is the domain and
groups rows on the entity page (`DOMAIN_LABELS`) and the heatmap.

## `github` poller — hourly, one GraphQL query per owner

Entity: `repo:{owner}/{name}`, category from repo topics (spec §2.4).

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `ci.status` | state | text: `success` / `failure` / `error` / `pending`, from the default branch HEAD's check rollup (or the merged PR head when `main` itself carries no checks, #88) | 3 on `failure` or `error`, else 0 | HEAD commit oid |
| `ci.duration_ms` | state | wall time of the latest default-branch workflow run | 0 | run id |
| `ci.fail_streak` | state | consecutive failed runs on the default branch | 2 at ≥ 3 (chronic); the current break is already 3 via `ci.status` | hour |
| `deps.vuln_count` | state | open Dependabot alerts; text breaks down critical / high / moderate-low | 3 if any critical, 2 if any high or grading unavailable, 1 otherwise, 0 at none | hour |
| `issues.open` | state | open issue count | 1 at ≥ 10 (backlog pressure) | hour |
| `issues.new_7d` | state | issues opened in the last 7 days | 0 | hour |
| `issues.idle_90d` | state | open issues not updated for 90 days | 2 at ≥ 5, 1 at ≥ 1 | hour |
| `issues.oldest_days` | state | age of the oldest open issue | 0 | hour |
| `issues.flagged` | state | open issues carrying a severity label; text names the worst | the worst label: `P0`/`critical` 3, `P1` 2, `P2` 1, `P3` 0 (`LABEL_SEVERITY`); `bug` and `security` are type labels and carry none | hour |
| `issues.cards` | state | JSON: the labelled issues as board cards (number, title, label, dates) | 0 — the finding is `issues.flagged`; this row is presentation data | hour |
| `issues.closed_7d` | state | issues closed in the trailing 7 days (board velocity) | 0 | hour |
| `prs.open` | state | open PR count | 0 | hour |
| `prs.oldest_days` | state | age of the oldest open *human* PR (Dependabot excluded) | 2 at ≥ 30 d, 1 at ≥ 14 d | hour |
| `prs.dependabot_count` | state | open Dependabot PRs; text gives the oldest's age | 1 when the oldest is ≥ 30 d | hour |
| `prs.dependabot_major` | state | open Dependabot PRs that are major version bumps | 1 if any | hour |
| `prs.cards` | state | JSON: open PRs as board cards | 0 | hour |
| `prs.merged_7d` | state | PRs merged in the trailing 7 days (board velocity) | 0 | hour |
| `repo.pushed_at` | state | epoch of the last push; the triage staleness term reads this, not `last_seen_at` | 0 | hour |
| `repo.branches` | state | branch count | 0 | hour |
| `release.age_days` | state | days since the latest release; text is the tag | 0 | release tag (age updates in place) |
| `docs.score` | state | 0–100, equal-weight checks: README ≥ 200 bytes, description set, CLAUDE.md present, and a license on public repos; text names what is missing | 1 below 100 | hour |

Issue and PR pages are capped (`ISSUE_PAGE` 30, `PR_PAGE` 20, `VELOCITY_PAGE`
20 per repo); #80 tracks labelled issues beyond the first page.

## `uptime` poller — hourly

Entity: the `repo:` entities whose GitHub *Website* field is set (read back
through `listEntities`). Capped at `MAX_TARGETS` (25) per run; the cap is
reported in `notes` and shows on `/health`.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `site.up` | state | 1 / 0; text `up` / `down` | 3 when down | hour |
| `site.response_ms` | state | time to first response; only emitted when up | 0 | hour |

## Vendor spend pollers — daily

`anthropic_usage` (`vendor_api:anthropic`), `claude_code`
(`vendor_api:claude_code`), `openai_costs` (`vendor_api:openai`). Each reads
the vendor's admin cost report and emits one row per UTC day.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `spend.usd` | interval | dollars spent in the period | 0 — budgets and anomalies are derived below | `period_start` (re-polling a settling day overwrites) |
| `usage.tokens_in`, `usage.tokens_out` | interval | tokens per day (`anthropic_usage`) | 0 | `period_start` |
| `usage.sessions`, `usage.loc_added`, `usage.commits` | interval | Claude Code sessions, lines added, commits per day (`claude_code`) | 0 | `period_start` |

## `x_usage` poller — daily

Entity: `vendor_api:x`.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `usage.monthly_posts` | state | posts used this month; text `n of cap` | 0 | day |
| `usage.cap_pct` | state | percent of the monthly post cap used | 3 at ≥ 95 %, 2 at ≥ 80 % (near-cap is what breaks integrations) | day |

## `cloudflare` poller — daily

Entities: `worker:{script}` per Worker script, `d1:{name}` per database, and
`cf:account` for the account-wide allowance watchers. Needs
`CLOUDFLARE_API_TOKEN` (Account Analytics:Read + D1:Read) and `CF_ACCOUNT_ID`.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `cf.requests`, `cf.errors` | interval | per Worker per UTC day | 0 | `period_start` |
| `cf.error_rate` | state | percent, rated over the last *complete* day (or the whole window when that day is thin); re-emitted every run so a stale value never stands | 3 above 5 %, 2 above 1 %, 0 when the sample is thin | day |
| `d1.size_bytes` | state | database size | 0 | day |
| `d1.rows_read`, `d1.rows_written` | interval | per database per UTC day, from `d1AnalyticsAdaptiveGroups` (exact, unlike `wrangler d1 insights`) | 0 | `period_start` |
| `d1.read_cap_pct`, `d1.write_cap_pct` | state | today's running account-wide total as a percent of the daily allowance (`D1_ROW_READS_PER_DAY` / `D1_ROW_WRITES_PER_DAY`, empty = Workers Free caps); text carries the per-database split | 3 at ≥ 100 %, 2 at ≥ 80 % ([ADR-007](adr/007-d1-row-write-budget.md)) | day |

## `manifests` poller — daily

Entities: `plugin:{name}` and `skill:{plugin}:{skill}` read from the
`MARKETPLACE_REPO` marketplace; dormant when the var is unset.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `manifest.description` | state | whether the plugin manifest has a description | 1 when missing | fixed |
| `manifest.skill_count` | state | skills the plugin bundles | 0 | fixed |

## `judge` poller — daily, advisory ([ADR-006](adr/006-advisory-judge-signals.md))

Entity: `repo:` entities with open, unlabelled issues. Every metric in this
domain is **pinned at severity 0**: it is model output, visible on `/findings`
and the entity page and nowhere else, and deleting the domain must change no
other number. `JUDGE_SCOPE` bounds what issue text leaves the deployment.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `judge.issue_tier` | state | count of outstanding proposals (untiered issues the judge thinks need a label); text lists up to five as `#n title (confidence) label` | 0 always | day |
| `judge.tier_agreement` | state | percent of a blind sample where the judge matched the *reference tier* (the maintainer's label, else a `JUDGE_REFERENCE_ACTORS` label); text carries the sample size and its human/reference split | 0 always | day |
| `judge.tier_agreement_human` | state | the same against human-applied labels only | 0 always | day |
| `judge.reference_agreement` | state | of the reference actor's tiers a human reviewed (overrode, or accepted with `triaged`), the percent that stood | 0 always | day |

An empty sample is reported as such in the text rather than as 0 %.

## Derived by core — every poll cycle (`src/core/derive.ts`)

Source is `core`; none of these come from a poller. All are fixed-dedupe rows
re-observed each pass, so "latest" always reflects the current pass.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `budget.status` | state | month- or day-to-date spend against a `budgets` row, attributed to the budget's scope | 4 at the hard limit, 2 at the soft limit | period start |
| `balance.usd` | state | remaining prepaid balance (starting balance minus `spend.usd` since `as_of`); text `$remaining of $starting` | 3 when ≤ 0, 2 when under 20 % remains | fixed |
| `spend.anomaly` | state | today's spend against the trailing-7-day median (spec §4.2) | 2 when today > 3 × median, else 0 | fixed |
| `hygiene.missing.<metric>` | state | one row per expected metric the entity has never reported (`EXPECTED_METRICS` by category); text is the metric | 1 when missing, 0 once present | fixed |
| `hygiene.uncategorized` | state | whether the repo carries a category topic; text is the category or `no topic` | 1 when untagged | fixed |
| `hygiene.inactive` | state | days since the last push; text `no pushes for Nd` or `active` | 2 at ≥ 180 d, 1 at ≥ 90 d | fixed |

`hygiene.missing_metric` is the v0.1 packed name for the missing-metric row;
old rows are still read and reconciled but nothing emits it.

## Recorded by the runner — every poller run (`src/core/runner.ts`)

Entity: `poller:{id}`, one per poller. Ops monitors itself with its own
machinery.

| Metric | Semantics | Value | Severity | Dedupe |
|---|---|---|---|---|
| `poller.status` | state | JSON run summary (ok, duration, counts, error, notes); `value_num` is the duration | 3 on failure; 1 when unconfigured (`unconfigured:` error prefix) or when the run succeeded with coverage `notes`; 0 otherwise | run time |
| `poller.last_ok` | state | copy of the last successful run's status row | 0 | fixed — moves only on success, so `/health` reads the last success in one pointer lookup |

## Pushed through `POST /ingest` — by CI, not polled

Any metric may arrive this way; these are the ones the UI already knows how to
label, expect or chart. Severity is set by the sender (`0`–`4`, default 0).
Unknown fields are rejected with `400`. See the README's *Pushing signals from
CI* for the payload.

| Metric | Semantics | Value | Notes |
|---|---|---|---|
| `lhci.performance` | state | Lighthouse performance **0–100** (multiply lhci's 0–1 summary by 100) | expected for `static_site`; drawn as the map chip |
| `tests.coverage_pct` | state | percent | |
| `audit.vuln_count` | state | count from an `npm audit`-style pass | `audit.*` is advisory: visible on `/findings` at any severity |
| `audit.finding_count` | state | findings from `/skill-audit` | expected for `plugin_skill` |
| `eval.reproduction_pct`, `eval.false_positive_pct`, `eval.protocol_fidelity_pct` | state | `/skill-validate` scores | deliberately *not* expected — evals cover a chosen subset |
| `eval.age_days` | state | days since the eval ran | a green score against a since-rewritten skill proves nothing; staleness has to sit next to it |
| `usage.invocations` | state | 30-day invocation count for a skill | **reserved**: labelled and scored (the zero-usage bonus) but no poller or pipeline emits it yet; the work-phase `skill_usage` poller will |

## Adding a metric

1. Pick `domain.name`. A new domain needs nothing else to appear on
   `/findings`; a label in `METRIC_LABELS` and a domain heading in
   `DOMAIN_LABELS` make it read well on the entity page.
2. If a poller emits it, list it in that poller's `metricSemantics` — that
   declaration is how views know whether to show the latest row or a sum
   (ADR-002), and CLAUDE.md makes it a contract rule — and decide the
   severity rule in the poller, with a comment saying why the thresholds are
   what they are.
3. If a category should always have it, add it to `EXPECTED_METRICS`, but only
   when a poller *in this deployment* can provide it (spec §2.4).
4. Add a row here. The consistency test will remind you.
