---
title: "ADR-002: Append-only signals with query-derived state and two metric semantics"
description: >-
  Observations are append-only rows; current state is always derived by query.
  Pollers declare each metric as state (latest wins) or interval (sum over
  period windows).
lastUpdated: 2026-09-30T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted. Amended 2026-09-30: the "eventual pruning policy" exists; see the amendment below.

## Context

Ops stores heterogeneous observations: CI status, vuln counts, daily spend, usage counts. Some are point-in-time truths where only the latest matters; others are per-window quantities where the truth is an aggregation. A single mutable "current value" column would lose history and force per-metric special cases; separate tables per domain would make cross-cutting views (triage, findings) joins across N tables.

## Decision Drivers

- **Auditability**: the history feed is the audit trail.
- **Idempotent polling**: cron re-runs and settling upstream data (Anthropic usage) must not duplicate or corrupt.
- **One findings view**: new audit sources must appear with zero view changes.

## Considered Options

### Option 1: One append-only signals table, semantics declared by pollers

**Pros:** uniform ingestion and views; history for free; `UNIQUE(entity_id, metric, dedupe_key)` gives idempotency; interval overwrite handles settling data.
**Cons:** "latest per metric" needs a window-function query; table grows unboundedly (prunable later).

### Option 2: Mutable current-state table (+ optional history table)

**Pros:** trivial reads.
**Cons:** loses ordering/history or duplicates write paths; interval metrics don't fit a "current value" model at all.

## Decision

We will go with **Option 1**. Signals are append-only; the latest signal per (entity, metric) is derived by query for **state** metrics, and sums over `period_start` windows for **interval** metrics. Pollers declare each metric's semantics in `metricSemantics`. Implementation detail beyond the spec: `dedupe_key` is `NOT NULL` — SQLite treats NULLs as distinct in UNIQUE constraints, which would silently defeat idempotency.

## Consequences

### Positive
- Re-polling is always safe; settling data converges via same-key overwrite.
- Any new metric source is just rows; `/findings` and entity pages pick it up unchanged.

### Negative
- Every "current state" read pays a window-function query. *Superseded by [ADR-005](005-signal-latest-pointer.md): reads now resolve through the `signal_latest` pointer table.*
- Signals table needs eventual pruning policy (not in v1). *Delivered; see the amendment below.*

## Validation

- **Contract tests**: idempotency, interval overwrite, and latest-derivation are covered in `test/core.test.ts`.

## Amendment: retention compaction (2026-09-30, documenting `src/core/retention.ts` as shipped 2026-08-12)

Hourly-bucketed state metrics add about 2k rows a day (issue #4). Once a state row is older than **30 days**, the daily sweep keeps the newest row per (entity, metric, UTC day) and deletes the rest. Interval metrics (spend, usage) are untouched — they are already daily — and fixed-dedupe rows (hygiene, budget, balance) only ever have one row, so the sweep is a no-op for them by construction.

This is the one sanctioned deleter, and it does not renegotiate the decision: the newest row per (entity, metric) is by definition the newest of its day, so the current state is never touched and the `signal_latest` pointer (ADR-005) survives compaction by construction. History thins beyond 30 days; it does not end. The sweep runs first on the daily cron so it never queues behind a slow poller, and every row it deletes costs one row-write against the D1 allowance ([ADR-007](007-d1-row-write-budget.md), which weighed stopping it and kept it).

`test/maintenance.test.ts` covers the sweep, including that the pointer lands on the surviving row.

## References

- ops-spec.md §2.2–2.3; [ADR-003](003-static-poller-array.md); [ADR-005](005-signal-latest-pointer.md); [ADR-007](007-d1-row-write-budget.md)
