import { Hono } from "hono";
import { EXPECTED_METRICS } from "./config";
import { emitHygieneSignals } from "./core/derive";
import {
  entitiesWithLatest,
  getEntity,
  intervalSums,
  latestSignals,
  pollerHealth,
  setArchived,
  signalHistory,
  usageSums,
} from "./core/queries";
import { runPollers } from "./core/runner";
import { computeScore, hasUsageSemantics } from "./core/score";
import { FreshnessChip, Layout } from "./ui/layout";
import { EntityPage, HistoryRows } from "./ui/pages/entity";
import { HealthPage } from "./ui/pages/health";
import { MapPage } from "./ui/pages/map";
import { TriagePage, type TriageRow } from "./ui/pages/triage";

// Spec §5: hourly cron runs hourly pollers, daily cron (~06:00 ET) runs daily.
const DAILY_CRON = "0 10 * * *";
const DAY = 86_400;

const app = new Hono<{ Bindings: Env }>();

const epochNow = () => Math.floor(Date.now() / 1000);

async function scoredViews(db: D1Database, now: number): Promise<TriageRow[]> {
  const [views, usage] = await Promise.all([
    entitiesWithLatest(db),
    usageSums(db, "usage.invocations", now - 30 * DAY),
  ]);
  return views.map((view) => ({
    view,
    score: computeScore(view, now, hasUsageSemantics(view) ? (usage.get(view.id) ?? 0) : null),
  }));
}

app.get("/", async (c) => {
  const now = epochNow();
  const q = c.req.query("q")?.toLowerCase();
  const [rows, health] = await Promise.all([scoredViews(c.env.DB, now), pollerHealth(c.env.DB)]);
  const filtered = q ? rows.filter((r) => r.view.name.toLowerCase().includes(q)) : rows;
  return c.html(
    <Layout path="/" health={health} now={now}>
      <MapPage rows={filtered} q={q} now={now} />
    </Layout>,
  );
});

app.get("/triage", async (c) => {
  const now = epochNow();
  const filters = {
    kind: c.req.query("kind") || undefined,
    category: c.req.query("category") || undefined,
    minSeverity: Number(c.req.query("min_severity") ?? 0),
    q: c.req.query("q") || undefined,
  };
  const [rows, health] = await Promise.all([scoredViews(c.env.DB, now), pollerHealth(c.env.DB)]);
  const filtered = rows
    .filter((r) => !filters.kind || r.view.kind === filters.kind)
    .filter((r) => !filters.category || r.view.category === filters.category)
    .filter((r) => r.view.maxSeverity >= (filters.minSeverity ?? 0))
    .filter((r) => !filters.q || r.view.name.toLowerCase().includes(filters.q.toLowerCase()))
    .sort((a, b) => b.score.total - a.score.total);
  return c.html(
    <Layout path="/triage" title="Triage" health={health} now={now}>
      <TriagePage rows={filtered} filters={filters} now={now} />
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
  await emitHygieneSignals(c.env.DB, EXPECTED_METRICS, now);
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
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, now);
  },
} satisfies ExportedHandler<Env>;
