import type { Context } from "hono";
import { insertSignals, upsertEntities } from "./core/store";
import type { EntityUpsert, SignalInsert } from "./pollers/types";

// POST /ingest — CI pipelines push signals as their final step (spec §3.1).
// This is the app's one non-UI attack surface: bearer auth + strict payload
// validation at the boundary, then the same store path as every poller.

const MAX_ITEMS = 500;
// Ingest tokens are distributed to every CI pipeline in the portfolio, so the
// comparison is constant-time: SHA-256 both sides to equal-length digests
// (timingSafeEqual throws on a length mismatch) and compare those.
const MAX_BODY_BYTES = 1_000_000;

async function tokenMatches(presented: string | undefined, expected: string): Promise<boolean> {
  if (!presented) return false;
  const digest = async (s: string) => await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [a, b] = await Promise.all([digest(presented), digest(`Bearer ${expected}`)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

interface IngestPayload {
  entities?: EntityUpsert[];
  signals: SignalInsert[];
}

function validationError(path: string, message: string): string {
  return `${path}: ${message}`;
}

function validatePayload(body: unknown): { payload?: IngestPayload; error?: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const entities: EntityUpsert[] = [];
  if (b.entities !== undefined) {
    if (!Array.isArray(b.entities)) return { error: "entities must be an array" };
    if (b.entities.length > MAX_ITEMS) return { error: `entities: max ${MAX_ITEMS}` };
    for (const [i, e] of b.entities.entries()) {
      const path = `entities[${i}]`;
      if (typeof e !== "object" || e === null) return { error: validationError(path, "must be an object") };
      const ent = e as Record<string, unknown>;
      if (typeof ent.id !== "string" || !ent.id.includes(":"))
        return { error: validationError(path, 'id must be "{kind}:{natural_key}"') };
      if (typeof ent.kind !== "string" || !ent.kind) return { error: validationError(path, "kind required") };
      if (typeof ent.name !== "string" || !ent.name) return { error: validationError(path, "name required") };
      entities.push({
        id: ent.id,
        kind: ent.kind,
        name: ent.name,
        category: typeof ent.category === "string" ? ent.category : undefined,
        owner: typeof ent.owner === "string" ? ent.owner : undefined,
        sourceUrl: typeof ent.sourceUrl === "string" ? ent.sourceUrl : undefined,
        metadata: typeof ent.metadata === "object" && ent.metadata !== null ? (ent.metadata as Record<string, unknown>) : undefined,
      });
    }
  }

  if (!Array.isArray(b.signals) || b.signals.length === 0) return { error: "signals must be a non-empty array" };
  if (b.signals.length > MAX_ITEMS) return { error: `signals: max ${MAX_ITEMS}` };
  const signals: SignalInsert[] = [];
  for (const [i, s] of b.signals.entries()) {
    const path = `signals[${i}]`;
    if (typeof s !== "object" || s === null) return { error: validationError(path, "must be an object") };
    const sig = s as Record<string, unknown>;
    if (typeof sig.entityId !== "string" || !sig.entityId) return { error: validationError(path, "entityId required") };
    if (typeof sig.metric !== "string" || !/^[a-z0-9_]+\.[a-z0-9_.]+$/.test(sig.metric))
      return { error: validationError(path, 'metric must be namespaced "<domain>.<name>"') };
    if (typeof sig.observedAt !== "number") return { error: validationError(path, "observedAt (epoch seconds) required") };
    if (typeof sig.dedupeKey !== "string" || !sig.dedupeKey) return { error: validationError(path, "dedupeKey required") };
    const severity = sig.severity ?? 0;
    if (typeof severity !== "number" || ![0, 1, 2, 3, 4].includes(severity))
      return { error: validationError(path, "severity must be 0-4") };
    let period: { start: number; end: number } | undefined;
    if (sig.period !== undefined) {
      const p = sig.period as Record<string, unknown>;
      if (typeof p !== "object" || p === null || typeof p.start !== "number" || typeof p.end !== "number")
        return { error: validationError(path, "period must be {start, end} epoch seconds") };
      period = { start: p.start, end: p.end };
    }
    signals.push({
      entityId: sig.entityId,
      metric: sig.metric,
      valueNum: typeof sig.valueNum === "number" ? sig.valueNum : undefined,
      valueText: typeof sig.valueText === "string" ? sig.valueText : undefined,
      severity: severity as 0 | 1 | 2 | 3 | 4,
      url: typeof sig.url === "string" ? sig.url : undefined,
      observedAt: sig.observedAt,
      period,
      dedupeKey: sig.dedupeKey,
    });
  }
  return { payload: { entities, signals } };
}

export async function handleIngest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.env.INGEST_TOKEN;
  if (!token) return c.json({ error: "ingest disabled: INGEST_TOKEN not configured" }, 503);
  if (!(await tokenMatches(c.req.header("authorization"), token))) return c.json({ error: "unauthorized" }, 401);

  // MAX_ITEMS caps element count, not element size — without this a single
  // authenticated request can buffer an arbitrarily large body into the isolate.
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);

  let body: unknown;
  try {
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ error: "payload too large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }
  const { payload, error } = validatePayload(body);
  if (!payload) return c.json({ error }, 400);

  const now = Math.floor(Date.now() / 1000);
  try {
    await upsertEntities(c.env.DB, payload.entities ?? [], now);
    await insertSignals(c.env.DB, "ci_ingest", payload.signals);
  } catch (err) {
    // FK violation = signal for an entity Ops has never seen: caller must include it
    return c.json({ error: `insert failed: ${err instanceof Error ? err.message : String(err)}` }, 400);
  }
  return c.json({ ok: true, entities: payload.entities?.length ?? 0, signals: payload.signals.length }, 202);
}
