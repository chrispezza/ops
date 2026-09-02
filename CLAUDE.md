# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repo. The
human-facing overview is [README.md](README.md); the reasoning behind the
architecture is in [docs/adr/](docs/adr/). This file is the operating manual.

## What this is

A read-mostly dashboard on Cloudflare Workers + D1 that aggregates signals
about a portfolio of repos, plugins and vendor accounts, scores them, and
deep-links to the real system of record. Hono with JSX server rendering,
htmx for partials, no client framework, no UI build step.

## Commands

```sh
npm run dev        # wrangler dev on :8787 against local D1
npm test           # vitest inside real workerd (@cloudflare/vitest-pool-workers)
npm run typecheck  # tsc --noEmit, strict + noUncheckedIndexedAccess
npm run types      # regenerate worker-configuration.d.ts from wrangler.jsonc
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs, in order:
`wrangler types` → `typecheck` → `test` → `wrangler deploy --dry-run`.
Run all four locally before calling a change ready. `worker-configuration.d.ts`
is gitignored and generated; if the `Env` type looks stale, run `npm run types`.

Local seeding: `wrangler d1 migrations apply ops --local`, put
`INGEST_TOKEN=dev-token` in `.dev.vars`, POST the payload from the README to
`http://localhost:8787/ingest`. `.dev.vars` is gitignored; never commit it.

## Architecture invariants (do not violate without a new ADR)

- **Read here, act there** ([ADR-001](docs/adr/001-read-mostly-system-of-record.md)).
  Ops never writes to GitHub or any upstream. The only write-shaped UI
  affordance is a pre-filled new-issue link. Do not add write integrations.
- **Signals are append-only** ([ADR-002](docs/adr/002-append-only-signals.md)).
  Never UPDATE or DELETE signal rows to change state; current state is derived
  by query. Each metric is declared `state` (latest wins) or `interval`
  (summed over `period`) in the poller's `metricSemantics`. Idempotency comes
  from `UNIQUE(entity_id, metric, dedupe_key)`; `dedupe_key` is NOT NULL on
  purpose. Retention compaction in `src/core/retention.ts` is the one
  sanctioned deleter.
- **Pollers are a static array** ([ADR-003](docs/adr/003-static-poller-array.md)).
  Add a poller as one file in `src/pollers/` plus one line in
  `src/pollers/index.ts`. No registry, no dynamic import.
- **Public shell, private config** ([ADR-004](docs/adr/004-public-shell-private-config.md)).
  Deployment specifics are `vars` in `wrangler.jsonc`; secrets go through
  `wrangler secret put` and never appear in code, tests, fixtures or docs.
  Work-specific pollers do not belong in this repo.

Derived things (budget breaches, anomalies, hygiene gaps, scores) are computed
from stored signals on each pass in `src/core/derive.ts` and
`src/core/score.ts`, never stored as separate truth.

## Poller contract

`src/pollers/types.ts` is the contract; `src/core/runner.ts` enforces it.

- Pollers never touch D1. Return `{ entities, signals, notes? }`; the runner
  stores, dedupes, isolates failures and records health.
- Read credentials from `env`. If one is absent, throw
  `new Error("unconfigured: set the X secret to enable this poller")`. The
  runner recognises the `unconfigured:` prefix and records a calm severity-1
  state on `/health` instead of a failure. (The README's "return an empty
  result" wording is older than this convention; the prefix is what the
  runner actually checks.)
- A poller that truncates its own work (caps, pagination limits) must say so in
  `notes`. No silent caps.
- Entity ids are `{kind}:{natural_key}` and must be stable across runs.
  `archived: true` is one-way; pollers never clear it.
- `observedAt` is when the condition was true, not when it was polled.
- Metric names are `domain.name` matching `^[a-z0-9_]+\.[a-z0-9_.]+$`. A new
  domain shows up on `/findings` with zero view changes; that is the extension
  point, so prefer a new metric over a new page.
- Every metric a poller emits must be listed in `metricSemantics`.

Every poller run is itself a signal on a synthetic `poller:{id}` entity.

## Security invariants

- Every state-mutating `POST` requires an `Origin` header matching the
  deployment (same-origin gate in `src/index.tsx`). Do not exempt new routes.
- `POST /ingest` is the one exemption and is gated by a bearer token compared
  in constant time (`src/ingest.ts`). Keep the SHA-256-then-timingSafeEqual
  pattern; do not compare token strings directly.
- Access assertion verification (`src/core/access.ts`) pins RS256 and checks
  `aud`, `iss` and expiry. Do not loosen the algorithm allow-list.
- Validate all `/ingest` and form input at the boundary; unknown fields are
  ignored, not stored. Keep the CSP and `Referrer-Policy: same-origin` headers
  as they are (a stricter referrer policy nulled `Origin` on form POSTs; see
  git history for #36).
- Upstream credentials are read-only by design. Never request write scopes.

## Testing conventions

- Tests run in real workerd via `cloudflareTest`; migrations are applied per
  test file by `test/apply-migrations.ts` from `TEST_MIGRATIONS`.
- Mock upstream HTTP with `vi.stubGlobal("fetch", vi.fn(async (...) => ...))`
  and restore in `afterEach`. Build fixtures with small helper functions
  (see `repoNode()` in `test/github.test.ts`).
- Pollers are tested by mocking their upstream, one file per poller, except
  the vendor spend pollers which share `test/vendors.test.ts`. Derived logic
  (score, derive, spend) is tested against seeded signals, not via pollers.
- Schema changes are new numbered files in `migrations/`; never edit an
  applied migration.

## Code style

- TypeScript strict; `verbatimModuleSyntax` means `import type` for types.
- Functional modules, no classes. Const objects with `as const` over enums.
- Hono JSX via `jsxImportSource: hono/jsx`; pages live in `src/ui/pages/`,
  shared pieces in `src/ui/components.tsx`, chrome in `src/ui/layout.tsx`.
  Styling is tokens in `public/tokens.css`; no inline hex outside that file.
- Every score and finding must explain itself in the UI (`why` column). If you
  change scoring, update the explanation in the same change.
- Comment intent, not mechanics. Existing comments cite the spec section or
  ADR they implement; keep doing that.

## Git and PR flow

- Conventional commits, `type(scope): description`. Scope is the poller,
  page or subsystem touched: `ui`, `ux`, `github`, `findings`, `triage`,
  `spend`, `uptime`, `score`, `health`, `security`, `access`, `ingest`,
  `prompt`, `core`, `maintenance`, `manifests`, `vendors`, `entity`.
- Branch from `main` as `type/short-slug`; open a PR; never push to `main`.
  CI must be green before merge. Do not bypass hooks with `--no-verify`.
- Deploys are manual (`wrangler deploy` from `main`), never from a branch.
- Do not fix issues outside the task silently. Report them as Found Work at
  the end and let the maintainer decide.

## Where things are

| Path | Role |
|---|---|
| `src/index.tsx` | Hono app, routes, cron handler, security middleware |
| `src/ingest.ts` | `POST /ingest` validation and auth |
| `src/core/` | store, runner, derive, score, retention, notify, access, agent-prompt |
| `src/pollers/` | one file per upstream; `index.ts` is the `POLLERS` array |
| `src/ui/` | layout, components, one file per page |
| `migrations/` | D1 schema, numbered and append-only |
| `public/` | static assets served by Workers Assets; `tokens.css` is the design system |
| `docs/adr/` | architecture decisions |
| `ops-spec.md`, `ops-ux.md`, `ops-plan.md` | original design docs; the spec sections cited in code comments |
