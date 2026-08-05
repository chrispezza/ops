import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// Anthropic Admin API — usage & cost reports, daily buckets, last 8 days so
// settling data (up to a few hours late) converges via dedupe-key overwrite.
const API = "https://api.anthropic.com/v1/organizations";
const LOOKBACK_DAYS = 8;

// Spec §3.1 deviation, recorded here: the cost report is org-granular (the
// Admin API does not break cost down by api key), so spend.usd attaches to a
// single vendor_api:anthropic entity; per-key entities carry token usage.
const ORG_ENTITY_ID = "vendor_api:anthropic";

interface Bucket<T> {
  starting_at: string;
  ending_at: string;
  results: T[];
}

interface Paged<T> {
  data: Bucket<T>[];
  has_more: boolean;
  next_page: string | null;
}

interface CostResult {
  amount: string; // decimal string in lowest currency units (cents)
  currency: string;
}

interface UsageResult {
  api_key_id: string | null;
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  output_tokens: number;
}

async function adminGet<T>(key: string, path: string, params: Record<string, string>): Promise<Bucket<T>[]> {
  const buckets: Bucket<T>[] = [];
  let page: string | null = null;
  do {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "user-agent": "ops-dashboard",
      },
    });
    if (!res.ok) throw new Error(`anthropic_usage: HTTP ${res.status} for ${path}`);
    const body = (await res.json()) as Paged<T>;
    buckets.push(...body.data);
    page = body.has_more ? body.next_page : null;
  } while (page);
  return buckets;
}

async function apiKeyNames(key: string): Promise<Map<string, string>> {
  const res = await fetch(`${API}/api_keys?limit=100`, {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": "ops-dashboard" },
  });
  if (!res.ok) return new Map(); // names are cosmetic — degrade, don't fail the poll
  const body = (await res.json()) as { data: { id: string; name: string }[] };
  return new Map(body.data.map((k) => [k.id, k.name]));
}

const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const anthropicUsage: Poller = {
  id: "anthropic_usage",
  schedule: "daily",
  metricSemantics: {
    "spend.usd": "interval",
    "usage.tokens_in": "interval",
    "usage.tokens_out": "interval",
  },
  async poll(env) {
    const key = env.ANTHROPIC_ADMIN_KEY;
    if (!key) throw new Error("anthropic_usage: ANTHROPIC_ADMIN_KEY secret is not set");

    const startingAt = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
    const entities = new Map<string, EntityUpsert>();
    const signals: SignalInsert[] = [];

    entities.set(ORG_ENTITY_ID, {
      id: ORG_ENTITY_ID,
      kind: "vendor_api",
      category: "vendor_api",
      name: "Anthropic",
      sourceUrl: "https://console.anthropic.com/settings/usage",
    });

    const costBuckets = await adminGet<CostResult>(key, "/cost_report", {
      starting_at: startingAt,
      bucket_width: "1d",
    });
    for (const bucket of costBuckets) {
      const period = { start: epoch(bucket.starting_at), end: epoch(bucket.ending_at) };
      const cents = bucket.results.reduce((sum, r) => sum + Number.parseFloat(r.amount), 0);
      signals.push({
        entityId: ORG_ENTITY_ID,
        metric: "spend.usd",
        valueNum: cents / 100,
        observedAt: period.end,
        period,
        dedupeKey: String(period.start), // spec §2.3: interval metrics dedupe on period_start
      });
    }

    const [names, usageBuckets] = await Promise.all([
      apiKeyNames(key),
      adminGet<UsageResult>(key, "/usage_report/messages", {
        starting_at: startingAt,
        bucket_width: "1d",
        "group_by[]": "api_key_id",
      }),
    ]);
    for (const bucket of usageBuckets) {
      const period = { start: epoch(bucket.starting_at), end: epoch(bucket.ending_at) };
      for (const r of bucket.results) {
        if (!r.api_key_id) continue; // console/workbench usage has no key attribution
        const id = `api_key:${r.api_key_id}`;
        entities.set(id, {
          id,
          kind: "api_key",
          category: "vendor_api",
          name: names.get(r.api_key_id) ?? r.api_key_id,
          owner: "anthropic",
          sourceUrl: "https://console.anthropic.com/settings/keys",
        });
        const tokensIn =
          r.uncached_input_tokens +
          r.cache_read_input_tokens +
          r.cache_creation.ephemeral_1h_input_tokens +
          r.cache_creation.ephemeral_5m_input_tokens;
        signals.push(
          {
            entityId: id,
            metric: "usage.tokens_in",
            valueNum: tokensIn,
            observedAt: period.end,
            period,
            dedupeKey: String(period.start),
          },
          {
            entityId: id,
            metric: "usage.tokens_out",
            valueNum: r.output_tokens,
            observedAt: period.end,
            period,
            dedupeKey: String(period.start),
          },
        );
      }
    }

    return { entities: [...entities.values()], signals } satisfies PollerResult;
  },
};
