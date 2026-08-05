import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("shell", () => {
  it("serves the styled empty shell at /", async () => {
    const res = await SELF.fetch("https://ops.local/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Ops");
    expect(html).toContain("tokens.css");
    expect(html).toContain("No data yet");
  });
});
