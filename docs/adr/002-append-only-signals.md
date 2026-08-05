---
title: "ADR-002: Append-only signals with query-derived state and two metric semantics"
description: >-
  Observations are append-only rows; current state is always derived by query.
  Pollers declare each metric as state (latest wins) or interval (sum over
  period windows).
lastUpdated: 2026-08-04T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted

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
- Every "current state" read pays a window-function query.
- Signals table needs eventual pruning policy (not in v1).

## Validation

- **Contract tests**: idempotency, interval overwrite, and latest-derivation are covered in `test/core.test.ts`.

## References

- ops-spec.md §2.2–2.3; [ADR-003](003-static-poller-array.md)
