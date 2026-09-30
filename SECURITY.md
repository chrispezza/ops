# Security

Ops is a read-mostly dashboard: it holds read-only upstream credentials and a
copy of portfolio state, and it sits behind Cloudflare Access. The security
model is in the README (*Access control*) and the invariants in
[CLAUDE.md](CLAUDE.md) (*Security invariants*). In short:

- No login of its own; Cloudflare Access in front, with the assertion verified
  in the Worker when `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set (RS256 only).
- Every state-mutating `POST` requires a same-origin `Origin` header.
- `POST /ingest` and `GET /digest/md` are the only routes exempt from both,
  each behind its own bearer token compared in constant time.
- All upstream credentials are read-only by design; Ops never writes to GitHub
  or any vendor ([ADR-001](docs/adr/001-read-mostly-system-of-record.md)).
- Input is validated at the boundary; `/ingest` rejects unknown fields.
- The `judge` poller sends issue text to a third party (TypeSafe); `JUDGE_SCOPE`
  bounds how much ([ADR-006](docs/adr/006-advisory-judge-signals.md)).

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it through GitHub's private advisory form for this repository:
<https://github.com/chrispezza/ops/security/advisories/new>. If that form is
unavailable, open an issue titled only "security: please contact me" with no
details, and the maintainer will reach out.

Include what you found, how to reproduce it, and what you think the impact is.
You will get an acknowledgement within a week. Fixes ship on `main`, which is
the only supported version; there are no release branches.

## Scope

In scope: this repository's code and the default `wrangler.jsonc` shape. A
deployment's own Access policy, secrets and account settings are the
deployer's; the README says what must be in place before real data goes in.

Out of scope: vulnerabilities in the upstream services Ops reads from, and
findings that require an already-authenticated Access user (the dashboard
assumes every reader is the maintainer).
