# Runbook

Procedures for the things that have actually gone wrong, plus the routine
operations that are easy to get slightly wrong. Each incident section is
written from the diagnosis that fixed it; the ADR or issue it cites has the
measurements.

Everything here assumes `wrangler` authenticated to the deploying account and a
checkout of `main`. Nothing here writes to any upstream system
([ADR-001](adr/001-read-mostly-system-of-record.md)).

## Where to look first

| Symptom | Start at |
|---|---|
| Pages 500, `/health` unreachable | Worker logs (dashboard → Workers → `ops` → Logs); a D1 error code `7500` means the read allowance is spent — see *D1 read allowance* |
| `/health` shows a poller red | its error text on that row; `unconfigured:` is not an incident |
| Freshness chip stale but `/health` green | the write allowance: status rows fail by the same path as data rows — see *D1 write allowance* |
| Several daily pollers dark, `durationMs: 0` | *Subrequest ceiling* |
| CI reporters failing on `POST /ingest` | the status code: `400` is their payload, `401` their token, `503` this side (see *Ingest answers 503*) |
| Nothing since a deploy | `wrangler deployments list`; roll back with `wrangler rollback` if the previous version was healthy |

Exact D1 numbers come from the account analytics, never from `wrangler d1 insights`
(its per-query dataset is sampled and once summed to ~270k rows against a real
5.1M, missing the retention `DELETE` entirely — #53). Database-level totals by
day or hour:

```sh
wrangler d1 info ops        # database id, size
```

then `d1AnalyticsAdaptiveGroups` by `date` or `datetimeHour` for the database
id, through the dashboard's D1 → Metrics view or the GraphQL Analytics API.
For one statement's exact cost, `wrangler d1 execute ops --remote --json --command "<sql>"`
reports `meta.rows_read` and `meta.rows_written`.

## D1 read allowance spent (account-wide)

**What it looks like.** Every page 500s from some hour of the day until 00:00
UTC; the Worker log carries `daily row read limit` or `code: 7500`. Because the
allowance is per *account*, unrelated D1 databases on the same account fail
too — this is how it was first noticed (#42, a migration on another project).

**Happened.** 2026-09-02 (window-function scans on every read; fixed by the
`signal_latest` pointer, [ADR-005](adr/005-signal-latest-pointer.md)) and
2026-09-12 → 09-17 (the retention sweep's `DELETE` cascading into an unindexed
foreign key, one full scan per deleted row; fixed by migration 0005, #52).

**Procedure.**

1. Confirm from analytics which hour spent the allowance. A step change at
   10:00 UTC is the daily cron (sweep, then daily pollers); a flat high line is
   per-request reads.
2. Find the reader. For the cron, run the sweep's `SELECT` with `--json` and
   read `meta.rows_read`; for page reads, the `/health` onset scan and any
   query over `signals` without a `metric` or `entity_id` predicate are the
   usual suspects. Compare against the indexes in `migrations/` — a query that
   names `metric` should be served by `idx_signals_metric`, one that names
   `entity_id` by the UNIQUE autoindex or `idx_signals_entity`.
3. Fix it in code or with an index migration. An index over `signals` writes
   one row per existing row when applied (see *Applying a migration*).
4. Nothing to recover: reads failed, nothing was lost. The `d1.read_cap_pct`
   watcher (severity 2 at 80 %, 3 at 100 %) exists so the next one is a
   finding before it is an outage; check it fired on `/findings`.

## D1 write allowance spent (account-wide)

**What it looks like.** The freshness chip keeps showing the last success
while nothing is being stored, because the poller's own `poller.status` row is
written by the same `insertSignals` path that just failed. `/ingest` answers
`503` with `Retry-After` set to the seconds until 00:00 UTC. The Worker log
carries `daily row write limit`.

**Happened.** 2026-09-18 01:00 UTC: migration 0004's partial index
materialised 117,983 entries, one row-write each, against the free tier's
100,000 per day ([ADR-007](adr/007-d1-row-write-budget.md)). The account moved
to Workers Paid the same day.

**Procedure.**

1. Confirm in analytics: rows written for the day at the allowance, then flat.
2. If a migration did it, it is over; the day is lost and the digest will show
   the gap. If steady-state writes did it, ADR-007 has the cost table (nine
   row-writes per hourly state observation) and the options; on Workers Paid
   the allowance is monthly and the watcher's denominators
   (`D1_ROW_WRITES_PER_DAY`) are the monthly figure ÷ 30.
3. Nothing to recover. Signals not stored between the trip and the reset are
   gone; pollers observe forward in time and the next run fills in from there.
4. The runner no longer aborts the loop when the status write fails (ADR-007):
   the failure goes to the Worker log and the remaining pollers still run.
   `d1.write_cap_pct` is the early warning.

## Subrequest ceiling starves later pollers

**What it looks like.** From one daily cron onward, every poller after a
certain one fails instantly (`durationMs: 0`) with
`Too many subrequests by single Worker invocation`; spend, manifests and the D1
watchers stop recording. The poller that hit the ceiling fails partway.

**Happened.** 2026-09-19 → 09-23 (#68): `judge` ran first among the daily
pollers and spent the invocation's budget on a backlog of a few hundred issues.

**Procedure.**

1. `limits.subrequests` in `wrangler.jsonc` is the declared budget (10,000, the
   Workers Paid figure). Confirm the deployed version carries it:
   `wrangler deployments list`.
2. `POLLERS` order in `src/pollers/index.ts` is load-bearing: `judge` runs
   last so an advisory poller can only starve itself. A new poller with a
   cost that scales with the portfolio goes before `judge` and after
   everything it depends on.
3. Every poller that caps its own work must report it in `notes` (visible on
   `/health`), so a truncated run reads as truncated, not as done.

## Ingest answers 503

`POST /ingest` maps D1 failures to what the reporter should do
(`src/core/d1-errors.ts`, #45):

| Response | Meaning | Reporter should |
|---|---|---|
| `503` + `Retry-After: <seconds to 00:00 UTC>` | daily allowance spent | warn, not fail the build; resend later with the same `dedupeKey` |
| `503` + `Retry-After: 60` | D1 restarting or overloaded | retry once after a minute |
| `503`, no `Retry-After` | `INGEST_TOKEN` not set on this deployment | configure the secret |
| `400` | payload wrong (unknown field, bad metric name, unknown entity) | fix; retrying will not help |
| `401` | wrong token | fix the secret in the reporter |
| `500` | unrecognised failure on this side | read the Worker log |

Resending with the same `dedupeKey` is always safe (`UNIQUE(entity_id, metric,
dedupe_key)`).

## Applying a migration

Migrations are numbered, append-only SQL in `migrations/`; never edit one that
has been applied.

1. Run it locally first: `wrangler d1 migrations apply ops --local`, then
   `npm test` (the suite applies every migration to a fresh database).
2. **State the row-write cost in the PR.** An index or a column over `signals`
   writes one row per existing row when applied:
   `wrangler d1 execute ops --remote --json --command "SELECT COUNT(*) FROM signals"`
   is the number. A backfill statement costs its own rows on top.
3. On the free tier, apply right after 00:00 UTC with nothing else scheduled
   that day, because the cost lands against that day's allowance. On Workers
   Paid the monthly allowance absorbs it; still apply outside the 10:00 UTC
   cron.
4. `wrangler d1 migrations apply ops --remote`, then deploy the code that
   expects the schema (below). Migrations apply before the deploy, never after,
   so a Worker version never runs against a schema it does not expect.

## Deploying

Deploys are manual and always from `main`; CI's `wrangler deploy --dry-run` is
the gate, not the deploy.

```sh
git checkout main && git pull
npm ci
npm run types && npm run typecheck && npm test
wrangler d1 migrations apply ops --remote     # only if migrations/ changed
wrangler deploy
```

Then open `/health` and press **run all pollers now** (or wait for the next hourly cron)
and confirm every poller records a run. `wrangler rollback` restores the
previous version if something is wrong at the Worker level; a migration cannot
be rolled back and needs a forward migration.

## Rotating a secret

```sh
wrangler secret put GITHUB_PAT        # paste the new value at the prompt
```

Secrets take effect on the next request with no redeploy. For the per-owner
GitHub tokens the name is `GITHUB_PAT_<OWNER>` (uppercased, non-alphanumerics
→ `_`). After rotating, `/health` → **run all pollers now** shows within a minute whether
the new value works: a wrong token is a red row with the upstream's error text,
a missing one is `unconfigured`.

Every upstream credential is read-only by design; a rotation is the moment to
check the scope has not grown. `CLOUDFLARE_API_TOKEN` needs Account
Analytics:Read and D1:Read and nothing else.

## Verifying Cloudflare Access

Ops has no login of its own. Access must sit in front of the Worker's
hostname, and the Worker verifies the assertion itself when
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set in `wrangler.jsonc` (the README's
*Access control* section has the setup).

- Keys resolve:
  `curl -s "https://<team>.cloudflareaccess.com/cdn-cgi/access/certs" | jq '.keys | length'`
  should be ≥ 1.
- The Worker enforces: an unauthenticated `curl` of `/` on the deployment URL
  must not return the dashboard. A Worker stays reachable on its `workers.dev`
  hostname regardless of any zone-level policy, so test that hostname too.
- The two machine routes are exempt from Access and authenticate with their
  own bearer tokens: `POST /ingest` (`INGEST_TOKEN`) and `GET /digest/md`
  (`DIGEST_TOKEN`). Access needs a bypass policy or a service token for
  exactly those two paths and no others.

## Local development

```sh
npm install
wrangler d1 migrations apply ops --local
cp .dev.vars.example .dev.vars           # then fill in any real read-only keys you want locally
npm run dev                              # http://localhost:8787
```

Seed it by POSTing the README's ingest payload with `Authorization: Bearer dev-token`,
or set a real `GITHUB_PAT` in `.dev.vars` and press **run all pollers now** on `/health`.
`.dev.vars` is gitignored; `.dev.vars.example` carries placeholders only.
