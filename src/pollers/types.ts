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

export interface Poller {
  id: string; // "github", "anthropic_usage", …
  metricSemantics: Record<string, "state" | "interval">; // every metric this poller emits
  schedule: Schedule;
  poll(env: Env, ctx: { since?: number }): Promise<PollerResult>;
}
