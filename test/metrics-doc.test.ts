import { describe, expect, it } from "vitest";
import catalogue from "../docs/metrics.md?raw";
import { METRIC_LABELS } from "../src/config";
import { POLLERS } from "../src/pollers";

// docs/metrics.md is the reference for the extension point (a new metric
// domain appears on /findings with zero view changes). A reference that can
// fall behind the code is worse than none, so every metric the code knows
// about must have a backticked mention in the catalogue.
function documented(metric: string): boolean {
  return catalogue.includes(`\`${metric}\``);
}

describe("docs/metrics.md", () => {
  it("mentions every metric a poller declares in metricSemantics", () => {
    const missing = POLLERS.flatMap((p) =>
      Object.keys(p.metricSemantics)
        .filter((m) => !documented(m))
        .map((m) => `${p.id}: ${m}`),
    );
    expect(missing).toEqual([]);
  });

  it("mentions every metric src/config.ts labels", () => {
    const missing = Object.keys(METRIC_LABELS).filter((m) => !documented(m));
    expect(missing).toEqual([]);
  });

  it("names every poller", () => {
    const missing = POLLERS.map((p) => p.id).filter((id) => !catalogue.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });
});
