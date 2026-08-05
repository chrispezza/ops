---
title: "ADR-001: Ops is read-mostly; external systems remain the record"
description: >-
  GitHub and other upstream systems remain the system of record. Ops only
  aggregates and deep-links; its sole write-shaped affordance is a pre-filled
  new-issue link.
lastUpdated: 2026-08-04T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted

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

## References

- ops-spec.md §7, ux-spec principle 3 ("read here, act there")
