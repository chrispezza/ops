import { describe, expect, it } from "vitest";
import type { EntityView, SignalRow } from "../src/core/queries";
import { computeScore } from "../src/core/score";

const NOW = 1_754_400_000;

function view(overrides: Partial<EntityView>, signals: Partial<SignalRow>[]): EntityView {
  const latest: Record<string, SignalRow> = {};
  let maxSeverity = 0;
  for (const [i, s] of signals.entries()) {
    const sig: SignalRow = {
      id: i,
      entity_id: "repo:x",
      source: "test",
      metric: s.metric ?? `m.${i}`,
      value_num: s.value_num ?? null,
      value_text: s.value_text ?? null,
      severity: s.severity ?? 0,
      url: null,
      observed_at: NOW,
      period_start: null,
      period_end: null,
      dedupe_key: String(i),
      ...s,
    };
    latest[sig.metric] = sig;
    if (sig.severity > maxSeverity) maxSeverity = sig.severity;
  }
  return {
    id: "repo:x",
    kind: "repo",
    category: "web_app",
    name: "x",
    owner: null,
    source_url: null,
    last_seen_at: NOW,
    latest,
    maxSeverity,
    ...overrides,
  };
}

describe("triage score (spec §4.1)", () => {
  it("matches a hand-computed score: 10*maxsev + 2*breadth + staleness + zero-usage", () => {
    // critical vuln (sev 4) + medium (sev 2) => 10*4 + 2*2 = 44; stale 94d => +6
    const v = view({ last_seen_at: NOW - 94 * 86_400 }, [
      { metric: "deps.vuln_count", severity: 4, value_num: 1 },
      { metric: "ci.status", severity: 2, value_text: "failure" },
    ]);
    const score = computeScore(v, NOW, null);
    expect(score.total).toBe(50);
    // "why" = top two contributors in words
    expect(score.parts[0]?.label).toBe("critical Dependabot vulns");
    expect(score.parts[0]?.points).toBe(40);
    expect(score.parts[1]?.label).toBe("stale 94d");
  });

  it("gives healthy fresh entities a zero score", () => {
    const v = view({}, [{ metric: "ci.status", severity: 0, value_text: "success" }]);
    expect(computeScore(v, NOW, null).total).toBe(0);
  });

  it("applies staleness tiers at 30 and 90 days", () => {
    expect(computeScore(view({ last_seen_at: NOW - 29 * 86_400 }, []), NOW, null).total).toBe(0);
    expect(computeScore(view({ last_seen_at: NOW - 31 * 86_400 }, []), NOW, null).total).toBe(3);
    expect(computeScore(view({ last_seen_at: NOW - 91 * 86_400 }, []), NOW, null).total).toBe(6);
  });

  it("adds the zero-usage bonus only for kinds with usage semantics", () => {
    const skill = view({ category: "plugin_skill" }, []);
    expect(computeScore(skill, NOW, 0).total).toBe(5);
    expect(computeScore(skill, NOW, 120).total).toBe(0);
    // null = kind without usage semantics — no bonus even with zero usage data
    expect(computeScore(view({}, []), NOW, null).total).toBe(0);
  });
});
