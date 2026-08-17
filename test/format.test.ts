import { describe, expect, it } from "vitest";
import { formatSignalValue } from "../src/ui/components";

const NOW = 1_754_400_000;

function sig(metric: string, value_num: number | null, value_text: string | null = null, severity = 0) {
  return { metric, value_num, value_text, severity };
}

describe("formatSignalValue", () => {
  it("renders timestamps, money, durations, and counts with units", () => {
    expect(formatSignalValue(sig("repo.pushed_at", NOW - 2 * 86_400), NOW)).toBe("2d ago");
    expect(formatSignalValue(sig("spend.usd", 12.4), NOW)).toBe("$12.40");
    expect(formatSignalValue(sig("budget.status", 36.505), NOW)).toBe("$36.51");
    expect(formatSignalValue(sig("ci.duration_ms", 312_000), NOW)).toBe("5m12s");
    expect(formatSignalValue(sig("ci.duration_ms", 42_000), NOW)).toBe("42s");
    expect(formatSignalValue(sig("site.response_ms", 180), NOW)).toBe("180ms"); // was "0s"
    expect(formatSignalValue(sig("release.age_days", 12), NOW)).toBe("12d");
    expect(formatSignalValue(sig("usage.tokens_in", 1_234_567), NOW)).toBe("1.2M");
    expect(formatSignalValue(sig("usage.tokens_out", 45_000), NOW)).toBe("45k");
  });

  it("phrases hygiene rows unambiguously", () => {
    // the labeled metric column names what's expected; the value is the verdict
    expect(formatSignalValue(sig("hygiene.missing.lhci.performance", null, "lhci.performance", 1), NOW)).toBe("missing");
    expect(formatSignalValue(sig("hygiene.missing.lhci.performance", null, "lhci.performance", 0), NOW)).toBe("present");
    expect(formatSignalValue(sig("hygiene.uncategorized", null, "no topic", 1), NOW)).toBe("untagged");
    expect(formatSignalValue(sig("hygiene.uncategorized", null, "web_app", 0), NOW)).toBe("tagged web_app");
  });

  it("falls back to raw values for unknown metrics", () => {
    expect(formatSignalValue(sig("issues.open", 7), NOW)).toBe("7");
    expect(formatSignalValue(sig("ci.status", null, "failure", 3), NOW)).toBe("failure");
    expect(formatSignalValue(sig("x.y", null), NOW)).toBe("—");
  });
});
