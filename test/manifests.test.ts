import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPECTED_METRICS } from "../src/config";
import { emitHygieneSignals } from "../src/core/derive";
import { latestSignals } from "../src/core/queries";
import { runPollers } from "../src/core/runner";
import { upsertEntities } from "../src/core/store";
import { manifests } from "../src/pollers/manifests";

const NOW = Math.floor(Date.now() / 1000);
const noCtx = { listEntities: async () => [] };

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM signals"), env.DB.prepare("DELETE FROM entities")]);
});

afterEach(() => vi.unstubAllGlobals());

const MARKETPLACE_JSON = {
  plugins: [
    { name: "code-tools", source: "./plugins/code-tools", description: "Universal dev workflow skills" },
    { name: "product-dev", source: { url: "https://github.com/clownware/product-dev", path: "plugin" }, description: "" },
  ],
};

const PLUGINS_TREE = {
  truncated: false,
  tree: [
    { path: "plugins/code-tools/skills/security-audit/SKILL.md", type: "blob" },
    { path: "plugins/code-tools/skills/adr/SKILL.md", type: "blob" },
    { path: "plugins/code-tools/skills/adr/references/template.md", type: "blob" }, // not a skill
    { path: "plugins/other-dir/README.md", type: "blob" },
  ],
};

const PRODUCT_DEV_TREE = {
  truncated: false,
  tree: [
    { path: "plugin/skills/product-flow/SKILL.md", type: "blob" },
    { path: "plugin/skills/status/SKILL.md", type: "blob" },
  ],
};

function stubGithub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/contents/.claude-plugin/marketplace.json")) return Response.json(MARKETPLACE_JSON);
      if (url.includes("repos/clownware/plugins/git/trees")) return Response.json(PLUGINS_TREE);
      if (url.includes("repos/clownware/product-dev/git/trees")) return Response.json(PRODUCT_DEV_TREE);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

describe("manifests poller", () => {
  it("inventories plugins and skills from marketplace.json + git trees", async () => {
    stubGithub();
    const result = await manifests.poll({ ...env, GITHUB_PAT: "test-pat" } as Env, noCtx);

    const pluginIds = result.entities.filter((e) => e.kind === "plugin").map((e) => e.id);
    expect(pluginIds).toEqual(["plugin:clownware/code-tools", "plugin:clownware/product-dev"]);

    const skillIds = result.entities.filter((e) => e.kind === "skill").map((e) => e.id).sort();
    expect(skillIds).toEqual([
      "skill:code-tools:adr",
      "skill:code-tools:security-audit",
      "skill:product-dev:product-flow",
      "skill:product-dev:status",
    ]);

    // documented plugin passes, empty description flags
    const desc = (id: string) =>
      result.signals.find((s) => s.entityId === id && s.metric === "manifest.description");
    expect(desc("plugin:clownware/code-tools")?.severity).toBe(0);
    expect(desc("plugin:clownware/product-dev")?.severity).toBe(1);

    const count = result.signals.find(
      (s) => s.entityId === "plugin:clownware/code-tools" && s.metric === "manifest.skill_count",
    );
    expect(count?.valueNum).toBe(2); // template.md reference dir not counted
  });

  it("skills and plugins are exempt from repo-bucket expected metrics and usage bonus", async () => {
    stubGithub();
    await runPollers({ ...env, GITHUB_PAT: "test-pat" } as Env, "daily", { pollers: [manifests], now: NOW });
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW);

    // no usage.invocations hygiene flags on skill/plugin entities (kind-scoped to repos)
    const skill = await latestSignals(env.DB, "skill:code-tools:adr");
    expect(skill.filter((s) => s.metric.startsWith("hygiene.missing."))).toHaveLength(0);
    const plugin = await latestSignals(env.DB, "plugin:clownware/code-tools");
    expect(plugin.filter((s) => s.metric.startsWith("hygiene.missing."))).toHaveLength(0);

    // repo categories with real expectations still get them (kind-scoping check)
    await upsertEntities(env.DB, [{ id: "repo:x/webapp", kind: "repo", category: "web_app", name: "webapp" }], NOW);
    await emitHygieneSignals(env.DB, EXPECTED_METRICS, NOW + 60);
    const repo = await latestSignals(env.DB, "repo:x/webapp");
    expect(repo.find((s) => s.metric === "hygiene.missing.ci.status")?.severity).toBe(1);
  });

  it("map shows plugin rows with skill rollup, not forty skill rows", async () => {
    stubGithub();
    await runPollers({ ...env, GITHUB_PAT: "test-pat" } as Env, "daily", { pollers: [manifests], now: NOW });

    const html = await (await SELF.fetch("https://ops.local/")).text();
    expect(html).toContain("code-tools"); // plugin row
    expect(html).toContain("4 skills"); // rollup in the section header
    expect(html).not.toContain("skill:code-tools:adr"); // no per-skill rows on the map
    // flagged plugin renders its manifest chip
    expect(html).toContain("manifest missing");
  });
});
