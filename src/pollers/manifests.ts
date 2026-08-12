import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// Spec §3.1's manifests concept, pointed at the public plugin marketplace:
// marketplace.json defines the plugins, git trees enumerate each plugin's
// skills (one SKILL.md per skill). Plugins and skills become entities;
// missing plugin descriptions become hygiene signals. Deep per-skill quality
// belongs to /skill-audit pushed through /ingest — this poller is inventory.
const MARKETPLACE = { owner: "clownware", repo: "plugins" };

interface MarketplacePlugin {
  name: string;
  source: string | { url?: string; path?: string };
  description?: string;
}

function pat(env: Env): string {
  const key = `GITHUB_PAT_${MARKETPLACE.owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const token = (env as unknown as Record<string, string | undefined>)[key] ?? env.GITHUB_PAT;
  if (!token) throw new Error("manifests: no GitHub PAT for the marketplace owner");
  return token;
}

async function ghJson<T>(token: string, path: string, raw = false): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "user-agent": "ops-dashboard",
    },
  });
  if (!res.ok) throw new Error(`manifests: HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

interface Tree {
  tree: { path: string; type: string }[];
  truncated: boolean;
}

// skills live at <prefix><skill-name>/SKILL.md
function skillsFromTree(tree: Tree, prefix: string): string[] {
  return tree.tree
    .filter((n) => n.type === "blob" && n.path.startsWith(prefix) && n.path.endsWith("/SKILL.md"))
    .map((n) => n.path.slice(prefix.length).replace(/\/SKILL\.md$/, ""))
    .filter((name) => name && !name.includes("/"));
}

export const manifests: Poller = {
  id: "manifests",
  schedule: "daily",
  metricSemantics: {
    "manifest.description": "state",
    "manifest.skill_count": "state",
  },
  async poll(env) {
    const token = pat(env);
    const now = Math.floor(Date.now() / 1000);
    const mp = MARKETPLACE;

    const marketplace = await ghJson<{ plugins: MarketplacePlugin[] }>(
      token,
      `repos/${mp.owner}/${mp.repo}/contents/.claude-plugin/marketplace.json`,
      true,
    );
    // one tree call covers every locally-sourced plugin; git-subdir plugins get their own
    const marketplaceTree = await ghJson<Tree>(token, `repos/${mp.owner}/${mp.repo}/git/trees/HEAD?recursive=1`);

    const entities: EntityUpsert[] = [];
    const signals: SignalInsert[] = [];

    for (const plugin of marketplace.plugins) {
      const pluginId = `plugin:${mp.owner}/${plugin.name}`;

      let skills: string[] = [];
      let sourceUrl = `https://github.com/${mp.owner}/${mp.repo}`;
      if (typeof plugin.source === "string") {
        const dir = plugin.source.replace(/^\.\//, "").replace(/\/$/, "");
        skills = skillsFromTree(marketplaceTree, `${dir}/skills/`);
        sourceUrl = `https://github.com/${mp.owner}/${mp.repo}/tree/HEAD/${dir}`;
      } else if (plugin.source.url) {
        const repoRef = plugin.source.url.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
        const subdir = (plugin.source.path ?? "").replace(/\/$/, "");
        const tree = await ghJson<Tree>(token, `repos/${repoRef}/git/trees/HEAD?recursive=1`);
        skills = skillsFromTree(tree, subdir ? `${subdir}/skills/` : "skills/");
        sourceUrl = plugin.source.url;
      }

      entities.push({
        id: pluginId,
        kind: "plugin",
        category: "plugin_skill",
        name: plugin.name,
        owner: mp.owner,
        sourceUrl,
        metadata: { description: plugin.description, skills },
      });
      signals.push(
        {
          entityId: pluginId,
          metric: "manifest.description",
          valueText: plugin.description ? "present" : "missing",
          severity: plugin.description?.trim() ? 0 : 1,
          url: `https://github.com/${mp.owner}/${mp.repo}/blob/HEAD/.claude-plugin/marketplace.json`,
          observedAt: now,
          dedupeKey: "description",
        },
        {
          entityId: pluginId,
          metric: "manifest.skill_count",
          valueNum: skills.length,
          observedAt: now,
          dedupeKey: "count",
        },
      );

      for (const skill of skills) {
        entities.push({
          id: `skill:${plugin.name}:${skill}`,
          kind: "skill",
          category: "plugin_skill",
          name: `${plugin.name}:${skill}`,
          owner: mp.owner,
          sourceUrl: `${sourceUrl}${typeof plugin.source === "string" ? "" : `/tree/HEAD/${(plugin.source.path ?? "").replace(/\/$/, "")}`}/skills/${skill}`,
        });
      }
    }

    return { entities, signals } satisfies PollerResult;
  },
};
