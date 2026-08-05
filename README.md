# Ops

Read-mostly aggregation dashboard for dev-project portfolios, on Cloudflare Workers + D1.

Two jobs:

1. **Spend** — monitor consumptive cost (API tokens, usage-billed services) against budgets.
2. **Triage** — rank entities (repos, plugins, skills, vendor APIs) by what needs attention, deep-linking to the real system of record for action.

Read here, act there: the only write-shaped affordance is a pre-filled new-issue link.

## Docs

- [ops-spec.md](ops-spec.md) — architecture, data model, poller interface
- [ops-ux.md](ops-ux.md) — pages, URLs, states
- [ops-plan.md](ops-plan.md) — implementation phases

## Development

```sh
npm install
npm run dev        # local dev server (local D1)
npm test           # vitest against real workerd
npm run typecheck
```

## Deployment

```sh
wrangler d1 create ops          # once; put the id in wrangler.jsonc
wrangler d1 migrations apply ops --remote
wrangler secret put GITHUB_PAT
wrangler deploy
```

Put Cloudflare Access in front of the Worker; there is no app-level auth.
