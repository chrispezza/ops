import { POLLERS } from "../pollers";
import type { KnownEntity, Poller, PollerCtx, Schedule } from "../pollers/types";
import { insertSignals, upsertEntities } from "./store";

function makeCtx(db: D1Database): PollerCtx {
  return {
    async listEntities(kind) {
      const stmt = kind
        ? db.prepare("SELECT id, kind, category, name, metadata, archived FROM entities WHERE kind = ?1").bind(kind)
        : db.prepare("SELECT id, kind, category, name, metadata, archived FROM entities");
      const res = await stmt.all<{
        id: string;
        kind: string;
        category: string | null;
        name: string;
        metadata: string | null;
        archived: number;
      }>();
      return res.results.map(
        (r): KnownEntity => ({
          ...r,
          metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
          archived: r.archived === 1,
        }),
      );
    },
  };
}

export interface RunSummary {
  pollerId: string;
  ok: boolean;
  error?: string;
  entities: number;
  signals: number;
  durationMs: number;
}

// Spec §3: per-poller error isolation; failures become signals on a synthetic
// poller:{id} entity — Ops monitors itself with its own machinery.
export async function runPollers(
  env: Env,
  schedule: Schedule,
  opts?: { pollers?: Poller[]; now?: number },
): Promise<RunSummary[]> {
  const pollers = (opts?.pollers ?? POLLERS).filter((p) => p.schedule === schedule);
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const summaries: RunSummary[] = [];

  const ctx = makeCtx(env.DB);
  for (const poller of pollers) {
    const t0 = Date.now();
    let summary: RunSummary;
    try {
      const result = await poller.poll(env, ctx);
      await upsertEntities(env.DB, result.entities, now);
      await insertSignals(env.DB, poller.id, result.signals);
      summary = {
        pollerId: poller.id,
        ok: true,
        entities: result.entities.length,
        signals: result.signals.length,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      summary = {
        pollerId: poller.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        entities: 0,
        signals: 0,
        durationMs: Date.now() - t0,
      };
    }
    await recordPollerStatus(env.DB, summary, now);
    summaries.push(summary);
  }
  return summaries;
}

async function recordPollerStatus(db: D1Database, summary: RunSummary, now: number): Promise<void> {
  const entityId = `poller:${summary.pollerId}`;
  await upsertEntities(db, [{ id: entityId, kind: "poller", name: summary.pollerId }], now);
  await insertSignals(db, "core", [
    {
      entityId,
      metric: "poller.status",
      valueText: JSON.stringify(summary),
      valueNum: summary.durationMs,
      severity: summary.ok ? 0 : 3,
      observedAt: now,
      dedupeKey: String(now),
    },
  ]);
}
