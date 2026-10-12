import { describe, expect, it } from "vitest";

// The records in docs/adr/ are reached three ways: the index table in
// docs/adr/README.md, links from the other documents, and `ADR-NNN` citations
// in code comments ("Cite from code", docs/adr/README.md). Each of those is a
// pointer that can go stale without anything failing, and a stale pointer to a
// decision is worse than none. Same idea as test/metrics-doc.test.ts.
// Vite needs the options as a literal at each call site.
const adrFiles = import.meta.glob<string>("../docs/adr/*.md", { query: "?raw", import: "default", eager: true });
const docs = {
  ...import.meta.glob<string>("../*.md", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("../docs/**/*.md", { query: "?raw", import: "default", eager: true }),
};
const code = {
  ...import.meta.glob<string>("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
};

const base = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const RECORD = /^(\d{3})-[a-z0-9-]+\.md$/;

// Every numbered record except the template.
const records = Object.entries(adrFiles)
  .map(([path, text]) => ({ file: base(path), text }))
  .filter((r) => RECORD.test(r.file) && !r.file.startsWith("000-"));
const recordFiles = new Set(records.map((r) => r.file));
const recordNumbers = new Set(records.map((r) => r.file.slice(0, 3)));
const index = adrFiles["../docs/adr/README.md"] ?? "";

// First word of the record's own Status section.
function status(text: string): string | undefined {
  return /^## Status\s+([A-Z][a-z]+)/m.exec(text)?.[1];
}

describe("docs/adr", () => {
  it("is being read at all", () => {
    expect(records.length).toBeGreaterThanOrEqual(8);
    expect(index).toContain("| ADR | Decision | Status |");
    expect(Object.keys(code).length).toBeGreaterThan(40);
  });

  it("lists every record in the index table, with the status the record itself states", () => {
    const problems = records.flatMap((r) => {
      const row = index.split("\n").find((line) => line.startsWith("|") && line.includes(`(${r.file})`));
      if (!row) return [`${r.file}: no row in docs/adr/README.md`];
      const own = status(r.text);
      if (!own) return [`${r.file}: no "## Status" section starting with Proposed, Accepted or Superseded`];
      const listed = row.split("|").at(-2)?.trim() ?? "";
      return listed.startsWith(own) ? [] : [`${r.file}: record says "${own}", index says "${listed}"`];
    });
    expect(
      problems,
      "docs/adr/README.md is the index agents and readers start from. Add or correct the row in its table " +
        "in the same PR as the record (see \"Writing one\" there).",
    ).toEqual([]);
  });

  it("has no link, in any document, to a record that does not exist", () => {
    const broken = Object.entries(docs).flatMap(([path, text]) =>
      [...text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)]
        .map((m) => base(m[1] ?? ""))
        .filter((file) => RECORD.test(file) && !file.startsWith("000-") && !recordFiles.has(file))
        .map((file) => `${path.replace("../", "")} → ${file}`),
    );
    expect(broken, "A link names an ADR file that is not in docs/adr/. Records are amended in place, never renamed.").toEqual([]);
  });

  it("has no ADR-NNN citation, in code or documents, for a record that does not exist", () => {
    const dangling = Object.entries({ ...code, ...docs }).flatMap(([path, text]) =>
      [...new Set([...text.matchAll(/\bADR-(\d{3})\b/g)].map((m) => m[1] ?? ""))]
        .filter((n) => n !== "000" && !recordNumbers.has(n))
        .map((n) => `${path.replace("../", "")}: ADR-${n}`),
    );
    expect(
      dangling,
      "A comment or document cites an ADR number with no record in docs/adr/. Write the record " +
        "(copy 000-template.md) or fix the number.",
    ).toEqual([]);
  });
});
