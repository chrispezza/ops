import { labelForMetric, SEVERITY_NAMES } from "../config";
import type { IssueCard, PrCard } from "../pollers/github";
import type { DigestResolvedRow, EntityView, SignalRow } from "./queries";

// The board is a lens (spec §4.4), not a domain: columns are DERIVED from
// stored severity on every render and nothing is written. A card moves when
// the system of record changes — relabel the issue, merge the PR, fix CI —
// and the next poll moves it. Read here, act there (ADR-001) holds; the
// board is the findings bands at card granularity, plus the two columns the
// severity feed cannot show: what is in flight and what shipped.
//
// The severity → column rule is the same one /findings uses for its bands,
// so a P0 label, a red CI and a critical Dependabot alert all land in "now"
// for one reason a reader can check.

export const BOARD_WINDOW_DAYS = 7;
const DAY = 86_400;

export type ColumnKey = "now" | "next" | "later" | "inflight" | "done";

export interface BoardCard {
  entityId: string;
  entityName: string;
  severity: number; // drives the dot and the sort inside a column
  kind: "issue" | "pr" | "signal" | "activity" | "resolved" | "shipped";
  title: string;
  url?: string;
  detail?: string; // the "why" in words — label, age, author, what peaked
  signal?: SignalRow; // signal cards: the page formats the value (core stays presentation-free)
  ageDays?: number; // PRs only: drives the age bar
  draft?: boolean;
}

export interface BoardColumn {
  key: ColumnKey;
  title: string;
  why: string; // the derivation, shown under the column title
  cards: BoardCard[];
}

// Signals whose story the cards already tell, once a cards row exists for the
// repo: issue cards replace the "flagged issues" finding and PR cards replace
// the three PR age/count findings. Without a cards row (older data, other
// sources) those findings still speak for themselves.
const SHADOWED_BY_ISSUE_CARDS = new Set(["issues.flagged"]);
const SHADOWED_BY_PR_CARDS = new Set(["prs.oldest_days", "prs.dependabot_count", "prs.dependabot_major"]);
const CARD_ROWS = new Set(["issues.cards", "prs.cards"]);

// PR age thresholds mirror prs.oldest_days in the poller (14d warning, 30d
// medium) so a PR card and the finding it replaces would agree.
const PR_WARN_DAYS = 14;
const PR_MEDIUM_DAYS = 30;
// A repo pushed inside the window counts as in flight even with no PR open —
// direct-to-main work is still work.
const ACTIVE_PUSH_DAYS = 7;
// PR age bars scale to this; anything older is full.
export const PR_AGE_BAR_MAX_DAYS = 30;

const columnFor = (severity: number): ColumnKey | null => (severity >= 3 ? "now" : severity === 2 ? "next" : severity === 1 ? "later" : null);

function parseCards<T>(signal: SignalRow | undefined): T[] {
  if (!signal?.value_text) return [];
  try {
    const parsed: unknown = JSON.parse(signal.value_text);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return []; // a malformed row loses its cards, not the page
  }
}

const days = (from: number, now: number): number => Math.max(0, Math.floor((now - from) / DAY));

export function buildBoard(views: EntityView[], resolved: DigestResolvedRow[], now: number): BoardColumn[] {
  const columns: Record<ColumnKey, BoardCard[]> = { now: [], next: [], later: [], inflight: [], done: [] };
  const push = (key: ColumnKey | null, card: BoardCard) => {
    if (key) columns[key].push(card);
  };

  for (const view of views) {
    const repoUrl = view.source_url ?? undefined;
    const issueCards = parseCards<IssueCard>(view.latest["issues.cards"]);
    const prCards = parseCards<PrCard>(view.latest["prs.cards"]);
    const base = { entityId: view.id, entityName: view.name };

    for (const c of issueCards) {
      push(columnFor(c.s), {
        ...base,
        kind: "issue",
        severity: c.s,
        title: `#${c.n} ${c.t}`,
        url: repoUrl ? `${repoUrl}/issues/${c.n}` : undefined,
        detail: `${c.l} · updated ${days(c.u, now)}d ago`,
      });
    }

    let prInFlight = false;
    for (const pr of prCards) {
      const age = days(pr.c, now);
      const url = repoUrl ? `${repoUrl}/pull/${pr.n}` : undefined;
      if (pr.b) {
        // Dependabot: only a major bump or a month of rot earns a card — the
        // rest is the bot's queue, not the maintainer's (same call the
        // poller made for prs.dependabot_*)
        if (pr.m) push("later", { ...base, kind: "pr", severity: 1, title: `#${pr.n} ${pr.t}`, url, detail: `dependabot · major ${pr.m}`, ageDays: age });
        else if (age >= PR_MEDIUM_DAYS) push("later", { ...base, kind: "pr", severity: 1, title: `#${pr.n} ${pr.t}`, url, detail: `dependabot · open ${age}d`, ageDays: age });
        continue;
      }
      const severity = age >= PR_MEDIUM_DAYS ? 2 : age >= PR_WARN_DAYS ? 1 : 0;
      const who = pr.a ? `${pr.a} · ` : "";
      const card: BoardCard = {
        ...base,
        kind: "pr",
        severity,
        title: `#${pr.n} ${pr.t}`,
        url,
        detail: `${who}${pr.d ? "draft · " : ""}open ${age}d`,
        ageDays: age,
        draft: pr.d,
      };
      if (severity === 0) {
        prInFlight = true;
        push("inflight", card);
      } else {
        push(columnFor(severity), card);
      }
    }

    const hasIssueCards = view.latest["issues.cards"] != null;
    const hasPrCards = view.latest["prs.cards"] != null;
    for (const s of Object.values(view.latest)) {
      if (s.severity <= 0 || CARD_ROWS.has(s.metric) || s.metric.startsWith("poller.")) continue;
      if (hasIssueCards && SHADOWED_BY_ISSUE_CARDS.has(s.metric)) continue;
      if (hasPrCards && SHADOWED_BY_PR_CARDS.has(s.metric)) continue;
      push(columnFor(s.severity), {
        ...base,
        kind: "signal",
        severity: s.severity,
        title: labelForMetric(s.metric),
        url: s.url ?? undefined,
        detail: SEVERITY_NAMES[s.severity] ?? String(s.severity),
        signal: s,
      });
    }

    const pushed = view.latest["repo.pushed_at"]?.value_num;
    if (!prInFlight && pushed != null && now - pushed < ACTIVE_PUSH_DAYS * DAY) {
      push("inflight", { ...base, kind: "activity", severity: 0, title: "recent pushes", url: repoUrl, detail: `pushed ${days(pushed, now)}d ago, no open PR` });
    }

    const closed = view.latest["issues.closed_7d"]?.value_num ?? 0;
    const merged = view.latest["prs.merged_7d"]?.value_num ?? 0;
    if (closed + merged > 0) {
      const parts = [closed > 0 ? `${closed} issue${closed === 1 ? "" : "s"} closed` : "", merged > 0 ? `${merged} PR${merged === 1 ? "" : "s"} merged` : ""].filter(Boolean);
      push("done", { ...base, kind: "shipped", severity: 0, title: parts.join(" · "), url: repoUrl, detail: "trailing 7d" });
    }
  }

  const known = new Set(views.map((v) => v.id));
  for (const r of resolved) {
    if (!known.has(r.entity_id)) continue; // filtered out by the caller's owner/category scope
    push("done", {
      entityId: r.entity_id,
      entityName: r.entity_name,
      kind: "resolved",
      severity: 0,
      title: `${labelForMetric(r.metric)} resolved`,
      url: r.url ?? undefined,
      detail: `peaked ${SEVERITY_NAMES[r.peak] ?? r.peak}`,
    });
  }

  // worst first inside a column, then oldest PR, then name — deterministic so
  // a reload never reshuffles the cards
  const order = (a: BoardCard, b: BoardCard) => b.severity - a.severity || (b.ageDays ?? 0) - (a.ageDays ?? 0) || a.entityName.localeCompare(b.entityName) || a.title.localeCompare(b.title);
  for (const list of Object.values(columns)) list.sort(order);

  return [
    { key: "now", title: "Now", why: "severity 3+: P0 issues, CI red, site down, critical vulns", cards: columns.now },
    { key: "next", title: "Next", why: "severity 2: P1 issues, high vulns, human PRs open 30d+", cards: columns.next },
    { key: "later", title: "Later", why: "severity 1: P2 issues, hygiene and docs gaps, PRs open 14d+, Dependabot majors", cards: columns.later },
    { key: "inflight", title: "In flight", why: `human PRs under ${PR_WARN_DAYS}d, repos pushed in the last ${ACTIVE_PUSH_DAYS}d`, cards: columns.inflight },
    { key: "done", title: "Done this week", why: `closed, merged and resolved in the trailing ${BOARD_WINDOW_DAYS}d`, cards: columns.done },
  ];
}
