import { Hono } from "hono";
import { EXPECTED_METRICS } from "./config";
import { emitHygieneSignals } from "./core/derive";
import { runPollers } from "./core/runner";
import { Layout } from "./ui/layout";

// Spec §5: hourly cron runs hourly pollers, daily cron (~06:00 ET) runs daily.
const DAILY_CRON = "0 10 * * *";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
  c.html(
    <Layout path="/">
      <SetupChecklist />
    </Layout>,
  ),
);

// ux-spec §3: first-run empty state teaches setup
function SetupChecklist() {
  return (
    <div class="empty-state">
      <strong>No data yet.</strong> To fill this dashboard:
      <ol>
        <li>
          Set secrets: <code>wrangler secret put GITHUB_PAT</code>
        </li>
        <li>
          Set <code>GITHUB_OWNERS</code> in wrangler.jsonc vars
        </li>
        <li>Tag repos with topics: static-site · web-app · mcp · skill</li>
        <li>Wait for the hourly cron, or trigger a poll from /health</li>
      </ol>
    </div>
  );
}

export default {
  fetch: app.fetch,
  async scheduled(event, env, _ctx) {
    const now = Math.floor(Date.now() / 1000);
    await runPollers(env, event.cron === DAILY_CRON ? "daily" : "hourly", { now });
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, now);
  },
} satisfies ExportedHandler<Env>;
