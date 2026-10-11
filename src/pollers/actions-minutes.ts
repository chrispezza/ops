import { tokenForOwner } from "./github";
import type { EntityUpsert, Poller, PollerResult, SignalInsert } from "./types";

// GitHub Actions minutes against the monthly allowance, per owner (#91). Both
// accounts hit their cap in September 2026 and nobody knew until jobs refused
// to run; with a spending limit set the next overrun bills money instead, so
// the pace has to be visible before the cap, not after.
//
// Source: the billing usage report, one request per owner per poll. An org is
// read from /organizations/{o}/settings/billing/usage (works with read:org); a
// personal account from /users/{u}/settings/billing/usage, which needs the
// classic `user` scope and answers 404 without it. An owner the token cannot
// read is a note, not a failure: the other owner's numbers still land.
const API = "https://api.github.com";
const DEFAULT_ALLOWANCE = 3_000;
const HOUR = 3_600;
// Before this much of the month has gone, a projection from a handful of CI
// runs says nothing; only the cap itself is judged until then.
const MIN_ELAPSED_FOR_PACE = 0.1;

// Runner-minute multipliers against the included allowance. Larger runners are
// billed per minute outright and never draw on it, so they are named in notes
// instead of being folded into a number that would read as "allowance used".
const MULTIPLIER: Record<string, number> = {
  "Actions Linux": 1,
  "Actions Windows": 2,
  "Actions macOS": 10,
};

interface UsageItem {
  sku?: string;
  unitType?: string;
  quantity?: number;
  repositoryName?: string;
}

// The billing report needs scopes the repo-reading tokens should not carry: a
// classic token with read:org owned by an org admin, or with `user` for a
// personal account. In production the fine-grained GITHUB_PAT tokens answered
// 403 for both owners. So billing has its own credentials, and the repo tokens
// stay narrow: GITHUB_BILLING_PAT_<OWNER>, then GITHUB_BILLING_PAT, and only
// then the repo token, for a deployment whose token happens to have the scope.
const billingKey = (owner: string): string => `GITHUB_BILLING_PAT_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
export function billingTokenForOwner(env: Env, owner: string): string | undefined {
  const vars = env as unknown as Record<string, string | undefined>;
  return vars[billingKey(owner)] || vars.GITHUB_BILLING_PAT || tokenForOwner(env, owner);
}

const allowanceFrom = (raw: string | undefined): number => {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : DEFAULT_ALLOWANCE;
};

async function usageFor(
  owner: string,
  year: number,
  month: number,
  headers: Record<string, string>,
): Promise<{ items: UsageItem[]; kind: "org" | "user" } | { error: string }> {
  const query = `?year=${year}&month=${month}`;
  let status = 0;
  for (const [kind, path] of [
    ["org", `/organizations/${owner}/settings/billing/usage`],
    ["user", `/users/${owner}/settings/billing/usage`],
  ] as const) {
    const res = await fetch(`${API}${path}${query}`, { headers }).catch(() => null);
    if (!res) return { error: "network error" };
    status = res.status;
    // 404 on the org path just means "not an org"; try the personal path
    if (res.status === 404) continue;
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = (await res.json()) as { usageItems?: UsageItem[] };
    return { items: body.usageItems ?? [], kind };
  }
  return { error: `HTTP ${status}; a personal account needs a classic token with the user scope` };
}

export const actionsMinutes: Poller = {
  id: "actions_minutes",
  schedule: "hourly",
  metricSemantics: { "actions.minutes": "state" },
  // Each configured owner is returned every run, so a number that can no longer
  // be read is retracted instead of standing at last month's pace (ADR-008).
  retractUnobserved: true,
  async poll(env, ctx) {
    const owners = (env.GITHUB_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (owners.length === 0) throw new Error("unconfigured: set GITHUB_OWNERS to enable this poller");

    const now = Math.floor(Date.now() / 1000);
    const hourBucket = String(now - (now % HOUR));
    const date = new Date(now * 1000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const monthStart = Date.UTC(year, month - 1, 1) / 1000;
    const monthEnd = Date.UTC(year, month, 1) / 1000;
    const elapsed = (now - monthStart) / (monthEnd - monthStart);
    const allowance = allowanceFrom(env.ACTIONS_MINUTES_PER_MONTH);

    // Public repositories appear in the report with a full discount and do not
    // draw on the allowance, so only private ones are counted. The github poller
    // records privacy; a repo it has not seen is counted, which can only
    // overstate usage.
    const known = await ctx.listEntities("repo");
    const isPublic = (id: string) => known.find((e) => e.id === id)?.metadata?.private === false;

    const entities: EntityUpsert[] = [];
    const signals: SignalInsert[] = [];
    const notes: string[] = [];

    for (const owner of owners) {
      const id = `account:${owner}`;
      entities.push({
        id,
        kind: "account",
        category: "vendor_api",
        name: `GitHub Actions · ${owner}`,
        owner,
        sourceUrl: `https://github.com/settings/billing/summary`,
      });

      const token = billingTokenForOwner(env, owner);
      if (!token) {
        notes.push(`actions_minutes: no token for ${owner}; set ${billingKey(owner)}`);
        continue;
      }
      const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ops-dashboard",
      };
      const usage = await usageFor(owner, year, month, headers);
      if ("error" in usage) {
        notes.push(
          `actions_minutes: ${owner} billing usage unavailable (${usage.error}); set ${billingKey(owner)} to a classic token with read:org (an org, owned by an org admin) or user (a personal account)`,
        );
        continue;
      }

      let used = 0;
      const unbilledSkus = new Set<string>();
      const perRepo = new Map<string, number>();
      for (const item of usage.items) {
        if (item.unitType !== "Minutes" || !item.sku?.startsWith("Actions")) continue;
        const multiplier = MULTIPLIER[item.sku];
        if (multiplier === undefined) {
          unbilledSkus.add(item.sku);
          continue;
        }
        const repo = item.repositoryName ?? "(unattributed)";
        if (isPublic(`repo:${owner}/${repo}`)) continue;
        const minutes = (item.quantity ?? 0) * multiplier;
        used += minutes;
        perRepo.set(repo, (perRepo.get(repo) ?? 0) + minutes);
      }
      if (unbilledSkus.size > 0) {
        notes.push(`actions_minutes: ${owner} has larger-runner minutes (${[...unbilledSkus].join(", ")}) billed outright; not counted against the allowance`);
      }

      used = Math.round(used);
      const capPct = used / allowance;
      const projected = elapsed > 0 ? used / elapsed : used;
      const pace = projected / allowance;
      const paced = elapsed >= MIN_ELAPSED_FOR_PACE;
      // Cap first: over it is over, whatever the pace says. Pace is the early
      // warning on the issue's bands: 60% of the allowance on this pace is low,
      // 80% medium, over it high (the month will not fit).
      const severity: 0 | 1 | 2 | 3 =
        capPct >= 1 ? 3
        : paced && pace > 1 ? 3
        : capPct >= 0.8 || (paced && pace >= 0.8) ? 2
        : paced && pace >= 0.6 ? 1
        : 0;
      const top = [...perRepo].sort((a, b) => b[1] - a[1])[0];
      const text = [
        `${used.toLocaleString("en-US")} of ${allowance.toLocaleString("en-US")} min (${Math.round(capPct * 100)}%)`,
        paced ? `pace ${Math.round(projected).toLocaleString("en-US")} by month end` : "too early in the month for a pace",
        top ? `top: ${top[0]} ${Math.round(top[1]).toLocaleString("en-US")}` : undefined,
      ].filter(Boolean).join(" · ");
      signals.push({
        entityId: id,
        metric: "actions.minutes",
        valueNum: used,
        valueText: text,
        severity,
        url: `https://github.com/${usage.kind === "org" ? `organizations/${owner}/settings/billing/summary` : "settings/billing/summary"}`,
        observedAt: now,
        dedupeKey: hourBucket,
      });
    }

    return { entities, signals, notes } satisfies PollerResult;
  },
};
