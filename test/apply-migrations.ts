import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

// TEST_MIGRATIONS is injected via miniflare bindings in vitest.config.ts;
// it is not part of the worker's own Env, hence the local cast.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
await applyD1Migrations(env.DB, migrations);
