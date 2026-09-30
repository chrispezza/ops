---
title: "ADR-001: Ops is read-mostly; external systems remain the record"
description: >-
  GitHub and other upstream systems remain the system of record. Ops only
  aggregates and deep-links; its sole write-shaped affordance is a pre-filled
  new-issue link.
lastUpdated: 2026-09-30T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted. Amended 2026-09-30: the list of Ops-owned writes grew by two; see the amendment below.

## Context

Ops aggregates state from many systems (GitHub, Anthropic Admin API, CI pipelines). Any dashboard that also *acts* on those systems must handle write auth, conflict resolution, and failure modes for every integration — and its copy of state competes with the real one.

## Decision Drivers

- **Single maintainer**: every write path is ongoing operational surface.
- **Trust**: numbers you can't act on wrongly are numbers you can trust.
- **Security**: read-only PATs/API keys are a strictly smaller blast radius.

## Considered Options

### Option 1: Read-mostly aggregation with deep links

**Pros:** minimal auth scopes, no sync conflicts, small attack surface.
**Cons:** acting on a finding requires a context switch to the source system.

### Option 2: Two-way integration (act from the dashboard)

**Pros:** fewer clicks per action.
**Cons:** write-scope credentials, per-integration write APIs, state drift, large maintenance burden.

## Decision

We will go with **Option 1**. Every finding deep-links to the system of record; the only write-shaped affordance is a pre-filled GitHub new-issue URL, which is itself just a link. The only writes to Ops-owned data are budgets and triage weights on `/settings`.

## Consequences

### Positive
- All external credentials are read-only.
- No sync or conflict logic anywhere in the codebase.

### Negative
- Acting on findings always costs a navigation hop.

## Validation

- **Scope audit**: all configured tokens remain read-only.
- **Usage**: triage rows resolve via their deep links without requests for in-app actions.

## Amendment: the complete list of Ops-owned writes (2026-09-30)

The Decision named budgets and triage weights as the only writes to Ops-owned data. Two more have shipped since, both of the same shape — a human editing Ops's own presentation state, never an upstream:

- **Vendor balances** (`POST /settings/balances`, 2026-08-17, #29): a prepaid balance to draw spend against, so the spend page has a denominator. Stored in `settings`, never sent anywhere.
- **The archive toggle** (`POST /archive` on the entity page): hides an entity from the map, the priority list, notifications and the digest. It is the one Ops-owned *entity* mutation. A poller may set `archived` when the upstream repo is archived, but never clears it — unarchiving is a human act, so a poll cannot clobber a manual "Archive in Ops".

The rule that survives: Ops-owned writes edit how Ops *presents* what it read; none of them reaches a system of record. The pre-filled new-issue link and the agent hand-off prompt (ux §2.10) remain the only affordances pointed at one, and both are text the human carries across.

## References

- ops-spec.md §7, ux-spec principle 3 ("read here, act there")
