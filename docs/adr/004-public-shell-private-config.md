---
title: "ADR-004: Public shell, private deployment config; work pollers never upstream"
description: >-
  The public repo contains the shell and reference pollers only. Deployment
  specifics live in wrangler vars/secrets; work-specific pollers live in a
  private repo that imports the public package.
lastUpdated: 2026-08-04T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted

## Context

Ops serves two deployments: a personal portfolio (public-friendly) and a work portfolio (private: internal repo names, skill manifests, usage data, SEO audits). One codebase must serve both without leaking work specifics.

## Decision Drivers

- **Leak prevention by construction**: private code that never enters the public repo cannot be accidentally published.
- **Shareability**: the shell is useful to others as a template.
- **Single core**: schema, runner, and views should not fork.

## Considered Options

### Option 1: Public shell + private repo importing it

**Pros:** work code physically separated; public repo stays a clean reference; core evolves in one place.
**Cons:** package boundary to maintain once phase 6 lands.

### Option 2: Single private monorepo

**Pros:** no boundary to maintain.
**Cons:** nothing shareable; personal deployment inherits work secrets-handling posture forever.

## Decision

We will go with **Option 1**. Public repo: core, UI, `github`/`anthropic_usage` pollers, `/ingest`. Work-only pollers (`manifests`, `skill_usage`, SEO ingest) live in a private repo that imports the public package and composes its own `POLLERS` array. Deployment specifics are `wrangler.toml`/`wrangler.jsonc` vars and Worker secrets — never code, never D1.

## Consequences

### Positive
- Work data and pollers cannot leak via the public repo.
- The public repo doubles as documentation-by-example.

### Negative
- Phase 6 must turn the shell into an importable package (deferred until the contract stabilizes).

## Validation

- **Review gate**: no work-specific identifiers appear in public-repo history.

## References

- ops-spec.md §7; [ADR-003](003-static-poller-array.md)
