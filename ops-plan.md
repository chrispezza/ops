# Ops — Implementation Plan v0.1

Companion to `ops-spec.md` (architecture/data) and `ops-ux.md` (pages/states). This doc turns spec §6's build order into concrete phases: stack decisions, repo layout, and per-phase deliverables with acceptance criteria. Each phase is one PR-sized unit that leaves the app deployable.

## 0. Stack decisions (made once, up front)

| Decision | Choice | Rationale |
|---|---|---|
| Router/SSR | **Hono** (JSX, no client runtime) | Typed routing, middleware, server-side JSX for the HTMX partials. ~20KB into the Worker bundle, actively maintained, first-class Workers support. Alternative (raw `fetch` + template literals) saves the dep but costs us typed props and route ergonomics we'll use on every page. |
| HTMX | **Self-hosted static asset** (~14KB gz) via Workers assets | No CDN: removes a third-party runtime dependency and a supply-chain surface. Pin the version in-repo. |
| Migrations | `wrangler d1 migrations` | Built-in, sequential SQL files, no extra tooling. |
| Tests | **Vitest + `@cloudflare/vitest-pool-workers`** | Runs against real workerd + real D1 (SQLite), so idempotency and the triage/spend SQL are tested against the actual engine, not a mock. Poller HTTP mocked with `fetchMock`. |
| Types/lint | TS strict, no enums (const objects `as const`), interfaces for object shapes | Per personal coding standards. |
| CI | GitHub Actions: typecheck → vitest → `wrangler deploy --dry-run` | Deploy stays manual (`wrangler deploy`) until phase 5 proves `/ingest`; then optionally deploy-on-main. |

Config typing: one `src/config.ts` exporting `Env` (bindings + secrets + vars), triage weights, and the category → expected-metrics map. Weights and the map are data, not code paths (spec §2.4, §4.1).

## 1. Repo layout

```
ops/
├── wrangler.jsonc            # D1 binding, 2 crons (hourly, daily 06:00 ET), assets dir, vars
├── package.json  tsconfig.json  vitest.config.ts
├── migrations/
│   └── 0001_init.sql         # entities, signals, budgets + indexes (spec §2.1 verbatim)
├── public/
│   ├── tokens.css            # type scale, 4px spacing, severity palette, light/dark
│   └── htmx.min.js
├── src/
│   ├── index.ts              # fetch (Hono app) + scheduled (runner fan-out) entries
│   ├── config.ts             # Env, weights, expected-metrics map
│   ├── core/
│   │   ├── store.ts          # entity upsert (bump last_seen_at), idempotent signal insert
│   │   ├── runner.ts         # per-poller isolation, poller:{id} self-signals, schedule fan-out
│   │   ├── derive.ts         # post-poll: budget thresholds, spend anomaly, hygiene.missing_metric
│   │   └── queries.ts        # latest-per-(entity,metric), triage score, spend sums, findings
│   ├── pollers/
│   │   ├── types.ts          # Poller, EntityUpsert, SignalInsert (spec §3 verbatim)
│   │   ├── index.ts          # static POLLERS array — the whole "plugin system"
│   │   ├── github.ts
│   │   └── anthropic-usage.ts
│   ├── ingest.ts             # POST /ingest, bearer auth, SignalInsert payload
│   └── ui/
│       ├── layout.tsx        # nav bar, freshness chip, degradation banner
│       ├── components.tsx    # severity dot, metric chip, bar sparkline (inline SVG), row
│       └── pages/            # map, triage, spend, findings, entity, health, settings
└── .github/workflows/ci.yml
```

`core/` never imports from `pollers/` except `types.ts`; pollers never touch D1 (spec §3). `queries.ts` is the only file that knows the two metric semantics — every page renders from its outputs.

## 2. Phases

### Phase 0 — Scaffold (S)
`git init`, license, README stub. Wrangler + TS strict + Vitest wiring, Hono hello-world with `tokens.css`, D1 binding created, CI workflow green, deployed behind Cloudflare Access.
**Done when:** `wrangler deploy` serves a styled empty shell at the Access-protected URL; CI passes on a trivial test.

### Phase 1 — Schema + core (M) · *the contract PR*
`0001_init.sql`, `pollers/types.ts`, `store.ts`, `runner.ts`, `derive.ts` (hygiene pass only — budgets/anomaly land with spend). Runner: fan out by `poller.schedule`, isolate failures, write `poller.status` signals on synthetic `poller:{id}` entities. Store enforces `dedupeKey` non-empty at the boundary (SQLite UNIQUE treats NULLs as distinct — a missing key would silently break idempotency).
**Tests (the bulk of the phase):** re-running the same PollerResult produces zero new rows; interval overwrite on same `period_start`; one throwing poller doesn't block others and yields a severity-3 self-signal; hygiene signal emitted for a category entity missing an expected metric.
**Done when:** a fake in-test poller round-trips through runner → D1 → latest-per-metric query.

### Phase 2 — GitHub poller + Map + Health (M) · *usable day one*
`github.ts`: one GraphQL query per owner from `GITHUB_OWNERS`, topic → category mapping, metrics per spec §3.1. UI: layout + nav, `/` (category sections, row anatomy, expected-metric chips with `—` warnings, rollup headers), `/health` (poller board from self-signals), freshness chip + degradation banner (UX principle 2). First-run empty state = setup checklist. Dev-only "run now" button on `/health`.
**Done when:** real repos render on `/` grouped by topic-derived category, with an untagged repo landing in Uncategorized; killing the PAT produces the amber banner within one cron cycle.

### Phase 3 — Triage + entity detail (S/M)
`/triage` (score SQL from `queries.ts`, weights from config, "why" column, HTMX inline score breakdown), `/e/{id}` (state-metric table, history feed with load-more, archive toggle). Filter params + `hx-push-url` + `/` keyboard focus.
**Decisions due here (UX §6):** ship `/` and `/triage` both, revisit after two weeks; chips hardcoded in templates; archived = hidden from `/` and `/triage`, visible in `/findings` and history.
**Done when:** score in the UI matches a hand-computed score for a known entity; back-button restores filter state.

### Phase 4 — Spend (M)
`anthropic-usage.ts` (Admin API cost + usage reports, daily interval signals, dedupe on `period_start`), budget evaluation + anomaly detection in `derive.ts` (both are core-derived signals, not poller output), `/spend` (MTD bar with limit ticks, per-key SVG bar sparklines, hollow today-bar, `window` param), `/settings` (budget rows + weight overrides — the only Ops-owned writes, plain POST).
**Tests:** budget soft/hard crossing emits severity 2/4 exactly once per period; anomaly triggers at >3× trailing-7-day median; re-poll of a settling day overwrites cleanly.
**Done when:** real spend renders vs. a seeded budget; a synthetic spike flags.

### Phase 5 — Ingest + Findings (S)
`ingest.ts` (bearer `INGEST_TOKEN`, validate SignalInsert shape at the boundary, reuse `store.ts` — note: new attack surface, auth + validation are the phase), `/findings` (severity ≥2 plus `audit.*`/`hygiene.*`, `domain` prefix filter, group-by-entity toggle). Wire one real repo's CI (LHCI or coverage POST as final step).
**Done when:** a real CI run lands a signal that appears on `/findings` and the entity page, and a bad token / malformed payload is rejected with the right status.

### Phase 6 — Work split (M, separate effort)
Extract public shell as an importable package (core, types, UI, reference pollers); private work repo adds `manifests`, `skill_usage`, SEO ingest config. Details deferred until phases 1–5 stabilize the contract — premature packaging here is the main schedule risk, per ADR-003's "until deployments diverge" logic.

## 3. Sequencing notes

- Phases 0–2 are the critical path; 3 and 4 are independent of each other after 2 (spend touches no triage code) and can reorder on appetite.
- ADRs 001–004 (spec §7) get written as part of Phase 1's PR — that PR is the contract they document.
- Secrets appear in this order: `GITHUB_PAT` (ph2), `ANTHROPIC_ADMIN_KEY` (ph4), `INGEST_TOKEN` (ph5). All Worker secrets, never in repo or D1.
