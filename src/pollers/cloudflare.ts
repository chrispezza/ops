import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// Cloudflare account telemetry via a SCOPED read-only API token (Account
// Analytics:Read + D1:Read — never the Global key). Two things uptime can't
// see: per-Worker error rates (a site can be "up" while erroring) and D1
// database sizes (turns the signal-retention question into a trendline).
const GQL = "https://api.cloudflare.com/client/v4/graphql";
const REST = "https://api.cloudflare.com/client/v4";
const LOOKBACK_DAYS = 3;
const DAY = 86_400;
const MIN_REQUESTS_FOR_RATE = 100; // don't flag error rates on tiny samples

const WORKERS_QUERY = /* GraphQL */ `
  query ($accountTag: String!, $start: Date!, $end: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 1000, filter: { date_geq: $start, date_leq: $end }) {
          dimensions {
            scriptName
            date
          }
          sum {
            requests
            errors
          }
        }
      }
    }
  }
`;

interface WorkersRow {
  dimensions: { scriptName: string; date: string };
  sum: { requests: number; errors: number };
}

interface GqlResponse {
  data?: { viewer: { accounts: { workersInvocationsAdaptive: WorkersRow[] }[] } };
  errors?: { message: string }[];
}

export const cloudflare: Poller = {
  id: "cloudflare",
  schedule: "daily",
  metricSemantics: {
    "cf.requests": "interval",
    "cf.errors": "interval",
    "cf.error_rate": "state",
    "d1.size_bytes": "state",
  },
  async poll(env) {
    const token = env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error("unconfigured: set the CLOUDFLARE_API_TOKEN secret (Analytics:Read + D1:Read) to enable this poller");
    const account = env.CF_ACCOUNT_ID;
    if (!account) throw new Error("cloudflare: CF_ACCOUNT_ID var is not set");

    const now = Math.floor(Date.now() / 1000);
    const dayBucket = String(now - (now % DAY));
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "ops-dashboard" };
    const entities = new Map<string, EntityUpsert>();
    const signals: SignalInsert[] = [];

    // —— Workers analytics, daily buckets over the settle window ——
    const end = new Date(now * 1000).toISOString().slice(0, 10);
    const start = new Date((now - LOOKBACK_DAYS * DAY) * 1000).toISOString().slice(0, 10);
    const gqlRes = await fetch(GQL, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: WORKERS_QUERY, variables: { accountTag: account, start, end } }),
    });
    if (!gqlRes.ok) throw new Error(`cloudflare: HTTP ${gqlRes.status} from analytics`);
    const gql = (await gqlRes.json()) as GqlResponse;
    if (!gql.data) throw new Error(`cloudflare: ${gql.errors?.[0]?.message ?? "empty analytics response"}`);

    const rows = gql.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
    const latestByScript = new Map<string, WorkersRow>();
    for (const row of rows) {
      const script = row.dimensions.scriptName;
      if (!script) continue;
      const id = `worker:${script}`;
      entities.set(id, {
        id,
        kind: "worker",
        category: "vendor_api",
        name: script,
        sourceUrl: `https://dash.cloudflare.com/${account}/workers/services/view/${script}`,
      });
      const periodStart = Math.floor(Date.parse(row.dimensions.date) / 1000);
      const period = { start: periodStart, end: periodStart + DAY };
      const base = { entityId: id, observedAt: period.end, period, dedupeKey: String(periodStart) };
      signals.push(
        { ...base, metric: "cf.requests", valueNum: row.sum.requests },
        { ...base, metric: "cf.errors", valueNum: row.sum.errors },
      );
      const prev = latestByScript.get(script);
      if (!prev || row.dimensions.date > prev.dimensions.date) latestByScript.set(script, row);
    }
    for (const [script, row] of latestByScript) {
      if (row.sum.requests < MIN_REQUESTS_FOR_RATE) continue;
      const rate = (row.sum.errors / row.sum.requests) * 100;
      signals.push({
        entityId: `worker:${script}`,
        metric: "cf.error_rate",
        valueNum: Math.round(rate * 100) / 100,
        valueText: `${row.sum.errors} of ${row.sum.requests} requests`,
        severity: rate > 5 ? 3 : rate > 1 ? 2 : 0,
        url: `https://dash.cloudflare.com/${account}/workers/services/view/${script}`,
        observedAt: now,
        dedupeKey: dayBucket,
      });
    }

    // —— D1 sizes ——
    const dbRes = await fetch(`${REST}/accounts/${account}/d1/database?per_page=100`, { headers });
    if (!dbRes.ok) throw new Error(`cloudflare: HTTP ${dbRes.status} from d1 list`);
    const dbs = (await dbRes.json()) as { result?: { uuid: string; name: string; file_size?: number }[] };
    for (const db of dbs.result ?? []) {
      let size = db.file_size;
      if (size == null) {
        const detail = await fetch(`${REST}/accounts/${account}/d1/database/${db.uuid}`, { headers });
        if (detail.ok) size = ((await detail.json()) as { result?: { file_size?: number } }).result?.file_size;
      }
      if (size == null) continue;
      const id = `d1:${db.name}`;
      entities.set(id, {
        id,
        kind: "database",
        category: "vendor_api",
        name: `D1 ${db.name}`,
        sourceUrl: `https://dash.cloudflare.com/${account}/workers/d1/databases/${db.uuid}`,
      });
      signals.push({
        entityId: id,
        metric: "d1.size_bytes",
        valueNum: size,
        observedAt: now,
        dedupeKey: dayBucket,
      });
    }

    return { entities: [...entities.values()], signals } satisfies PollerResult;
  },
};
