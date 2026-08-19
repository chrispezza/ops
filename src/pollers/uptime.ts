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

export const uptime: Poller = {
  id: "uptime",
  schedule: "hourly",
  metricSemantics: {
    "site.up": "state",
    "site.response_ms": "state",
  },
  async poll(_env, ctx) {
    const repos = await ctx.listEntities("repo");
    const eligible = repos
      .filter((e) => !e.archived)
      .map((e) => ({ id: e.id, url: e.metadata?.homepage }))
      .filter((t): t is { id: string; url: string } => typeof t.url === "string" && t.url.startsWith("http"))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const targets = eligible.slice(0, MAX_TARGETS);
    const notes =
      eligible.length > MAX_TARGETS
        ? [`monitoring ${MAX_TARGETS} of ${eligible.length} sites — the rest have no site.up signal (cap: MAX_TARGETS in pollers/uptime.ts)`]
        : undefined;

    const now = Math.floor(Date.now() / 1000);
    const hourBucket = String(now - (now % 3600));
    const signals: SignalInsert[] = [];

    for (let i = 0; i < targets.length; i += CONCURRENCY) {
      await Promise.all(
        targets.slice(i, i + CONCURRENCY).map(async ({ id, url }) => {
          const t0 = Date.now();
          let up = false;
          try {
            const res = await fetch(url, {
              redirect: "follow",
              signal: AbortSignal.timeout(TIMEOUT_MS),
              headers: { "user-agent": "ops-dashboard-uptime" },
            });
            up = res.ok;
          } catch {
            up = false;
          }
          const elapsed = Date.now() - t0;
          signals.push({
            entityId: id,
            metric: "site.up",
            valueNum: up ? 1 : 0,
            valueText: up ? "up" : "down",
            severity: up ? 0 : 3,
            url,
            observedAt: now,
            dedupeKey: hourBucket,
          });
          if (up) {
            signals.push({
              entityId: id,
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

    return { entities: [], signals, ...(notes ? { notes } : {}) } satisfies PollerResult;
  },
};
