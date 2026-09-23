import { DOMAIN_LABELS, labelForMetric } from "../config";
import type { EntityView, SignalRow } from "./queries";

// The findings lens folded into a grid: entities down, metric domains across,
// each cell the worst severity that domain carries for that entity. One glance
// answers the question the flat feed makes you scroll for — is the problem one
// repo, or one domain everywhere. Derived from the same latest rows as
// /findings; nothing new is stored (spec §4.4).

export interface HeatCell {
  domain: string;
  severity: number; // worst in the domain; -1 = no signal in that domain
  signals: SignalRow[]; // the domain's signals, worst first — the cell's title
}

export interface HeatRow {
  entityId: string;
  entityName: string;
  maxSeverity: number;
  cells: HeatCell[];
}

export interface Heatmap {
  domains: string[];
  rows: HeatRow[];
}

// Ops's own health belongs on /health, not in the portfolio grid.
const HIDDEN_DOMAINS = new Set(["poller"]);

export const domainLabel = (domain: string): string => DOMAIN_LABELS[domain] ?? domain;

export function buildHeatmap(views: EntityView[], opts: { domain?: string; category?: string }): Heatmap {
  const scoped = views.filter((v) => !opts.category || v.category === opts.category);
  const domainOf = (metric: string) => metric.split(".")[0] ?? metric;
  const wanted = (metric: string) =>
    !HIDDEN_DOMAINS.has(domainOf(metric)) && (!opts.domain || metric === opts.domain || metric.startsWith(`${opts.domain}.`));

  // Columns: every domain present, the ones with the most non-ok CELLS first
  // (entities, not signals — three CI metrics on one repo are one cell), so
  // the attention-worthy columns sit on the left at any width.
  const hot = new Map<string, number>();
  for (const v of scoped) {
    const hotHere = new Set<string>();
    for (const s of Object.values(v.latest)) {
      if (!wanted(s.metric)) continue;
      const d = domainOf(s.metric);
      if (!hot.has(d)) hot.set(d, 0);
      if (s.severity > 0) hotHere.add(d);
    }
    for (const d of hotHere) hot.set(d, (hot.get(d) ?? 0) + 1);
  }
  const domains = [...hot.entries()].sort((a, b) => b[1] - a[1] || domainLabel(a[0]).localeCompare(domainLabel(b[0]))).map(([d]) => d);

  const rows: HeatRow[] = scoped
    .map((v) => {
      const signals = Object.values(v.latest).filter((s) => wanted(s.metric));
      if (signals.length === 0) return null;
      const cells = domains.map((domain) => {
        const own = signals.filter((s) => domainOf(s.metric) === domain).sort((a, b) => b.severity - a.severity || labelForMetric(a.metric).localeCompare(labelForMetric(b.metric)));
        return { domain, severity: own.length === 0 ? -1 : (own[0]?.severity ?? 0), signals: own };
      });
      return { entityId: v.id, entityName: v.name, maxSeverity: Math.max(0, ...signals.map((s) => s.severity)), cells };
    })
    .filter((r): r is HeatRow => r !== null)
    .sort((a, b) => b.maxSeverity - a.maxSeverity || a.entityName.localeCompare(b.entityName));

  return { domains, rows };
}
