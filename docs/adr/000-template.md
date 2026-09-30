---
title: "ADR-NNN: One line stating the decision, not the topic"
description: >-
  Two or three lines a reader can act on without opening the record: the rule,
  and the one thing it forbids.
lastUpdated: YYYY-MM-DDT00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Proposed | Accepted | Superseded by [ADR-NNN](NNN-slug.md). List amendment
dates here once there are any: "Accepted. Amended YYYY-MM-DD: …".

## Context

What is true about the system that makes this decision necessary now. Name
the incident, issue or measurement that raised it. Numbers come from
production or a measured test, and say which; mark anything *estimated*.

## Decision Drivers

- **Driver**: one line each. Reuse the standing ones where they apply — trust
  (ADR-001), single maintainer, engineering time as the expensive input,
  failures must be visible.

## Considered Options

### Option 1: …

**Pros:** …
**Cons:** …

### Option 2: …

**Pros:** …
**Cons:** …

## Decision

We will go with **Option N**. State the rule in a form someone could break
without noticing, then the mechanism that stops them (a `NOT NULL`, a
severity floor, a test, a review gate). If the rule has numbered sub-rules,
number them — code comments will cite "ADR-NNN rule 3".

## Consequences

### Positive
- …

### Negative
- …

## Validation

- The test file, production metric or review step that would show this
  decision failing.

## References

- Issues, spec sections (`ops-spec.md §2.3`), related ADRs, the files that
  implement it.

<!--
## Amendment: what changed (YYYY-MM-DD)

Added below the original sections, never in place of them. Say what changed,
why (the measurement or incident), and what did NOT change. Update Status and
lastUpdated.
-->
