---
title: "ADR-006: judge.* signals are advisory model output"
description: >-
  Model-produced signals live in the judge.* domain, are pinned at severity 0,
  and are visible on /findings only. They never feed the triage score, push
  alerts or the digest, and deleting them must change nothing else.
lastUpdated: 2026-09-18T00:00:00.000Z
tableOfContents: true
pagefind: true
---

## Status

Accepted

## Context

Every signal Ops has stored until now is a fact: a CI rollup state, an alert
count, a byte size, a timestamp. Issue tiering is the first thing Ops wants that
is not a fact. `issues.flagged` covers issues a maintainer has already labelled;
issues carrying no severity label are invisible to it, and reading them is a
judgment call.

TypeSafe Jev can make that call. Storing its answer introduces a class of signal
that is unlike the rest in three ways that matter:

- **It is nondeterministic.** The same issue can be tiered differently on two
  runs, so the value moves without the world moving.
- **It costs money per observation**, which no other signal does.
- **It sends repository content to a third party**, which no other poller does.

A judgment stored next to facts, in the same table, rendered by the same
components, will be read as a fact. Something has to prevent that structurally
rather than by convention.

## Decision Drivers

- **Trust** (ADR-001's driver): the value of this dashboard is that its numbers
  can be acted on. One inferred number silently inflating a triage score would
  cost more trust than the feature is worth.
- **Reversibility**: an advisory feature must be abandonable without archaeology.
- **A human stays in the loop**: tiering is the maintainer's call. The system of
  record for a tier is a GitHub label (ADR-001), not a row in D1.

## Considered Options

### Option 1: A `judge.*` domain pinned at severity 0

**Pros:** every existing gate is already severity-gated, so "advisory" needs no
new machinery — `computeScore` (`severity > 0`), `notifyNewAlerts` (`>= 3`) and
the digest's raised/resolved (`>= 2`) cannot see a severity-0 row. Visibility on
`/findings` comes from one entry in `ADVISORY_DOMAINS`, the same escape `audit.*`
already uses.
**Cons:** the floor has to be honoured by every future judge metric; nothing in
the type system enforces it.

### Option 2: Let the judge assign real severities, flagged by a column

**Pros:** a confidently-judged P0 surfaces immediately.
**Cons:** needs a schema change, and every consumer must learn to discount the
flag. The first consumer that forgets turns inference into an alert.

### Option 3: Keep the verdicts outside Ops entirely

**Pros:** zero risk to the dashboard's numbers.
**Cons:** the verdicts are then unreadable next to the repo they describe, and
there is nowhere to record whether the judge was any good.

## Decision

We will go with **Option 1**.

`judge.*` signals are model output and carry the following rules:

1. **Severity is 0, always.** Not a default — the mechanism. It is what keeps
   the domain out of `computeScore`, `notifyNewAlerts` and the digest's
   raised/resolved sections without any of them knowing the domain exists.
2. **Visible on `/findings` and the entity page, nowhere else.** `judge` is in
   `ADVISORY_DOMAINS` (`src/config.ts`), which lifts the severity floor for that
   page only.
3. **A verdict is a proposal in the maintainer's own vocabulary.** The judge
   emits GitHub label names that `LABEL_SEVERITY` already grades, so acting on
   one means applying that label in GitHub. Ops never applies it (ADR-001).
4. **The domain must grade itself.** `judge.tier_agreement` compares verdicts on
   a blind sample of already-labelled issues against the maintainer's labels. A
   judge metric with no way to be shown wrong does not belong in this domain.
5. **Deleting every `judge.*` row must change no other value.** This is the test
   of the whole ADR. If dropping the domain would move a score, an alert or a
   digest line, the domain has stopped being advisory.

Graduating `judge.*` to any further surface — the digest backlog strip is the
obvious next one — requires graded calibration and an amendment to this ADR.
Raising it above severity 0 requires a new ADR.

## Consequences

- The judge poller runs daily, not hourly: verdicts are nondeterministic and
  cost a model call, so re-judging every hour would buy churn. It also cannot
  cache — pollers get `listEntities` and nothing else — so a daily cadence is
  what makes re-judging from scratch affordable.
- The retention sweep moved ahead of the poller pass on the daily cron
  (`src/index.tsx`). `runPollers` awaits pollers in turn, and this is the first
  poller whose upstream is a model API; compaction keeps D1 reads bounded and
  must not queue behind it.
- Per-repo failures are coverage notes (calm severity 1 on `/health`), because
  an advisory feature should not redden the dashboard. A run where *no* repo
  could be judged still throws: otherwise `poller.last_ok` marches forward while
  nothing is being judged, which reads as healthy.
- Issue text leaves the deployment. `JUDGE_SCOPE` (`wrangler.jsonc`) bounds how
  much: `all`, `titles` (private repos contribute titles only), or `public`
  (private repos are not judged). TypeSafe states it does not train on user
  data and offers zero data retention to enterprise customers; retention terms
  otherwise live in their DPA.
- Read-only still holds. The judge reads issues and writes a row in Ops. No
  upstream write scope is requested anywhere (ADR-001).
