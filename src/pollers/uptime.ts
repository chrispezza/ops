import type { Poller, PollerResult, SignalInsert } from "./types";

// Checks every deployed site the github poller knows about (repo metadata
// homepage — set the Website field on GitHub to enroll a site). Down = the
// most important fact a portfolio dashboard can know, so failures are sev 3.
const MAX_TARGETS = 25;
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
    const targets = repos
      .filter((e) => !e.archived)
      .map((e) => ({ id: e.id, url: e.metadata?.homepage }))
      .filter((t): t is { id: string; url: string } => typeof t.url === "string" && t.url.startsWith("http"))
      .slice(0, MAX_TARGETS);

    const now = Math.floor(Date.now() / 1000);
    const hourBucket = String(now - (now % 3600));
    const signals: SignalInsert[] = [];

    await Promise.all(
      targets.map(async ({ id, url }) => {
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

    return { entities: [], signals } satisfies PollerResult;
  },
};
