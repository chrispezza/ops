---
title: "ADR-004: Public shell, private deployment config; work pollers never upstream"
description: >-
  The public repo contains the shell and reference pollers only. Deployment
  specifics live in wrangler vars/secrets; work-specific pollers live in a
  private repo that imports the public package.
lastUpdated: 2026-09-30T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted. Amended 2026-08-13 (`manifests` reclassified) and 2026-09-30 (the classification rule restated for the nine pollers that now ship).

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

We will go with **Option 1**. Public repo: core, UI, `/ingest`, and every poller whose target is deployment config rather than a resource named in code (as first written: `github` and `anthropic_usage`). Work-only pollers (`skill_usage`, SEO ingest) live in a private repo that imports the public package and composes its own `POLLERS` array. Deployment specifics are `wrangler.jsonc` vars and Worker secrets — never code, never D1.

**Amendment (2026-08-13):** `manifests` was originally classified work-only. It now polls a *public* Claude Code plugin marketplace, so it ships in the public repo — but only under the rule above: its target is the `MARKETPLACE_REPO` var, not a constant in the source, and it is dormant when that var is unset. The classification test is therefore not "which poller" but "does it name a private resource in code" — a poller whose target is deployment config satisfies the review gate below regardless of what it points at.

**Amendment (2026-09-30):** nine pollers now ship in the public repo (`github`, `uptime`, `anthropic_usage`, `claude_code`, `openai_costs`, `x_usage`, `manifests`, `cloudflare`, `judge`), each admitted by the 2026-08-13 test: every target is a var or a secret, every poller is dormant when its credential is absent (the `unconfigured:` convention in `src/pollers/types.ts`), and `wrangler.jsonc`'s `vars` block is the only place a deployment-specific identifier appears — which is why forking means replacing that block and nothing else. The Decision's poller list is restated as the rule rather than an enumeration so it stops going stale.

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
