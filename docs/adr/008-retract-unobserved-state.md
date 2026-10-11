---
title: "ADR-008: A state metric its poller stops emitting is retracted, not kept"
description: >-
  When a poller that re-emits its state metrics every run sees an entity and
  emits nothing for a metric, the runner deletes that metric's latest pointer.
  History stays; no reader may treat an old row as current by default.
lastUpdated: 2026-10-11T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted. Amended 2026-10-11: a poller may name entities to retract (see the
amendment at the end).

## Context

ADR-002 derives current state as "the newest row per (entity, metric)", and
ADR-005 materialises that as `signal_latest`. Neither says what happens when a
metric simply stops arriving: the newest row stays the newest row forever.

Production, 2026-10-10 (issues #101, #102):

- gittunes-app dropped its push-to-main CI run on 2026-09-30. `ci.status`
  stopped being emitted, and the last row (`failure`, severity 3, for a commit
  fixed the same day) stayed on the board, in the triage score and in the
  agent hand-off for 10 days.
- tattler showed `ci.fail_streak` = 4 (severity 2) from 2026-09-27 while its
  CI passed.
- pezza-portfolio still had a `ci.status` pointer from 2026-08-12.

A stopped metric and a current one are indistinguishable to every reader, and
there are at least seven readers (map, board, `/findings`, entity page, score,
digest, notify).

## Decision Drivers

- **Failures must be visible, and so must their absence.** A finding that
  outlives its cause trains the reader to ignore findings.
- **One rule, enforced in one place.** Seven readers each remembering an age
  check is seven places to forget it.
- **Signals remain the truth** (ADR-002). Nothing is rewritten or deleted
  from history.
- **Not every old row is stale.** `repo.pushed_at`, `ci.duration_ms` and
  everything from `/ingest` carry event times on purpose; age alone cannot be
  the test.

## Considered Options

### Option 1: Read-side age predicate

Each reader ignores rows older than some multiple of the poll interval.

**Pros:** No write-path change; `signal_latest` stays a pure function of
`signals`.
**Cons:** Needs a per-metric notion of "expected cadence" that readers must
all apply; event-timed and ingest metrics need exemptions; seven call sites.

### Option 2: Tombstone rows

The runner appends a marker row for a metric that stopped.

**Pros:** Fully append-only; the retraction itself is in history.
**Cons:** Needs a marker every reader must recognise (a new column means a
migration, a sentinel value means seven call sites again), and writes nine
row-writes per retraction (ADR-007).

### Option 3: Delete the latest pointer

The runner removes the `signal_latest` row; `signals` is untouched.

**Pros:** Every reader is correct with no change, because all of them already
resolve "current" through the pointer. Costs writes only on a transition.
The metric returning re-creates the pointer through the normal write path.
**Cons:** `signal_latest` is no longer reproducible from `signals` alone
(ADR-005's backfill statement would resurrect retracted pointers). The
retraction is not itself recorded as a row.

## Decision

We will go with **Option 3**.

1. A poller opts in with `retractUnobserved: true`. Doing so is a promise:
   on every run it emits every `state` metric for every entity the metric is
   true of. A poller that covers a subset of its entities per run (judge) or
   whose metrics describe events rather than conditions must not set it.
2. After a successful run of such a poller, for each entity it returned that
   is not archived, the runner deletes the pointer of every `state` metric the
   poller declares in `metricSemantics` that it did not emit this run
   (`retractUnobserved` in `src/core/store.ts`).
3. Only pointers whose row was written by that poller (`signals.source`) are
   eligible. A metric pushed through `/ingest` under the same name is not the
   poller's to retract.
4. A failed run retracts nothing. An entity the poller did not return is not
   touched: "did not see the repo" is not "saw it and the condition is gone".
5. `hygiene.missing.*` asks whether an expected metric is *currently*
   reported (`signal_latest`), not whether it ever was.

Enabled for `github` only. Other pollers opt in one at a time, after checking
rule 1 against how they emit.

## Consequences

### Positive
- The map, board, findings, score, digest, notify and agent prompt stop
  showing a stopped metric, with no change to any of them.
- A web app that loses its CI is flagged `hygiene.missing.ci.status` again
  instead of showing its last result.
- The number of pointers dropped is on the run summary (`retracted`), so
  `/health` shows when it happens.

### Negative
- ADR-005's repair path changes: re-running the backfill statement restores
  retracted pointers until the next poll removes them again (one hour for
  `github`). ADR-005 is amended to say so.
- A retracted severity ≥ 2 finding does not appear under "resolved" in the
  digest (`resolvedInWindow` joins the pointer). It was not resolved, it
  stopped being observed; the digest says nothing rather than something wrong.
- A partial upstream failure that a poller swallows (github's run history
  returns an empty list on a non-200) retracts those metrics for one poll and
  restores them on the next. For `github` that is `ci.duration_ms` and
  `ci.fail_streak`, neither above severity 2, so no alert fires twice.
- Cost, *estimated* from the 976 pointers in production on 2026-10-10: one
  scan of `signal_latest` joined to `signals` per `github` run, about 2,000
  rows read per hour (under 50,000 a day). Writes only on a transition: one
  pointer delete, two row-writes with its index (migration 0005).

## Validation

- `test/retract.test.ts`: a stopped metric loses its pointer and keeps its
  history; metrics from another source, unseen entities, archived entities,
  interval metrics and non-opted-in pollers are untouched; a returning metric
  is current again; a failed run retracts nothing.
- `test/core.test.ts` (hygiene pass): an expected metric with history but no
  pointer is flagged missing.
- Production: after the first deploy, tattler's `ci.duration_ms` and
  pezza-portfolio's `ci.status` pointers are gone if those repos are still
  polled.

## References

- Issues #101, #102; [ADR-002](002-append-only-signals.md),
  [ADR-005](005-signal-latest-pointer.md), [ADR-007](007-d1-row-write-budget.md).
- `src/core/store.ts`, `src/core/runner.ts`, `src/core/derive.ts`,
  `src/pollers/types.ts`.

## Amendment: a poller may name entities to retract (2026-10-11)

Rule 1 made retraction a promise about every entity a poller returns, which
the judge cannot make: it covers part of its repos per run, so "emitted
nothing" usually means "not reached tonight". When the `shelved` topic (#90)
took four repos out of the judge's scope for good, their `judge.*` pointers
had no way to go and stayed on `/findings` (#119).

What changed: `PollerResult.retract` is an optional list of entity ids the
poller has deliberately stopped covering. The runner passes them through the
same `retractUnobserved` in `src/core/store.ts`, so the rule is unchanged: only
`state` metrics, only rows this poller's source wrote, history untouched, the
count on the run summary. A poller can use it without setting
`retractUnobserved`.

What did not change: opting in with `retractUnobserved` still means every
returned entity; nothing is retracted on a failed run; and a poller must not
name an entity it merely failed to reach. Naming is for "out of scope", not
for "no data this time".

Validation: `test/retract.test.ts` (named entities lose their pointers on a
poller that has not opted in; unnamed ones keep theirs) and
`test/judge.test.ts` (a shelved repo is not read, not judged, and is named).
