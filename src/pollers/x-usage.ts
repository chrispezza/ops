import type { Poller, PollerResult } from "./types";

// X API v2 usage caps — there is no spend API (X API cost is a flat
// subscription; track that via a prepaid balance/settings entry). What IS
// queryable is the monthly post-cap consumption, which is the operational
// signal: approaching the cap is what breaks integrations.
const API = "https://api.twitter.com/2/usage/tweets";
const ENTITY_ID = "vendor_api:x";

interface UsageResponse {
  data?: {
    cap_reset_day?: number;
    project_cap?: string | number;
    project_usage?: string | number;
  };
}

export const xUsage: Poller = {
  id: "x_usage",
  schedule: "daily",
  metricSemantics: {
    "usage.monthly_posts": "state",
    "usage.cap_pct": "state",
  },
  async poll(env) {
    const token = env.X_BEARER_TOKEN;
    if (!token) throw new Error("unconfigured: set the X_BEARER_TOKEN secret to enable this poller");

    const res = await fetch(API, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "ops-dashboard" },
    });
    if (!res.ok) throw new Error(`x_usage: HTTP ${res.status}`);
    const body = (await res.json()) as UsageResponse;
    const usage = Number(body.data?.project_usage ?? Number.NaN);
    const cap = Number(body.data?.project_cap ?? Number.NaN);
    if (!Number.isFinite(usage) || !Number.isFinite(cap) || cap <= 0) {
      throw new Error("x_usage: unexpected response shape");
    }

    const now = Math.floor(Date.now() / 1000);
    const dayBucket = String(now - (now % 86_400));
    const pct = Math.round((usage / cap) * 100);

    return {
      entities: [
        {
          id: ENTITY_ID,
          kind: "vendor_api",
          category: "vendor_api",
          name: "X API",
          sourceUrl: "https://developer.x.com/en/portal/dashboard",
        },
      ],
      signals: [
        {
          entityId: ENTITY_ID,
          metric: "usage.monthly_posts",
          valueNum: usage,
          valueText: `${usage} of ${cap}`,
          observedAt: now,
          dedupeKey: dayBucket,
        },
        {
          entityId: ENTITY_ID,
          metric: "usage.cap_pct",
          valueNum: pct,
          severity: pct >= 95 ? 3 : pct >= 80 ? 2 : 0, // near-cap is what breaks integrations
          url: "https://developer.x.com/en/portal/dashboard",
          observedAt: now,
          dedupeKey: dayBucket,
        },
      ],
    } satisfies PollerResult;
  },
};
