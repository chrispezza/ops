import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// Cloudflare account telemetry via a SCOPED read-only API token (Account
// Analytics:Read + D1:Read — never the Global key). Two things uptime can't
// see: per-Worker error rates (a site can be "up" while erroring) and D1
// database sizes (turns the signal-retention question into a trendline).
const GQL = "https://api.cloudflare.com/client/v4/graphql";
const REST = "https://api.cloudflare.com/client/v4";
const LOOKBACK_DAYS = 3;
const DAY = 86_400;
const MIN_REQUESTS_FOR_RATE = 100; // below this a rate is reported calmly, never flagged

// Outcomes the deployed code caused. Everything else — loadShed (runtime
// shedding during a version swap), clientDisconnected, canceled,
// responseStreamDisconnected, internalError — is platform or client behaviour
// and must not read as an application error (deprep#63: three loadSheds in
// one deploy hour were reported as a 1.51% error rate for ten days).
const APP_ERROR_STATUSES = new Set(["scriptThrew", "exceededCpu", "exceededMemory", "exceededResources"]);

const WORKERS_QUERY = /* GraphQL */ `
  query ($accountTag: String!, $start: Date!, $end: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 5000, filter: { date_geq: $start, date_leq: $end }) {
          dimensions {
            scriptName
            date
            status
          }
          sum {
            requests
          }
        }
      }
    }
  }
`;

interface WorkersRow {
  dimensions: { scriptName: string; date: string; status: string };
  sum: { requests: number };
}

interface GqlResponse {
  data?: { viewer: { accounts: { workersInvocationsAdaptive: WorkersRow[] }[] } };
  errors?: { message: string }[];
}

interface DayTotals {
  requests: number;
  errors: number;
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
    if (!account) throw new Error("unconfigured: set the CF_ACCOUNT_ID var to enable this poller");

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

    // Fold status rows into per-script, per-day totals; only app-caused
    // outcomes count as errors.
    const rows = gql.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
    const byScript = new Map<string, Map<string, DayTotals>>();
    for (const row of rows) {
      const script = row.dimensions.scriptName;
      if (!script) continue;
      const days = byScript.get(script) ?? new Map<string, DayTotals>();
      const day = days.get(row.dimensions.date) ?? { requests: 0, errors: 0 };
      day.requests += row.sum.requests;
      if (APP_ERROR_STATUSES.has(row.dimensions.status)) day.errors += row.sum.requests;
      days.set(row.dimensions.date, day);
      byScript.set(script, days);
    }

    for (const [script, days] of byScript) {
      const id = `worker:${script}`;
      entities.set(id, {
        id,
        kind: "worker",
        category: "vendor_api",
        name: script,
        sourceUrl: `https://dash.cloudflare.com/${account}/workers/services/view/${script}`,
      });
      for (const [date, day] of days) {
        const periodStart = Math.floor(Date.parse(date) / 1000);
        const period = { start: periodStart, end: periodStart + DAY };
        const base = { entityId: id, observedAt: period.end, period, dedupeKey: String(periodStart) };
        signals.push(
          { ...base, metric: "cf.requests", valueNum: day.requests },
          { ...base, metric: "cf.errors", valueNum: day.errors },
        );
      }

      // Error rate is a state metric: "latest wins", so it must be re-emitted
      // on every run or a stale value stands as truth (deprep#63). It is
      // rated over the last *complete* day — today's bucket is partial at poll
      // time and rarely clears the sample floor — falling back to the whole
      // complete window when that day is thin. A thin window is still
      // reported, calmly, rather than skipped.
      const complete = [...days].filter(([date]) => date < end).sort(([a], [b]) => a.localeCompare(b));
      const last = complete.at(-1);
      if (!last) continue; // deployed today: nothing complete to rate yet
      const window =
        last[1].requests >= MIN_REQUESTS_FOR_RATE
          ? { label: `on ${last[0]}`, ...last[1] }
          : complete.reduce(
              (acc, [, day]) => ({ ...acc, requests: acc.requests + day.requests, errors: acc.errors + day.errors }),
              { label: complete.length === 1 ? `on ${last[0]}` : `over ${complete.length} days`, requests: 0, errors: 0 },
            );
      const thin = window.requests < MIN_REQUESTS_FOR_RATE;
      const rate = window.requests ? (window.errors / window.requests) * 100 : 0;
      signals.push({
        entityId: id,
        metric: "cf.error_rate",
        valueNum: Math.round(rate * 100) / 100,
        valueText: `${window.errors} of ${window.requests} requests ${window.label}${thin ? " (small sample)" : ""}`,
        severity: thin ? 0 : rate > 5 ? 3 : rate > 1 ? 2 : 0,
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
