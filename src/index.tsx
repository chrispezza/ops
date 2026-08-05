import { Hono } from "hono";
import { EXPECTED_METRICS } from "./config";
import { emitHygieneSignals } from "./core/derive";
import { entitiesWithLatest, pollerHealth } from "./core/queries";
import { runPollers } from "./core/runner";
import { FreshnessChip, Layout } from "./ui/layout";
import { HealthPage } from "./ui/pages/health";
import { MapPage } from "./ui/pages/map";

// Spec §5: hourly cron runs hourly pollers, daily cron (~06:00 ET) runs daily.
const DAILY_CRON = "0 10 * * *";

const app = new Hono<{ Bindings: Env }>();

const epochNow = () => Math.floor(Date.now() / 1000);

app.get("/", async (c) => {
  const now = epochNow();
  const [entities, health] = await Promise.all([entitiesWithLatest(c.env.DB), pollerHealth(c.env.DB)]);
  return c.html(
    <Layout path="/" health={health} now={now}>
      <MapPage entities={entities} now={now} />
    </Layout>,
  );
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
