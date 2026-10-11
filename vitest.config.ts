import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("./migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        // ACCESS_* blanked: wrangler.jsonc turns the Access assertion check on for
        // the deployment, and SELF.fetch carries no assertion. The middleware is
        // exercised with its own env in test/access.test.ts.
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            INGEST_TOKEN: "test-ingest-token",
            DIGEST_TOKEN: "test-digest-token",
            ACCESS_TEAM_DOMAIN: "",
            ACCESS_AUD: "",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
