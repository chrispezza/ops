import { Hono } from "hono";
import { Layout } from "./ui/layout";

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
  async scheduled(_event, _env, _ctx) {
    // Phase 1: fan out to pollers by schedule (spec §5)
  },
} satisfies ExportedHandler<Env>;
