import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { classifyD1Error, secondsUntilUtcMidnight } from "../src/core/d1-errors";
import { handleIngest } from "../src/ingest";

// Verbatim from Cloudflare's D1 error list, as D1_ERROR messages arrive.
const READ_CAP =
  "D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue. See https://developers.cloudflare.com/d1/platform/limits/ for more details.: SQLITE_ERROR (code: 7500)";
const WRITE_CAP =
  "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const OVERLOADED = "D1_ERROR: D1 DB is overloaded. Too many requests queued.";
const RESET = "D1_ERROR: D1 DB reset because its code was updated.";
const CHECK = "D1_ERROR: CHECK constraint failed: severity >= 0: SQLITE_CONSTRAINT";

// 2026-09-02T03:55:00Z, the morning product-dev's reporter went red (#45).
const MORNING = Date.UTC(2026, 8, 2, 3, 55, 0) / 1000;

describe("classifyD1Error", () => {
  it("reads both daily allowances as quota, retryable at 00:00 UTC", () => {
    const untilMidnight = 20 * 3600 + 5 * 60;
    expect(classifyD1Error(READ_CAP, MORNING)).toEqual({ kind: "quota", retryAfter: untilMidnight });
    expect(classifyD1Error(WRITE_CAP, MORNING)).toEqual({ kind: "quota", retryAfter: untilMidnight });
  });

  it("reads restarts and overload as transient", () => {
    expect(classifyD1Error(OVERLOADED, MORNING).kind).toBe("transient");
    expect(classifyD1Error(RESET, MORNING).kind).toBe("transient");
    expect(classifyD1Error("D1_ERROR: Network connection lost.", MORNING).kind).toBe("transient");
  });

  it("keeps constraint rejections as the caller's problem, and the rest as ours", () => {
    expect(classifyD1Error(CHECK, MORNING).kind).toBe("constraint");
    expect(classifyD1Error("D1_ERROR: Exceeded maximum DB size.", MORNING).kind).toBe("unknown");
  });

  it("never asks for a zero-second retry at the stroke of midnight", () => {
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 8, 3) / 1000)).toBe(86_400);
  });
});

// A D1 binding whose every batch fails the way the account did on 2026-09-02.
function failingDb(message: string): D1Database {
  const stmt = { bind: () => stmt } as unknown as D1PreparedStatement;
  return {
    prepare: () => stmt,
    batch: async () => {
      throw new Error(message);
    },
  } as unknown as D1Database;
}

function ingestWith(message: string) {
  const app = new Hono<{ Bindings: Env }>().post("/ingest", handleIngest);
  const now = Math.floor(Date.now() / 1000);
  return app.request(
    "/ingest",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-ingest-token" },
      body: JSON.stringify({
        entities: [{ id: "repo:clownware/product-dev", kind: "repo", name: "product-dev" }],
        signals: [
          { entityId: "repo:clownware/product-dev", metric: "audit.finding_count", valueNum: 3, observedAt: now, dedupeKey: "run-1" },
        ],
      }),
    },
    { ...env, DB: failingDb(message) },
  );
}

describe("POST /ingest when D1 fails (#45)", () => {
  it("answers a spent allowance with 503 and Retry-After, not 400", async () => {
    const res = await ingestWith(READ_CAP);
    expect(res.status).toBe(503);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(body.error).toContain("retry after 00:00 UTC");
    expect(body.retryAfter).toBe(retryAfter);
  });

  it("answers a D1 restart with 503 and a short Retry-After", async () => {
    const res = await ingestWith(RESET);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  it("still answers a constraint rejection with 400", async () => {
    expect((await ingestWith(CHECK)).status).toBe(400);
  });

  it("answers an unrecognised storage failure with 500, not a client error", async () => {
    expect((await ingestWith("D1_ERROR: Exceeded maximum DB size.")).status).toBe(500);
  });
});
