import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionsMinutes } from "../src/pollers/actions-minutes";
import type { KnownEntity } from "../src/pollers/types";

const testEnv = { ...env, GITHUB_OWNERS: "clownware", GITHUB_PAT: "test-pat", ACTIONS_MINUTES_PER_MONTH: "3000" } as unknown as Env;

const repo = (name: string, isPrivate: boolean): KnownEntity => ({
  id: `repo:clownware/${name}`,
  kind: "repo",
  category: null,
  name,
  metadata: { private: isPrivate },
  archived: false,
});
const ctx = (entities: KnownEntity[]) => ({ listEntities: async () => entities });

const item = (repositoryName: string, quantity: number, sku = "Actions Linux", unitType = "Minutes") => ({
  sku,
  unitType,
  quantity,
  repositoryName,
});

// org path answers with items; any other status is returned as-is for both paths
function stubUsage(opts: { org?: unknown[] | number; user?: unknown[] | number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      const src = url.includes("/organizations/") ? opts.org : opts.user;
      if (typeof src === "number" || src === undefined) return new Response("{}", { status: src ?? 404 });
      return Response.json({ usageItems: src });
    }),
  );
}

const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });

beforeEach(() => at("2026-10-15T12:00:00Z"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("actions_minutes poller (#91)", () => {
  it("counts private-repo minutes with runner multipliers and names the top repo", async () => {
    stubUsage({
      org: [
        item("web", 400),
        item("api", 100),
        item("site", 5, "Actions macOS"), // 50 allowance minutes
        item("starter", 900), // public: fully discounted, does not draw
        item("web", 12, "Actions storage", "GigabyteHours"),
      ],
    });
    const result = await actionsMinutes.poll(testEnv, ctx([repo("web", true), repo("api", true), repo("site", true), repo("starter", false)]));
    const sig = result.signals.find((s) => s.metric === "actions.minutes");

    expect(sig?.entityId).toBe("account:clownware");
    expect(sig?.valueNum).toBe(550);
    expect(sig?.valueText).toContain("550 of 3,000 min (18%)");
    expect(sig?.valueText).toContain("top: web 400");
    expect(sig?.severity).toBe(0); // 550 by mid-month projects to ~1,180
    expect(result.entities.map((e) => e.id)).toEqual(["account:clownware"]);
    expect(result.notes).toEqual([]);
  });

  it("goes high on a pace that will not fit, before the cap is reached", async () => {
    stubUsage({ org: [item("web", 1_600)] });
    const result = await actionsMinutes.poll(testEnv, ctx([repo("web", true)]));
    const sig = result.signals.find((s) => s.metric === "actions.minutes");
    // 1,600 of 3,000 by day 15 projects to ~3,400
    expect(sig?.severity).toBe(3);
    expect(sig?.valueText).toMatch(/pace 3,\d{3} by month end/);
  });

  it("bands medium and low from the pace", async () => {
    // elapsed ~0.468: 1,200 -> ~2,560 (85%) medium; 900 -> ~1,920 (64%) low
    stubUsage({ org: [item("web", 1_200)] });
    expect((await actionsMinutes.poll(testEnv, ctx([repo("web", true)]))).signals[0]?.severity).toBe(2);
    stubUsage({ org: [item("web", 900)] });
    expect((await actionsMinutes.poll(testEnv, ctx([repo("web", true)]))).signals[0]?.severity).toBe(1);
  });

  it("judges only the cap before a tenth of the month has passed", async () => {
    vi.setSystemTime(new Date("2026-10-02T06:00:00Z"));
    stubUsage({ org: [item("web", 600)] }); // a naive projection says ~10,000
    const calm = (await actionsMinutes.poll(testEnv, ctx([repo("web", true)]))).signals[0];
    expect(calm?.severity).toBe(0);
    expect(calm?.valueText).toContain("too early in the month for a pace");

    stubUsage({ org: [item("web", 3_100)] });
    expect((await actionsMinutes.poll(testEnv, ctx([repo("web", true)]))).signals[0]?.severity).toBe(3);
  });

  it("returns the entity with a note, and no signal, when the owner cannot be read", async () => {
    stubUsage({ org: 404, user: 404 });
    const result = await actionsMinutes.poll({ ...testEnv, GITHUB_OWNERS: "chrispezza" } as unknown as Env, ctx([]));
    expect(result.signals).toEqual([]);
    expect(result.entities.map((e) => e.id)).toEqual(["account:chrispezza"]);
    expect(result.notes?.[0]).toContain("chrispezza billing usage unavailable (HTTP 404; a personal account needs a classic token with the user scope)");
  });

  it("reads a personal account from the user endpoint when it is not an org", async () => {
    stubUsage({ org: 404, user: [item("tunes", 100)] });
    const result = await actionsMinutes.poll({ ...testEnv, GITHUB_OWNERS: "chrispezza" } as unknown as Env, ctx([]));
    expect(result.signals[0]?.valueNum).toBe(100);
    expect(result.signals[0]?.url).toBe("https://github.com/settings/billing/summary");
  });

  it("names larger-runner minutes instead of folding them into the allowance", async () => {
    stubUsage({ org: [item("web", 100), item("web", 40, "Actions Linux 4-core")] });
    const result = await actionsMinutes.poll(testEnv, ctx([repo("web", true)]));
    expect(result.signals[0]?.valueNum).toBe(100);
    expect(result.notes?.[0]).toContain("larger-runner minutes (Actions Linux 4-core)");
  });

  describe("billing token (kept apart from the repo-reading token)", () => {
    // placeholder token names, not real credentials
    const sent = () =>
      (fetch as unknown as { mock: { calls: [unknown, RequestInit | undefined][] } }).mock.calls.map((c) => new Headers(c[1]?.headers).get("authorization"));
    const withBilling = (extra: Record<string, string>) => ({ ...testEnv, ...extra }) as unknown as Env;

    it("prefers the per-owner billing token, then the shared one, then the repo token", async () => {
      stubUsage({ org: [item("web", 10)] });
      await actionsMinutes.poll(withBilling({ GITHUB_BILLING_PAT_CLOWNWARE: "owner-billing", GITHUB_BILLING_PAT: "shared-billing" }), ctx([]));
      expect(sent()).toEqual(["Bearer owner-billing"]);

      stubUsage({ org: [item("web", 10)] });
      await actionsMinutes.poll(withBilling({ GITHUB_BILLING_PAT: "shared-billing" }), ctx([]));
      expect(sent()).toEqual(["Bearer shared-billing"]);

      stubUsage({ org: [item("web", 10)] });
      await actionsMinutes.poll(testEnv, ctx([]));
      expect(sent()).toEqual(["Bearer test-pat"]);
    });

    it("names the secret to set when the report is refused", async () => {
      stubUsage({ org: 403 });
      const result = await actionsMinutes.poll({ ...testEnv, GITHUB_OWNERS: "my-org" } as unknown as Env, ctx([]));
      expect(result.signals).toEqual([]);
      expect(result.notes?.[0]).toContain("my-org billing usage unavailable (HTTP 403); set GITHUB_BILLING_PAT_MY_ORG");
    });
  });

  it("reports unconfigured calmly with no owners", async () => {
    await expect(actionsMinutes.poll({ ...testEnv, GITHUB_OWNERS: "" } as unknown as Env, ctx([]))).rejects.toThrow(/^unconfigured:/);
  });
});
