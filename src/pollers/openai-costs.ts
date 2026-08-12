import type { Poller, PollerResult, SignalInsert } from "./types";

// OpenAI org Costs API — daily buckets, amounts in DOLLARS (Anthropic's are
// cents; each poller owns its vendor's units). Requires an org admin key.
const API = "https://api.openai.com/v1/organization/costs";
const LOOKBACK_DAYS = 8;
const ENTITY_ID = "vendor_api:openai";
const DAY = 86_400;

interface CostBucket {
  start_time: number;
  end_time: number;
  results: { amount: { value: number; currency: string } }[];
}

interface Page {
  data: CostBucket[];
  has_more: boolean;
  next_page: string | null;
}

export const openaiCosts: Poller = {
  id: "openai_costs",
  schedule: "daily",
  metricSemantics: { "spend.usd": "interval" },
  async poll(env) {
    const key = env.OPENAI_ADMIN_KEY;
    if (!key) throw new Error("unconfigured: set the OPENAI_ADMIN_KEY secret to enable this poller");

    const signals: SignalInsert[] = [];
    let page: string | null = null;
    do {
      const url = new URL(API);
      url.searchParams.set("start_time", String(Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * DAY));
      url.searchParams.set("limit", "30");
      if (page) url.searchParams.set("page", page);
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${key}`, "user-agent": "ops-dashboard" },
      });
      if (!res.ok) throw new Error(`openai_costs: HTTP ${res.status}`);
      const body = (await res.json()) as Page;
      for (const bucket of body.data) {
        signals.push({
          entityId: ENTITY_ID,
          metric: "spend.usd",
          valueNum: bucket.results.reduce((sum, r) => sum + r.amount.value, 0),
          observedAt: bucket.end_time,
          period: { start: bucket.start_time, end: bucket.end_time },
          dedupeKey: String(bucket.start_time),
        });
      }
      page = body.has_more ? body.next_page : null;
    } while (page);

    return {
      entities: [
        {
          id: ENTITY_ID,
          kind: "vendor_api",
          category: "vendor_api",
          name: "OpenAI",
          sourceUrl: "https://platform.openai.com/usage",
        },
      ],
      signals,
    } satisfies PollerResult;
  },
};
