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

Accepted. Amended 2026-09-18 twice: rule 4 now grades against a reference chain
(maintainer → frontier labelling pass → judge) instead of maintainer labels
alone, and an issue is now judged once rather than re-judged nightly; see the
two amendments below.

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
  cost a model call, so re-judging every hour would buy churn. An issue is
  judged once (see "Amendment: an issue is judged once"), so in the steady
  state a nightly run costs a call only for what opened that day.
- The retention sweep moved ahead of the poller pass on the daily cron
  (`src/index.tsx`). `runPollers` awaits pollers in turn, and this is the first
  poller whose upstream is a model API; compaction keeps D1 reads bounded and
  must not queue behind it.
- Per-repo failures are coverage notes (calm severity 1 on `/health`), because
  an advisory feature should not redden the dashboard. Two total failures still
  throw, or `poller.last_ok` would march forward while nothing is being judged:
  no repo could be read at all, and no verdict came back although some repo had
  issues to judge. A run that asked for nothing *because* everything is already
  judged is not a failure — it is what this poller looks like in the steady
  state.
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

## Amendment: an issue is judged once (2026-09-18)

As first shipped, the poller re-judged every untiered open issue on every run,
forever. It had no way not to: a poller gets `listEntities` and nothing else, so
it could not tell what it had already asked, and an issue left the judged set
only when a human labelled it. On this portfolio that is ~220 issues a night in
perpetuity — and it never shrinks, because the whole point of the domain is the
issues nobody has got to yet.

The binding constraint is not the model's price, which is negligible. It is the
1000 subrequests a Workers invocation gets, which this poller shares with every
other daily poller. Shrinking the caps to fit under that ceiling would have
treated the symptom.

So the poller now remembers, per repo, a **judged span** — every open issue
numbered `low..high` that carried no severity label at the time has been judged
— and the **outstanding proposals** it has not seen acted on. Both live in the
metadata of its own `poller:judge` entity: `EntityUpsert.metadata` writes it and
`ctx.listEntities` reads it back, so this needs no new contract surface, no
schema change, and no widening of "pollers never touch D1". `recordPollerStatus`
upserts the same entity without metadata, and the entity upsert coalesces a null,
so the runner's own write cannot clobber it.

Three things follow, and each is a rule:

1. **New issues extend the span upward, the backlog downward, and a cap never
   leaves a hole.** New issues are taken ascending from the top of the span and
   the backlog descending from its bottom, so whatever a cap or the run-wide
   budget cuts off leaves the span contiguous. An issue with no usable verdict
   is not in the span, so a failed call is retried rather than skipped forever.
2. **`judge.issue_tier` counts outstanding proposals, not this run's.** It is a
   `state` metric (ADR-002) and has to keep meaning "untiered issues the judge
   thinks need attention". Counting only what was judged last night would read
   as an empty backlog on the very night the backlog is largest. A proposal
   drops off when the issue is tiered for real, or is gone from the open set —
   but only where the run read far enough to know that.
3. **Calibration keeps re-judging.** `judge.tier_agreement` and its siblings
   measure the model, not the issue, so a fresh sample every run is the point.
   The sample is small, takes every human-labelled issue (they are the scarce
   ground truth) and rotates its reference-labelled fill by day.

Two limits are accepted rather than fixed, both tolerable for an advisory
signal and both recorded here so they are not rediscovered as bugs: an issue
whose severity label is later *removed* stays inside the span and is not
re-proposed, and an issue closed during a pass and reopened later is inside the
span without ever having been judged.

This is poller working state — what it has already asked — not a derived view of
stored signals, so it does not contradict the rule that derived things are
computed on each pass rather than stored. The signals remain the published truth;
delete the metadata and the poller re-judges from scratch, which is exactly the
behaviour this amendment replaced.

## Amendment: Choice, and one issue per request (2026-09-18)

Two corrections to how the poller calls Jev, both from the vendor's own
documented weaknesses for `jev-1.13`.

**One issue per request.** The first implementation packed twenty unrelated
issues into a single `state` and asked twenty questions against it, on a reading
of "batch questions per request" that turned out to be backwards: the docs mean
many questions about *one* subject. They also say plainly that accuracy falls as
the state grows, that unrelated detail acts as a distractor, and that the fix is
to filter in code and send only the fields the question needs. Nineteen other
people's bug reports next to the issue being tiered is that failure mode exactly.
The cost is subrequests, which is what the judge-once amendment above pays for.

**Choice, not Score.** The tiers are four named labels, which is what Choice is
for; Score is for a position on a spectrum, and `jev-1.13`'s documented weakness
is numerical calibration between score levels. Choice returns the option name
and a distribution over the options, so nothing is lost, and the
fractional-score-to-index rounding step goes away. Ordinality is still
load-bearing in one place — `within one tier` compares indices — and the option
order supplies it.

The options are objects rather than strings, carrying what each tier is, what it
is *not* for, and examples. Jev has no fine-tuning: no training endpoint, no
few-shot parameter. The rubric is the only lever there is, and structured
options are the documented way to pull it.
