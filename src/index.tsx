import { Hono } from "hono";
import { EXPECTED_METRICS, TRIAGE_WEIGHTS, type TriageWeights } from "./config";
import {
  type BalanceEntry,
  type BudgetRow,
  deriveBalances,
  detectSpendAnomalies,
  emitHygieneSignals,
  evaluateBudgets,
} from "./core/derive";
import { notifyNewAlerts } from "./core/notify";
import {
  archivedEntities,
  entitiesWithLatest,
  findings,
  getEntity,
  getSetting,
  latestByMetric,
  intervalSums,
  latestSignals,
  pollerHealth,
  putSetting,
  setArchived,
  signalHistory,
  spendByEntity,
  usageSums,
} from "./core/queries";
import { runPollers } from "./core/runner";
import { activityAt, computeScore, hasUsageSemantics } from "./core/score";
import { handleIngest } from "./ingest";
import { FreshnessChip, Layout } from "./ui/layout";
import { FindingsPage } from "./ui/pages/findings";
import { EntityPage, HistoryRows } from "./ui/pages/entity";
import { HealthPage } from "./ui/pages/health";
import { MapPage } from "./ui/pages/map";
import { SettingsPage } from "./ui/pages/settings";
import { type SpendEntity, SpendPage } from "./ui/pages/spend";
import { TriagePage, type TriageRow } from "./ui/pages/triage";

// Spec §5: hourly cron runs hourly pollers, daily cron (~06:00 ET) runs daily.
const DAILY_CRON = "0 10 * * *";
const DAY = 86_400;

const app = new Hono<{ Bindings: Env }>();

const epochNow = () => Math.floor(Date.now() / 1000);

async function scoredViews(db: D1Database, now: number): Promise<TriageRow[]> {
  const [views, usage, weights] = await Promise.all([
    entitiesWithLatest(db),
    usageSums(db, "usage.invocations", now - 30 * DAY),
    getSetting<TriageWeights>(db, "triage_weights"),
  ]);
  // the zero-usage bonus only means something once usage telemetry exists at
  // all — before that it's a flat +5 for every skill repo, pure noise
  const usageDataExists = usage.size > 0;
  return views.map((view) => ({
    view,
    score: computeScore(
      view,
      now,
      hasUsageSemantics(view) && usageDataExists ? (usage.get(view.id) ?? 0) : null,
      weights ?? TRIAGE_WEIGHTS,
    ),
    // 30d SUM for the map chip (spec §2.2: interval metrics aggregate, never "latest")
    usage30d: hasUsageSemantics(view) ? (usage.get(view.id) ?? null) : null,
  }));
}

function sortRows(rows: TriageRow[], sort: string, now: number): TriageRow[] {
  const latestNum = (r: TriageRow, metric: string) => r.view.latest[metric]?.value_num ?? -1;
  switch (sort) {
    case "name":
      return rows.sort((a, b) => a.view.name.localeCompare(b.view.name));
    case "stale":
      return rows.sort((a, b) => activityAt(a.view) - activityAt(b.view));
    case "issues":
      return rows.sort((a, b) => latestNum(b, "issues.open") - latestNum(a, "issues.open"));
    case "vulns":
      return rows.sort((a, b) => latestNum(b, "deps.vuln_count") - latestNum(a, "deps.vuln_count"));
    default:
      return rows.sort((a, b) => b.score.total - a.score.total);
  }
}

// Spec §3: derived signals run after every poll cycle.
async function derivePass(env: Env, now: number): Promise<void> {
  await emitHygieneSignals(env.DB, EXPECTED_METRICS, now);
  await evaluateBudgets(env.DB, now);
  await detectSpendAnomalies(env.DB, now);
  await deriveBalances(env.DB, now);
  await notifyNewAlerts(env.DB, env, now);
}

function distinctOwners(rows: TriageRow[]): string[] {
  return [...new Set(rows.map((r) => r.view.owner).filter((o): o is string => !!o))].sort();
}

app.get("/", async (c) => {
  const now = epochNow();
  const q = c.req.query("q")?.toLowerCase();
  const owner = c.req.query("owner") || undefined;
  const [rows, health, archived] = await Promise.all([
    scoredViews(c.env.DB, now),
    pollerHealth(c.env.DB),
    archivedEntities(c.env.DB),
  ]);
  const owners = distinctOwners(rows);
  const filtered = rows
    .filter((r) => !q || r.view.name.toLowerCase().includes(q))
    .filter((r) => !owner || r.view.owner === owner);
  return c.html(
    <Layout path="/" health={health} now={now}>
      <MapPage rows={filtered} archived={archived} q={q} owner={owner} owners={owners} now={now} />
    </Layout>,
  );
});

app.get("/triage", async (c) => {
  const now = epochNow();
  const filters = {
    kind: c.req.query("kind") || undefined,
    category: c.req.query("category") || undefined,
    owner: c.req.query("owner") || undefined,
    minSeverity: Number(c.req.query("min_severity") ?? 0),
    q: c.req.query("q") || undefined,
    sort: c.req.query("sort") || undefined,
  };
  const [rows, health] = await Promise.all([scoredViews(c.env.DB, now), pollerHealth(c.env.DB)]);
  const owners = distinctOwners(rows);
  const filtered = sortRows(
    rows
      .filter((r) => !filters.kind || r.view.kind === filters.kind)
      .filter((r) => !filters.category || r.view.category === filters.category)
      .filter((r) => !filters.owner || r.view.owner === filters.owner)
      .filter((r) => r.view.maxSeverity >= (filters.minSeverity ?? 0))
      .filter((r) => !filters.q || r.view.name.toLowerCase().includes(filters.q.toLowerCase())),
    filters.sort ?? "score",
    now,
  );
  return c.html(
    <Layout path="/triage" title="Triage" health={health} now={now}>
      <TriagePage rows={filtered} filters={filters} owners={owners} now={now} />
    </Layout>,
  );
});

app.get("/e/*", async (c) => {
  const now = epochNow();
  const url = new URL(c.req.url);
  const id = decodeURIComponent(url.pathname.slice(3));
  const offset = Number(c.req.query("offset") ?? 0);

  const entity = await getEntity(c.env.DB, id);
  if (!entity) return c.notFound();

  const history = await signalHistory(c.env.DB, id, 50, offset);
  // load-more swaps just the history fragment
  if (offset > 0 && c.req.header("HX-Request")) {
    return c.html(<HistoryRows entityId={id} history={history} offset={offset} now={now} />);
  }

  const windowDays = Number(c.req.query("window") ?? 30);
  const latest = await latestSignals(c.env.DB, id);
  const intervalMetrics = latest.filter((s) => s.period_start != null).map((s) => s.metric);
  const intervalSeries = await Promise.all(
    intervalMetrics.map(async (metric) => ({
      metric,
      points: await intervalSums(c.env.DB, id, metric, now - windowDays * DAY),
    })),
  );
  const health = await pollerHealth(c.env.DB);
  return c.html(
    <Layout path="/e" title={entity.name} health={health} now={now}>
      <EntityPage entity={entity} latest={latest} history={history} intervalSeries={intervalSeries} now={now} />
    </Layout>,
  );
});

// The one Ops-owned entity mutation (ux §2.5); archived entities stay in history.
app.post("/archive", async (c) => {
  const form = await c.req.formData();
  const id = String(form.get("entity_id") ?? "");
  const archived = form.get("archived") === "1";
  if (id) await setArchived(c.env.DB, id, archived);
  return c.redirect(`/e/${id}`);
});

app.get("/findings", async (c) => {
  const now = epochNow();
  const filters = {
    minSeverity: Number(c.req.query("min_severity") ?? 2), // ux §2.4 default
    domain: c.req.query("domain") || undefined,
    category: c.req.query("category") || undefined,
    group: c.req.query("group") || undefined,
    sort: c.req.query("sort") || undefined,
  };
  const [rows, health] = await Promise.all([findings(c.env.DB, filters), pollerHealth(c.env.DB)]);
  return c.html(
    <Layout path="/findings" title="Findings" health={health} now={now}>
      <FindingsPage rows={rows} filters={filters} now={now} />
    </Layout>,
  );
});

app.post("/ingest", handleIngest);

app.get("/spend", async (c) => {
  const now = epochNow();
  const monthStart = Math.floor(
    Date.UTC(new Date(now * 1000).getUTCFullYear(), new Date(now * 1000).getUTCMonth(), 1) / 1000,
  );
  const today = now - (now % DAY);
  const windowParam = c.req.query("window") ?? "30d";
  const window = windowParam === "90d" ? ("90d" as const) : windowParam === "mtd" ? ("mtd" as const) : ("30d" as const);
  const windowDays = window === "mtd" ? Math.floor((today - monthStart) / DAY) + 1 : window === "90d" ? 90 : 30;
  const since = Math.min(today - (windowDays - 1) * DAY, monthStart);

  const [spend, budgets, health, balances] = await Promise.all([
    spendByEntity(c.env.DB, since),
    c.env.DB.prepare("SELECT * FROM budgets").all<BudgetRow>().then((r) => r.results),
    pollerHealth(c.env.DB),
    latestByMetric(c.env.DB, "balance.usd"),
  ]);

  // balance-only vendors (no spend API, e.g. xAI) still get a spend row
  for (const id of balances.keys()) {
    if (!spend.has(id)) {
      const entity = await getEntity(c.env.DB, id);
      if (entity && !entity.archived) spend.set(id, { name: entity.name, points: [] });
    }
  }

  const entities: SpendEntity[] = await Promise.all(
    [...spend.entries()].map(async ([id, e]) => ({
      id,
      name: e.name,
      points: e.points,
      mtd: e.points.filter((p) => p.period_start >= monthStart).reduce((s, p) => s + p.total, 0),
      today: e.points.find((p) => p.period_start === today)?.total ?? 0,
      anomaly: (await latestSignals(c.env.DB, id)).find((s) => s.metric === "spend.anomaly"),
      balance: balances.get(id),
    })),
  );
  entities.sort((a, b) => b.mtd - a.mtd);
  const orgMtd = entities.reduce((s, e) => s + e.mtd, 0);

  return c.html(
    <Layout path="/spend" title="Spend" health={health} now={now}>
      <SpendPage entities={entities} budgets={budgets} orgMtd={orgMtd} windowDays={windowDays} window={window} now={now} />
    </Layout>,
  );
});

const SETTINGS_ERRORS: Record<string, string> = {
  budget: "Budget not saved: scope is required and hard limit must be ≥ soft limit ≥ 0.",
  balance: "Balance not saved: entity id, name, non-negative amount, and a valid date are all required.",
};

app.get("/settings", async (c) => {
  const now = epochNow();
  const [budgets, weights, balances, health] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM budgets").all<BudgetRow>().then((r) => r.results),
    getSetting<TriageWeights>(c.env.DB, "triage_weights"),
    getSetting<BalanceEntry[]>(c.env.DB, "balances"),
    pollerHealth(c.env.DB),
  ]);
  const error = SETTINGS_ERRORS[c.req.query("err") ?? ""];
  return c.html(
    <Layout path="/settings" title="Settings" health={health} now={now}>
      <SettingsPage budgets={budgets} weights={weights ?? TRIAGE_WEIGHTS} balances={balances ?? []} error={error} />
    </Layout>,
  );
});

app.post("/settings/balances", async (c) => {
  const form = await c.req.formData();
  const entityId = String(form.get("entity_id") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const startingUsd = Number(form.get("starting_usd"));
  const asOf = Math.floor(Date.parse(String(form.get("as_of") ?? "")) / 1000);
  if (!entityId.includes(":") || !name || !Number.isFinite(startingUsd) || startingUsd < 0 || !Number.isFinite(asOf)) {
    return c.redirect("/settings?err=balance");
  }
  const balances = (await getSetting<BalanceEntry[]>(c.env.DB, "balances")) ?? [];
  const next = balances.filter((b) => b.entityId !== entityId);
  next.push({ entityId, name, startingUsd, asOf });
  await putSetting(c.env.DB, "balances", next);
  await deriveBalances(c.env.DB, epochNow());
  return c.redirect("/settings");
});

app.post("/settings/balances/delete", async (c) => {
  const form = await c.req.formData();
  const entityId = String(form.get("entity_id") ?? "");
  const balances = (await getSetting<BalanceEntry[]>(c.env.DB, "balances")) ?? [];
  await putSetting(c.env.DB, "balances", balances.filter((b) => b.entityId !== entityId));
  return c.redirect("/settings");
});

app.post("/settings/budgets", async (c) => {
  const form = await c.req.formData();
  const scope = String(form.get("scope") ?? "").trim();
  const period = form.get("period") === "day" ? "day" : "month";
  const soft = Number(form.get("soft_limit"));
  const hard = Number(form.get("hard_limit"));
  if (!scope || !Number.isFinite(soft) || !Number.isFinite(hard) || soft < 0 || hard < soft) {
    return c.redirect("/settings?err=budget");
  }
  await c.env.DB.prepare(
    "INSERT INTO budgets (scope, metric, period, soft_limit, hard_limit) VALUES (?1, 'spend.usd', ?2, ?3, ?4)",
  )
    .bind(scope, period, soft, hard)
    .run();
  await evaluateBudgets(c.env.DB, epochNow());
  return c.redirect("/settings");
});

app.post("/settings/budgets/delete", async (c) => {
  const form = await c.req.formData();
  const id = Number(form.get("id"));
  if (Number.isFinite(id)) await c.env.DB.prepare("DELETE FROM budgets WHERE id = ?1").bind(id).run();
  return c.redirect("/settings");
});

app.post("/settings/weights", async (c) => {
  const form = await c.req.formData();
  const num = (name: string, fallback: number) => {
    const v = Number(form.get(name));
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const d = TRIAGE_WEIGHTS;
  const weights: TriageWeights = {
    severityFactor: num("severity_factor", d.severityFactor),
    breadthFactor: num("breadth_factor", d.breadthFactor),
    staleness: [
      { minDays: 90, points: num("staleness_90", 6) },
      { minDays: 30, points: num("staleness_30", 3) },
    ],
    zeroUsageBonus: num("zero_usage_bonus", d.zeroUsageBonus),
  };
  await putSetting(c.env.DB, "triage_weights", weights);
  return c.redirect("/settings");
});

app.get("/health", async (c) => {
  const now = epochNow();
  const health = await pollerHealth(c.env.DB);
  return c.html(
    <Layout path="/health" title="Health" health={health} now={now}>
      <HealthPage health={health} now={now} />
    </Layout>,
  );
});

app.post("/health/run", async (c) => {
  const now = epochNow();
  await runPollers(c.env, "hourly", { now });
  await runPollers(c.env, "daily", { now });
  await derivePass(c.env, now);
  return c.redirect("/health");
});

app.get("/partials/freshness", async (c) => {
  const now = epochNow();
  const health = await pollerHealth(c.env.DB);
  return c.html(<FreshnessChip health={health} now={now} />);
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, _ctx) {
    const now = epochNow();
    await runPollers(env, event.cron === DAILY_CRON ? "daily" : "hourly", { now });
    await derivePass(env, now);
  },
} satisfies ExportedHandler<Env>;
