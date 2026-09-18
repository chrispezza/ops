import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPollers } from "../src/core/runner";
import type { Poller } from "../src/pollers/types";

// Own file on purpose: it breaks the schema to simulate D1 refusing writes,
// and storage is shared within a test file.

const NOW = 1_754_400_000;

const poller = (id: string): Poller => ({
  id,
  schedule: "hourly",
  metricSemantics: { "x.y": "state" },
  poll: async () => ({
    entities: [{ id: `repo:a/${id}`, kind: "repo", name: id }],
    signals: [{ entityId: `repo:a/${id}`, metric: "x.y", valueNum: 1, observedAt: NOW, dedupeKey: "k" }],
  }),
});

afterEach(() => vi.restoreAllMocks());

describe("runner when D1 refuses writes (ADR-007)", () => {
  it("keeps going past a poller whose status row cannot be stored", async () => {
    // Every signal write goes through insertSignals, which maintains
    // signal_latest in the same batch; without the table the batch fails the
    // way a spent write allowance does — after the entity upsert, before the
    // status row.
    await env.DB.exec("DROP TABLE signal_latest");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const summaries = await runPollers(env, "hourly", { pollers: [poller("first"), poller("second")], now: NOW });

    // Both pollers ran and both failures are reported to the caller, instead
    // of the first status write aborting the loop and the derive pass after it.
    expect(summaries.map((s) => s.pollerId)).toEqual(["first", "second"]);
    expect(summaries.every((s) => !s.ok)).toBe(true);
    expect(logged.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining("could not record status for first"),
      expect.stringContaining("could not record status for second"),
    ]);
  });
});
