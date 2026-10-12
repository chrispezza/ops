import { describe, expect, it } from "vitest";

// ADR-002 (signals are append-only) and ADR-005 (signal_latest is maintained
// in the same batch as the rows) both rest on one fact: nothing writes to
// `signals` or `signal_latest` except the statements listed below. That was a
// written rule only; this makes it a failing test that says which record it
// guards. Source is read as text because the rule is about SQL that exists,
// not SQL that a given test happens to execute.
const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

// Every sanctioned write, by file. Adding a line here is a change to the
// contract and wants an ADR amendment in the same PR.
const SANCTIONED: Record<string, readonly string[]> = {
  // insertSignals (row + pointer, one batch) and retractUnobserved (ADR-008:
  // the pointer goes, the row stays).
  "../src/core/store.ts": ["INSERT signals", "INSERT signal_latest", "DELETE signal_latest"],
  // compactSignals, the one sanctioned deleter (ADR-002 amendment 2026-09-30).
  "../src/core/retention.ts": ["DELETE signals"],
};

const WRITE = /\b(INSERT|REPLACE|UPDATE|DELETE)\b(?:\s+OR\s+\w+)?(?:\s+(?:INTO|FROM))?\s+(signals|signal_latest)\b/gi;

// Comments describe these tables in prose ("delete from signals older than…")
// and must not count. `//` is only a comment when it is not part of a URL.
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function writesIn(code: string): string[] {
  return [...stripComments(code).matchAll(WRITE)].map((m) => `${m[1]?.toUpperCase()} ${m[2]?.toLowerCase()}`);
}

describe("signal write path (ADR-002, ADR-005)", () => {
  it("finds the sanctioned writes, so an empty result means clean and not unread", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    for (const [file, expected] of Object.entries(SANCTIONED)) {
      expect([...new Set(writesIn(sources[file] ?? ""))].sort(), file).toEqual([...expected].sort());
    }
  });

  it("has no other statement that writes signals or signal_latest", () => {
    const violations = Object.entries(sources).flatMap(([file, code]) =>
      writesIn(code)
        .filter((w) => !(SANCTIONED[file] ?? []).includes(w))
        .map((w) => `${file.replace("../", "")}: ${w}`),
    );
    expect(
      violations,
      "Raw SQL writes to signals/signal_latest outside the sanctioned write path. " +
        "Signals are append-only (docs/adr/002-append-only-signals.md) and the latest pointer is " +
        "maintained in the same batch as the row (docs/adr/005-signal-latest-pointer.md). " +
        "Store rows with insertSignals() from src/core/store.ts. If the rule itself should change, " +
        "amend the ADR and add the statement to SANCTIONED in this file in the same PR.",
    ).toEqual([]);
  });

  it("does not mistake prose for SQL", () => {
    expect(writesIn("// delete from signals when old\nconst a = 1; /* UPDATE signals */")).toEqual([]);
    expect(writesIn('const u = "https://x.dev"; db.prepare("UPDATE signals SET severity = 0")')).toEqual(["UPDATE signals"]);
  });
});
