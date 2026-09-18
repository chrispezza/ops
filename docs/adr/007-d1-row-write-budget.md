---
title: "ADR-007: The D1 row-write budget"
description: >-
  Every signal costs nine row-writes; the free tier allows 100k a day and the
  hourly cadence spends 81% of it. Move to Workers Paid rather than trade
  history or indexes for headroom, and watch both allowances from the dashboard.
lastUpdated: 2026-09-18T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted. The account moved to Workers Paid on 2026-09-18, the same day as
the incident below.

## Context

On 2026-09-18 at 01:00 UTC migrations 0004 and 0005 were applied to production.
0004's partial index over `signals(observed_at) WHERE period_start IS NULL`
materialised one entry per existing state row — 117,983 of them — and D1 bills
each as a row written. The account's free-tier allowance is 100,000 rows written
per day. From the 02:00 cron on, every `insertSignals` batch was refused, and
because the poller's own status row is written by the same path, the failure
never reached `/health`: the freshness chip kept showing the last success while
nothing was being stored.

That was the one-off. The steady state turned out to be the real finding: the
write side of D1's pricing had never been examined, and the hourly cadence alone
sits at roughly four fifths of the allowance.

Every number below is from production unless marked *estimated*. Daily and
hourly totals come from Cloudflare's `d1AnalyticsAdaptiveGroups`; per-statement
costs were measured in workerd against the real migrations (`meta.rows_written`,
same SQLite engine D1 runs; the per-query averages D1 reports agree).

### What a signal costs

| Statement | Rows written | Why |
|---|---|---|
| `INSERT` a new `signals` row | **7** | the row, five index entries (UNIQUE, entity, severity, metric, observed_state), and `sqlite_sequence` for `AUTOINCREMENT` |
| Upsert an existing row (fixed dedupe key, `observed_at` moves) | **6** | the row plus the four indexes that carry `observed_at`; a no-op upsert with nothing changed also costs 6 — SQLite rewrites regardless |
| `signal_latest` new pointer | **4** | row, PK, metric index, `signal_id` index |
| `signal_latest` pointer move | **2** | row plus the `signal_id` index (0005); it was 1 before 0005 |
| Entity upsert | **1** | |
| Retention `DELETE`, per row | **1** | D1 counts a delete as one row whatever the index count |
| New `signals` row without `idx_signals_entity` and `idx_signals_severity` | 5 | for option B below |

So an hourly-bucketed state metric — a new row every hour, pointer moved every
hour — costs **9 rows written per observation** after 0005 (7 + 2), 8 before.

### Where the day goes

The hourly cron writes **2,923–2,927 rows** per hour (measured across every
hour of 2026-09-14 and the 00:00 hour of 2026-09-18, the last before the cap
and both before 0005 took effect). On 2026-09-14, the last clean full day,
**7,350 state rows** landed across **328 series** — 306 per hour — and the
day totalled **74,059 rows written**.

| Writer | Per day | Basis |
|---|---|---|
| `github` (292 hourly series × 9) | ~63k | *estimated* from the 09-17 series count × unit cost; matches the hourly total within 10% |
| derive pass (budget, hygiene, balance: fixed-dedupe upserts) | ~2.5k | *estimated*, 13 series × 24 × 8 |
| `uptime` (14 series × 9 × 24) | ~3k | *estimated* |
| `core` (poller status + `last_ok`) | ~1k | *estimated* |
| daily pollers (cloudflare, manifests, anthropic_usage, judge) | <1k | measured: 10:00 hour minus the hourly baseline minus the sweep |
| retention sweep | ~2.8–3.0k | measured: 2,819 rows in the next day-slice; the 10:00 hour on 09-18, with pollers refused, wrote 3,063 |
| 0005's `signal_id` index, from now on | +7.3k | *estimated*: 306 pointer moves/hour × 1 |
| **Steady state after 0005** | **~81k / 100k** | *estimated*; today's hours are refused, so it cannot be measured until tomorrow |

Growth is linear in series: each repo the github poller tracks adds ~14 hourly
metrics, about **3k rows a day**. The remaining headroom is roughly six repos.
And a migration that adds an index over `signals` costs one row per existing
row — 118k today — which on the free tier is a guaranteed outage day.

## Decision Drivers

- **ADR-002 and ADR-005 hold.** Signals stay append-only; the pointer table
  stays maintained in the same batch. Neither is renegotiated here.
- **Freshness is read from `observed_at`.** `/health`, the freshness chip and
  `issues.idle_90d`-style staleness all depend on it moving forward every
  observation. An option that stops moving it has to say what that breaks.
- **The failure has to be visible.** A cap that trips silently is worse than
  the cap.
- **Engineering time is the expensive input.** Three D1-allowance outages in
  sixteen days (09-02 reads, 09-12→17 reads, 09-18 writes) each cost a day.

## Considered Options

### A. Skip the upsert when only `observed_at` changed; skip the same-row `signal_latest` refresh

Only fixed-dedupe rows take the upsert path — `poller.last_ok`, hygiene,
budget, balance — about 13 series. Hourly metrics use an hour-bucket key and
are fresh inserts, which this option does not touch. Ceiling on savings:
13 × 24 × (6 + 2) ≈ **2.5k/day, ~3%**. And `last_ok.observed_at` *is* what
`/health` reads for "last success": stop moving it and every poller reads as
stale after its first run. Rejected on both counts.

### B. Drop redundant indexes on `signals`

`idx_signals_entity (entity_id, metric, observed_at DESC)` is redundant with
`idx_signals_metric (metric, entity_id, observed_at DESC)` for every query that
names both entity and metric — which is all of them except `signalHistory`
(entity page, paginated) and `trendSeries` (entity page sparklines). Those fall
back to the UNIQUE autoindex's `entity_id` prefix: `trendSeries` already reads
every row of the entity, so it is unchanged; `signalHistory` would read all of
an entity's rows (≤ ~10k) per page view instead of 50. Saves 1 per insert and
1 per upsert: **~7.6k/day, 7.5%**.

`idx_signals_severity (severity, observed_at DESC)` serves the digest's
`resolvedInWindow` and the hygiene scan in derive. Without it the digest's
resolved section is a full-table scan (~118k reads per render). Another
~7.6k/day.

Both together: 81k → **~66k/day**, buying about five repos of headroom, at the
price of two read regressions on rarely-viewed pages, and it does nothing about
the next index migration. Measured, real, and the best *free-tier* option — but
it spends design margin to stay under an arbitrary line.

### C. Stop the retention sweep

The sweep deletes ~2.8k rows a day at one row-write each — **~3.5%** of the
allowance. It is what keeps the table at ~118k rows instead of growing 220k a
month, and every full scan (the two in option B, the sweep's own SELECT, the
hygiene LIKE scan) is priced in reads proportional to that size. It earns its
cost. Keep it.

### D. Workers Paid, code unchanged

$5/month. D1 on Workers Paid includes **50M rows written and 25B rows read per
month**; Ops writes ~2.5M and reads ~150M a month. Both caps that produced the
three outages disappear with twenty times headroom, index migrations stop being
outage days, and no history, index or freshness semantics are traded.

## Decision

**Option D.** The engineering already spent on the free tier's read allowance
was worth it — those were real amplification bugs (ADR-005, 0004, 0005) and the
dashboard is faster for them. The write side is different: the cost is the
design, not a bug. Nine rows per observation is what append-only signals with
five indexes and a pointer table cost, and the honest ways to cut it (B) buy
months, not a fix. Five dollars a month is less than an hour of the time each
outage has taken.

Two things ship regardless of the plan, because the cap being invisible was
the worse half of the incident:

1. `d1.write_cap_pct` on the `cf:account` entity, judged like `read_cap_pct`
   (severity 2 at 80%, 3 at 100%) with the per-database split in the text.
2. The runner no longer lets a failed status write abort the loop. When
   storage is what failed, the status row fails the same way; it now goes to
   the Worker log and the remaining pollers and the derive pass still run.

If the plan is *not* changed, option B — dropping `idx_signals_entity` alone —
is the fallback to take, as its own migration with the read regression on
`signalHistory` stated in the PR.

## Consequences

- The watcher's denominators are vars (`D1_ROW_READS_PER_DAY`,
  `D1_ROW_WRITES_PER_DAY`, ADR-004), empty meaning the free-tier daily caps.
  Workers Paid meters per month, so this deployment sets the monthly figures
  ÷ 30: a daily pace at which the month stays inside the allowance, not a
  hard cut-off. At ~81k writes a day against 1.66M the watcher will sit near
  5% — it stays because the next index migration or the next twenty repos
  should still be visible before they matter.
- Any migration that adds an index or a column to `signals` states its
  row-write cost in the PR (one per existing row; `SELECT COUNT(*)` on the
  affected rows). On the free tier it is applied right after 00:00 UTC with
  nothing else that day. CLAUDE.md carries the rule.
- Today's outage cleared with the plan change; nothing stored between 01:01
  UTC and the upgrade is recoverable, and the digest for that window will
  show the gap.
- The `AUTOINCREMENT` on `signals.id` costs one row per insert for
  `sqlite_sequence`. It is there so ids are never reused after the sweep
  deletes rows — `signal_latest` points by id and `insertWatermark` orders by
  it — so it stays.
