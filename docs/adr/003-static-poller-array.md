---
title: "ADR-003: Static poller array over a dynamic plugin registry"
description: >-
  Pollers are files in src/pollers/ listed in one static array. No dynamic
  loading, no registry, until at least three deployments diverge.
lastUpdated: 2026-08-04T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted

## Context

Ops is extended by adding pollers. A "plugin system" (dynamic imports, config-driven registry, versioned plugin API) is the classic over-engineering trap for a system with one maintainer and, initially, two deployments (personal, work).

## Decision Drivers

- **YAGNI with a tripwire**: extensibility need is real but small and knowable.
- **Type safety**: a static array is fully typechecked; dynamic loading is not.
- **Workers runtime**: dynamic code loading is not meaningfully available anyway.

## Considered Options

### Option 1: Static array in `src/pollers/index.ts`

**Pros:** typechecked, greppable, zero indirection; adding a poller is one file + one line.
**Cons:** deployments with different poller sets need different entry files.

### Option 2: Config-driven registry with dynamic resolution

**Pros:** per-deployment poller sets via config alone.
**Cons:** stringly-typed indirection, runtime failure modes, an API to version — all before a second consumer exists.

## Decision

We will go with **Option 1**. The `POLLERS` array is the extension surface. Revisit only when ≥3 deployments have diverging poller sets (the work deployment composes its own array importing from the public package — see [ADR-004](004-public-shell-private-config.md)).

## Consequences

### Positive
- Poller contract (`Poller` interface) stays the only abstraction.

### Negative
- Each deployment owns an entry-point file (acceptable: that file is ~5 lines).

## Validation

- **Tripwire**: reopen this ADR if a third deployment appears or array composition gets awkward.

## References

- ops-spec.md §3, §7
