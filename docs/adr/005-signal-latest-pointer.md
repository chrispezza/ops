---
title: "ADR-005: Materialized latest-signal pointer (signal_latest)"
description: >-
  Current-state reads resolve through a pointer table maintained in the same
  transaction as every signal write, instead of window-function scans over the
  whole append-only signals table.
lastUpdated: 2026-09-02T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted

## Context

ADR-002 made signals append-only and derived "latest per (entity, metric)" by query. Every such read was `ROW_NUMBER() OVER (PARTITION BY entity_id, metric ORDER BY observed_at DESC, id DESC)` over the entire table — the map, findings, latest-by-metric, poller health and entity pages all paid it, and the cron paid it again through the derive pass. Cost scales with history length, not with the number of entities, and ADR-002 already listed it as the negative consequence.

Measured on 2026-09-02 (issue #42): ~200k rows read per request; 5–6M rows/day at ~30 requests, 40M on a day with 187. D1's free-tier row-read cap is 5M/day **per account**, so this database's growth took down unrelated projects' ability to migrate.

## Decision Drivers

- **Signals remain the truth** (ADR-002). No mutable current-value column, no second write path.
- **Reads proportional to entities × metrics**, not to history.
- **Correct for every writer** with no reliance on D1 features the docs don't promise (triggers).

## Considered Options

1. **Covering indexes only.** Window functions still visit every row; no help.
2. **Triggers maintaining a pointer table.** Correct by construction for any writer, but D1's SQL statement docs do not commit to trigger support, and a migration that fails on the remote database is the one failure mode we cannot afford here.
3. **Pointer table maintained in the write path (chosen).** `signal_latest(entity_id, metric) → signal_id, observed_at`, refreshed in the same `db.batch` as the signal rows in `insertSignals` — the single write path every poller, ingest and derive call already goes through.

## Decision

Option 3. `signal_latest` is an **index over signals**, not state: it holds a row id and the `observed_at` needed to compare candidates, nothing a reader displays. Rules:

- After each signal upsert, refresh the pointer from the row found by its `UNIQUE(entity_id, metric, dedupe_key)` key — two index seeks per signal regardless of history depth. The pointer advances when the row is newer (`observed_at`, then `id` as tie-break) or when it *is* the pointed row (a fixed-dedupe row re-observed in place, the hygiene/budget/balance pattern).
- `signal_id` cascades on delete. Retention (`compactSignals`) keeps the newest row per (entity, metric, day), so the overall newest row is never deleted and the pointer survives compaction by construction; the cascade exists for test resets and manual repair, not for the sweep.
- Readers that need a *filtered* latest (last successful poller run) still walk history, now confined to one metric's rows by a metric-leading index.
- Migration 0003 backfills the table with one final window scan.

## Consequences

### Positive
- Map, findings, entity pages and poller health read a few hundred rows instead of the whole table; the hourly cron no longer scales with history.
- No change to the poller contract, the ingest payload, or any view.

### Negative
- One accepted inexactness: if the *pointed* row is re-observed with an **older** `observed_at` under the same dedupe key, the pointer keeps it even if another row is now newer. Pollers observe forward in time, so this does not occur in practice; a re-run of the migration's backfill statement repairs it.
- Any future writer that bypasses `insertSignals` leaves the pointer stale. `insertSignals` is the contract; raw `INSERT INTO signals` is out of bounds.

## Validation

- `test/core.test.ts`: out-of-order inserts resolve to the newest row; in-place upsert advances the pointer; the backfill statement reproduces the pointer table from history.
- `test/maintenance.test.ts`: compaction leaves the pointer on the surviving row.
- Post-deploy: `d1AnalyticsAdaptiveGroups` rows read for `ops` at unchanged request volume.

## References

- Issue #42; [ADR-002](002-append-only-signals.md).
- `migrations/0003_signal_latest.sql`, `src/core/store.ts`, `src/core/queries.ts`.
