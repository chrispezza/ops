// Poller contract — spec §3. Pollers never touch D1; core owns persistence.

export type Kind = "repo" | "plugin" | "skill" | "vendor_api" | "api_key" | (string & {});

export interface EntityUpsert {
  id: string; // "{kind}:{natural_key}" — poller is responsible for stable natural keys
  kind: Kind;
  // Spec §2.4: repos get category from topic mapping, non-repo entities from
  // their poller directly. (Added here — spec §3's interface omitted it.)
  category?: string;
  name: string;
  owner?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
  // One-way: true marks the entity archived (e.g. the repo was archived
  // upstream). Pollers never clear it — unarchiving is a human act via the
  // /archive form, so a poll can't clobber a manual "Archive in Ops".
  archived?: true;
}

export interface SignalInsert {
  entityId: string;
  metric: string; // namespaced: "<domain>.<name>"
  valueNum?: number;
  valueText?: string;
  severity?: 0 | 1 | 2 | 3 | 4; // default 0
  url?: string;
  observedAt: number; // epoch seconds — when the condition was true
  period?: { start: number; end: number }; // interval metrics only
  dedupeKey: string;
}

export interface PollerResult {
  entities: EntityUpsert[];
  signals: SignalInsert[];
}

export type Schedule = "hourly" | "daily";

// Read-only view of an already-known entity, for pollers that derive their
// target list from what other pollers discovered (e.g. uptime ← homepages).
export interface KnownEntity {
  id: string;
  kind: string;
  category: string | null;
  name: string;
  metadata: Record<string, unknown> | null;
  archived: boolean;
}

export interface PollerCtx {
  since?: number;
  // Provided by the runner. Reading is fine — writing stays core-only (spec §3).
  listEntities(kind?: Kind): Promise<KnownEntity[]>;
}

export interface Poller {
  id: string; // "github", "anthropic_usage", …
  metricSemantics: Record<string, "state" | "interval">; // every metric this poller emits
  schedule: Schedule;
  poll(env: Env, ctx: PollerCtx): Promise<PollerResult>;
}
