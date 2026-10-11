import type { Poller, PollerResult, SignalInsert } from "./types";

// Checks every deployed site the github poller knows about (repo metadata
// homepage — set the Website field on GitHub to enroll a site). Down = the
// most important fact a portfolio dashboard can know, so failures are sev 3.
//
// MAX_TARGETS bounds this poller's share of the invocation's subrequest budget
// (every hourly poller runs in one cron invocation). The cap is never silent:
// past it the run reports "monitoring N of M sites" via PollerResult.notes, so
// /health shows the gap calmly instead of the map's "Website field gets uptime
// monitoring" promise breaking quietly. Targets are checked in stable id order
// so the same sites are monitored run after run, not whichever rows D1 returned
// first. CONCURRENCY keeps the fan-out bounded so raising the cap is safe.
export const MAX_TARGETS = 25;
const CONCURRENCY = 8;
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 5;

// A site behind Cloudflare Access answers an anonymous request with a redirect
// to the team's login page, and that page answers 200. Following the redirect
// blindly reported "up" for a page that is not the site (#111): the check
// proved Cloudflare's login was reachable and nothing about the app. So
// redirects are walked by hand, and landing on an Access login is its own
// state rather than a success.
//
// "gated": behind Access and no service token is configured for the host. The
// app was not checked, so it is neither up nor down — calm severity 1.
// "refused": a service token was sent and Access still asked for a login. The
// token expired or no Service Auth policy admits it; the monitor is broken,
// which is a finding in its own right — severity 2.
type State = "up" | "down" | "gated" | "refused";
const SEVERITY: Record<State, 0 | 1 | 2 | 3> = { up: 0, gated: 1, refused: 2, down: 3 };
const TEXT: Record<State, string> = {
  up: "up",
  down: "down",
  gated: "behind Cloudflare Access; not checked (no service token for this host)",
  refused: "Cloudflare Access refused the service token; site not checked",
};

const isAccessLogin = (url: URL): boolean =>
  url.hostname.endsWith(".cloudflareaccess.com") && url.pathname.startsWith("/cdn-cgi/access/login");

interface AccessToken {
  hosts: ReadonlySet<string>;
  id: string;
  secret: string;
}

// The service token is a credential, so it goes only to hosts the deployment
// named (UPTIME_ACCESS_HOSTS), only over https, and is re-decided on every
// hop: a redirect to any other host is followed without it. A homepage is
// whatever a repo's Website field says, and must never be able to collect it.
const tokenHeaders = (url: URL, access: AccessToken | null): Record<string, string> =>
  access && url.protocol === "https:" && access.hosts.has(url.hostname)
    ? { "cf-access-client-id": access.id, "cf-access-client-secret": access.secret }
    : {};

async function probe(target: string, access: AccessToken | null): Promise<State> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = new URL(target);
  // the first request goes to the homepage exactly as the Website field has it
  let href = target;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const credentials = tokenHeaders(url, access);
    const res = await fetch(href, {
      redirect: "manual",
      signal,
      headers: { "user-agent": "ops-dashboard-uptime", ...credentials },
    });
    if (res.status < 300 || res.status >= 400) return res.ok ? "up" : "down";
    const location = res.headers.get("location");
    await res.body?.cancel();
    if (!location) return "down";
    const next = new URL(location, url);
    if (isAccessLogin(next)) return "cf-access-client-id" in credentials ? "refused" : "gated";
    url = next;
    href = next.toString();
  }
  return "down"; // a redirect loop is not a working site
}

const parseHosts = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

export const uptime: Poller = {
  id: "uptime",
  schedule: "hourly",
  metricSemantics: {
    "site.up": "state",
    "site.response_ms": "state",
  },
  async poll(env, ctx) {
    const repos = await ctx.listEntities("repo");
    const eligible = repos
      .filter((e) => !e.archived)
      .map((e) => ({ id: e.id, url: e.metadata?.homepage }))
      .filter((t): t is { id: string; url: string } => typeof t.url === "string" && t.url.startsWith("http"))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const targets = eligible.slice(0, MAX_TARGETS);
    const notes: string[] = [];
    if (eligible.length > MAX_TARGETS) {
      notes.push(`monitoring ${MAX_TARGETS} of ${eligible.length} sites — the rest have no site.up signal (cap: MAX_TARGETS in pollers/uptime.ts)`);
    }

    const hosts = parseHosts(env.UPTIME_ACCESS_HOSTS);
    const id = env.UPTIME_ACCESS_CLIENT_ID;
    const secret = env.UPTIME_ACCESS_CLIENT_SECRET;
    const access: AccessToken | null = hosts.size > 0 && id && secret ? { hosts, id, secret } : null;
    if (hosts.size > 0 && !access) {
      notes.push("UPTIME_ACCESS_HOSTS is set but the service token is not: set UPTIME_ACCESS_CLIENT_ID and UPTIME_ACCESS_CLIENT_SECRET to check those sites");
    }

    const now = Math.floor(Date.now() / 1000);
    const hourBucket = String(now - (now % 3600));
    const signals: SignalInsert[] = [];

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      await Promise.all(
        targets.slice(i, i + CONCURRENCY).map(async ({ id: entityId, url }) => {
          const t0 = Date.now();
          let state: State;
          try {
            state = await probe(url, access);
          } catch {
            state = "down";
          }
          const elapsed = Date.now() - t0;
          signals.push({
            entityId,
            metric: "site.up",
            // 1 / 0 only when the site itself answered; a gated or refused
            // check has no number, because it did not measure the site.
            valueNum: state === "up" ? 1 : state === "down" ? 0 : undefined,
            valueText: TEXT[state],
            severity: SEVERITY[state],
            url,
            observedAt: now,
            dedupeKey: hourBucket,
          });
          if (state === "up") {
            signals.push({
              entityId,
              metric: "site.response_ms",
              valueNum: elapsed,
              url,
              observedAt: now,
              dedupeKey: hourBucket,
            });
          }
        }),
      );
    }

    return { entities: [], signals, ...(notes.length > 0 ? { notes } : {}) } satisfies PollerResult;
  },
};
