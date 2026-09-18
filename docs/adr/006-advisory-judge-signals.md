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

Accepted. Amended 2026-09-18: rule 4 now grades against a reference chain
(maintainer → frontier labelling pass → judge) instead of maintainer labels
alone; see "Amendment: the calibration chain" below.

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
4. **The domain must grade itself, against a reference it cannot influence.**
   Three metrics, all severity 0, and graduation needs all three graded:
   - `judge.tier_agreement` — verdicts on a blind sample of labelled issues
     against the **reference tier**: the maintainer's own label where one
     exists, else a label applied by a **reference actor** — the frontier-model
     labelling pass named in `JUDGE_REFERENCE_ACTORS`.
   - `judge.tier_agreement_human` — the same, against labels a **human** applied
     only. A GitHub App is excluded by actor type; `JUDGE_CALIBRATION_EXCLUDE`
     names logins for automations that label under a person's PAT.
   - `judge.reference_agreement` — the reference actor against the maintainer:
     of the tiers it applied that a human reviewed, how many stood. Overriding
     with a severity label is one review; applying `triaged` is the other.
   Grading one model against a label another model applied is two models
   agreeing, dressed as a number — *unless* that other model is itself graded
   against the maintainer, which is what the third metric is for. Any
   automation not named as a reference actor is ground truth for nothing. A
   judge metric with no way to be shown wrong does not belong in this domain,
   and the sample size travels with every percentage for the same reason.
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
- Provenance is only consulted for calibration. Whether an issue is *already
  tiered* — and so not worth proposing a tier for — ignores who applied the
  label: `issues.flagged` sees a `p1` whoever put it there. Rule 4 is about
  ground truth, not about which issues the judge reads.
- An empty sample is reported as such (`no human-labelled issues to compare
  against`, plus a note counting the exclusions) rather than smoothed over: an
  ungradeable judge must look ungraded, because the alternative is a confident
  number that graduated the domain on nothing.

## Amendment: the calibration chain (2026-09-18)

The original rule 4 admitted only human-applied labels as ground truth. On this
portfolio that starved the gate: 220 open issues, 2 with a severity label, both
applied by the weekly labelling routine. Hand-labelling enough issues to grade
the judge would have taken weeks and produced tens of samples; the routine
labels hundreds.

The routine is a frontier model with the maintainer's priorities in its prompt.
Its tiers are not the maintainer's, but they are *close* in a way that can be
measured — which is the whole difference. So the reference is now a chain, each
link graded against the one above it:

1. **The maintainer** reviews the routine's tiers. Not from scratch: the Friday
   report lists every label it applied, and agree/disagree on that list is a
   few minutes. Agreement is recorded with a `triaged` label; disagreement by
   applying the right severity label, which wins.
2. **The routine** (`JUDGE_REFERENCE_ACTORS`) labels the bulk. It writes through
   the Claude GitHub App, so its labels carry `Bot` provenance and are
   distinguishable from the maintainer's.
3. **The judge** is graded against the reference tier (1 where it exists, else
   2), and separately against 1 alone.

"The judge matches the maintainer X% of the time" is then a computable number —
`judge.tier_agreement` bounded by `judge.reference_agreement` — instead of a
number with an unmeasured link in it. And when the maintainer overrides the
routine, the fix is a rule in the routine's prompt, which improves the reference
for every future issue; hand labels never compounded like that.

What does not change: the judge is still blind (labels never reach it), the
domain is still severity 0, Ops still writes no label, and an automation that is
not named as a reference actor still counts for nothing. Setting
`JUDGE_REFERENCE_ACTORS` empty restores the original human-only rule exactly.
