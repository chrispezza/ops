# Architecture decision records

The reasoning behind the invariants CLAUDE.md enforces. Each record is one
decision, written when it was made and amended in place when the world moved.
Nothing here is ever rewritten to look prescient: a superseded consequence is
struck through with a pointer, and a change of rule is a dated
**Amendment** section below the original Decision.

| ADR | Decision | Status |
|---|---|---|
| [001](001-read-mostly-system-of-record.md) | Ops is read-mostly. Upstream systems remain the record; the only write-shaped affordance is a pre-filled new-issue link. | Accepted; amended 2026-09-30 (balances, archive toggle) |
| [002](002-append-only-signals.md) | Signals are append-only; current state is derived by query; each metric is `state` or `interval`. | Accepted; amended 2026-09-30 (retention sweep) |
| [003](003-static-poller-array.md) | Pollers are one file plus one line in a static array. No registry until three deployments diverge. | Accepted |
| [004](004-public-shell-private-config.md) | Public shell, private config. A poller ships publicly when its target is a var or secret, never a resource named in code. | Accepted; amended 2026-08-13, 2026-09-30 |
| [005](005-signal-latest-pointer.md) | `signal_latest` is a pointer table maintained in the write path, so current-state reads stop scaling with history. | Accepted |
| [006](006-advisory-judge-signals.md) | `judge.*` signals are advisory model output pinned at severity 0 and graded against a reference chain. | Accepted; amended 2026-09-18 ×3, noted 2026-09-23 |
| [007](007-d1-row-write-budget.md) | What a signal costs in D1 row writes, and why the account moved to Workers Paid rather than trade history or indexes. | Accepted |

## Writing one

Copy [000-template.md](000-template.md) to the next number and fill every
section. The bar for a new ADR is a rule someone could break without noticing:
a constraint on the schema, the poller contract, the security gates, or what
Ops is allowed to store. A feature does not need one; a feature that reverses
a stated non-goal does (see spec §0's revision of "notifications").

Conventions the existing records follow:

- **Numbers are real.** Costs, row counts and dates come from production or a
  measured test, and say which. *Estimated* is written where it applies.
- **Options are honest.** The rejected options get their real pros; the
  chosen one gets its real cons.
- **Consequences name the tests.** The Validation section points at the test
  file or the production metric that would show the decision failing.
- **Amend, never rewrite.** A change in the rule is a dated `## Amendment:`
  section that says what changed, why, and what did *not* change. The Status
  line lists the amendment dates. `lastUpdated` in the frontmatter is the date
  of the latest amendment.
- **Cite from code.** Comments in `src/` reference the ADR they implement
  (`ADR-005`, `ADR-006 rule 4`), so a reader landing on the code finds the
  reasoning in one hop.

The frontmatter keys (`title`, `description`, `lastUpdated`,
`tableOfContents`, `pagefind`) follow the Starlight convention so the records
can be dropped into a docs site unchanged; nothing in this repo reads them.
