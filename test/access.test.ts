import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAccessJwt } from "../src/core/access";
import worker from "../src/index";

// Signs with a real RSA key and verifies through WebCrypto — mocking the
// signature check would leave the part most worth testing untested.
const TEAM = "acme-team";
const AUD = "e".repeat(64);
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const KID = "test-key-1";

let pair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let jwks: { keys: unknown[] };

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };

function b64url(bytes: Uint8Array | string): string {
  const binary = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? pair.privateKey, data);
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

function validClaims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], iss: ISS, exp: now + 3600, iat: now, email: "chris@example.test", ...over };
}

beforeAll(async () => {
  pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  otherPair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  jwks = { keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] };
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url).includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify(jwks));
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Access assertion verification", () => {
  it("accepts a correctly signed, correctly scoped assertion", async () => {
    const res = await verifyAccessJwt(await sign(validClaims()), TEAM, AUD);
    expect(res).toEqual({ ok: true, identity: "chris@example.test" });
  });

  it("identifies service tokens by common_name", async () => {
    const res = await verifyAccessJwt(await sign(validClaims({ email: undefined, common_name: "ci-token" })), TEAM, AUD);
    expect(res).toEqual({ ok: true, identity: "ci-token" });
  });

  it("rejects a token signed by a different key", async () => {
    const forged = await sign(validClaims(), { key: otherPair.privateKey });
    expect(await verifyAccessJwt(forged, TEAM, AUD)).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects alg=none and alg confusion rather than trusting the header", async () => {
    const header = b64url(JSON.stringify({ alg: "none", kid: KID, typ: "JWT" }));
    const payload = b64url(JSON.stringify(validClaims()));
    expect(await verifyAccessJwt(`${header}.${payload}.`, TEAM, AUD)).toEqual({ ok: false, reason: "unexpected alg" });

    const hs256 = await sign(validClaims(), { alg: "HS256" });
    expect(await verifyAccessJwt(hs256, TEAM, AUD)).toEqual({ ok: false, reason: "unexpected alg" });
  });

  it("rejects a valid assertion issued for another application", async () => {
    const otherApp = await sign(validClaims({ aud: ["f".repeat(64)] }));
    expect(await verifyAccessJwt(otherApp, TEAM, AUD)).toEqual({ ok: false, reason: "aud mismatch" });
  });

  it("rejects a valid assertion from another team", async () => {
    const otherTeam = await sign(validClaims({ iss: "https://evil.cloudflareaccess.com" }));
    expect(await verifyAccessJwt(otherTeam, TEAM, AUD)).toEqual({ ok: false, reason: "iss mismatch" });
  });

  it("rejects expired assertions", async () => {
    const expired = await sign(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(await verifyAccessJwt(expired, TEAM, AUD)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects missing and malformed assertions", async () => {
    expect(await verifyAccessJwt(undefined, TEAM, AUD)).toEqual({ ok: false, reason: "no assertion" });
    expect(await verifyAccessJwt("nope", TEAM, AUD)).toEqual({ ok: false, reason: "malformed assertion" });
    expect(await verifyAccessJwt("a.b.c", TEAM, AUD)).toEqual({ ok: false, reason: "undecodable assertion" });
  });

  it("rejects an unknown kid after refetching for rotation", async () => {
    const stray = await sign(validClaims(), { kid: "rotated-away" });
    expect(await verifyAccessJwt(stray, TEAM, AUD)).toEqual({ ok: false, reason: "unknown signing key" });
  });

  it("fails closed when the JWKS endpoint is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const res = await verifyAccessJwt(await sign(validClaims()), "unreachable-team", AUD);
    expect(res).toEqual({ ok: false, reason: "jwks unavailable" });
  });
});

// The check as the deployment runs it (#111): the tests' own env blanks
// ACCESS_* (vitest.config.ts), so the configured Worker is driven directly.
describe("Access assertion check on the routes", () => {
  const configured = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD } as unknown as Env;
  const call = async (path: string, init?: RequestInit) => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`https://ops.local${path}`, init), configured, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/cdn-cgi/access/certs")) return new Response(JSON.stringify(jwks));
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  it("refuses the dashboard without an assertion, which is what workers.dev would otherwise serve", async () => {
    const res = await call("/");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("access denied: no assertion");
  });

  it("serves it with a valid assertion in the header or the cookie", async () => {
    const jwt = await sign(validClaims());
    expect((await call("/", { headers: { "cf-access-jwt-assertion": jwt } })).status).toBe(200);
    expect((await call("/", { headers: { cookie: `CF_Authorization=${jwt}` } })).status).toBe(200);
  });

  it("refuses an assertion issued for another application, such as the preview-URL app", async () => {
    const preview = await sign(validClaims({ aud: ["d".repeat(64)] }));
    const res = await call("/", { headers: { "cf-access-jwt-assertion": preview } });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("access denied: aud mismatch");
  });

  it("leaves the two machine routes to their own bearer tokens", async () => {
    // no assertion on either: they arrive through an Access bypass policy
    expect((await call("/ingest", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await call("/digest/md")).status).toBe(401);
    const ok = await call("/digest/md", { headers: { authorization: `Bearer ${env.DIGEST_TOKEN}` } });
    expect(ok.status).toBe(200);
  });

  it("exempts those two paths exactly, not their neighbours", async () => {
    for (const path of ["/ingest/extra", "/digest", "/digest/md/extra", "/health"]) {
      expect((await call(path)).status, path).toBe(403);
    }
  });
});
