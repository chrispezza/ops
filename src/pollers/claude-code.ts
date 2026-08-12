import type { Poller, PollerResult, SignalInsert } from "./types";

// Claude Code Analytics Admin API — daily per-user records; one request per
// day, cursor-paginated. Estimated costs arrive in cents. This is where the
// real AI spend lives for subscription-based Claude Code usage (the regular
// cost report only sees API-key traffic).
const API = "https://api.anthropic.com/v1/organizations/usage_report/claude_code";
const LOOKBACK_DAYS = 8;
const ENTITY_ID = "vendor_api:claude_code";
const DAY = 86_400;

interface CodeRecord {
  core_metrics: {
    num_sessions: number;
    lines_of_code: { added: number; removed: number };
    commits_by_claude_code: number;
  };
  model_breakdown: { estimated_cost: { amount: number; currency: string } }[];
}

interface Page {
  data: CodeRecord[];
  has_more: boolean;
  next_page: string | null;
}

async function fetchDay(key: string, date: string): Promise<CodeRecord[]> {
  const records: CodeRecord[] = [];
  let page: string | null = null;
  do {
    const url = new URL(API);
    url.searchParams.set("starting_at", date);
    url.searchParams.set("limit", "100");
    if (page) url.searchParams.set("page", page);
    const res = await fetch(url, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": "ops-dashboard" },
    });
    if (!res.ok) throw new Error(`claude_code: HTTP ${res.status} for ${date}`);
    const body = (await res.json()) as Page;
    records.push(...body.data);
    page = body.has_more ? body.next_page : null;
  } while (page);
  return records;
}

export const claudeCode: Poller = {
  id: "claude_code",
  schedule: "daily",
  metricSemantics: {
    "spend.usd": "interval",
    "usage.sessions": "interval",
    "usage.loc_added": "interval",
    "usage.commits": "interval",
  },
  async poll(env) {
    const key = env.ANTHROPIC_ADMIN_KEY;
    if (!key) throw new Error("claude_code: ANTHROPIC_ADMIN_KEY secret is not set");

    const signals: SignalInsert[] = [];
    const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;

    for (let i = 0; i < LOOKBACK_DAYS; i++) {
      const start = todayStart - i * DAY;
      const date = new Date(start * 1000).toISOString().slice(0, 10);
      const records = await fetchDay(key, date);
      if (records.length === 0) continue; // no usage that day — emit nothing, not zeros

      const period = { start, end: start + DAY };
      const sum = (f: (r: CodeRecord) => number) => records.reduce((total, r) => total + f(r), 0);
      const cents = sum((r) => r.model_breakdown.reduce((t, m) => t + m.estimated_cost.amount, 0));

      const base = { entityId: ENTITY_ID, observedAt: period.end, period, dedupeKey: String(start) };
      signals.push(
        { ...base, metric: "spend.usd", valueNum: cents / 100 },
        { ...base, metric: "usage.sessions", valueNum: sum((r) => r.core_metrics.num_sessions) },
        { ...base, metric: "usage.loc_added", valueNum: sum((r) => r.core_metrics.lines_of_code.added) },
        { ...base, metric: "usage.commits", valueNum: sum((r) => r.core_metrics.commits_by_claude_code) },
      );
    }

    return {
      entities: [
        {
          id: ENTITY_ID,
          kind: "vendor_api",
          category: "vendor_api",
          name: "Claude Code",
          sourceUrl: "https://platform.claude.com/claude-code",
        },
      ],
      signals,
    } satisfies PollerResult;
  },
};
