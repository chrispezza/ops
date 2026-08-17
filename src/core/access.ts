// Cloudflare Access verification (ADR-004 / issue #3).
//
// Access authenticates at the edge and forwards a signed assertion, but the
// Worker never checked it — so the whole security model rested on the edge
// policy being present and correctly scoped, with no way for the app to notice
// if it was not. A Worker is reachable on its workers.dev hostname independently
// of any zone-level policy, so "Access is in front of it" is an assumption worth
// verifying rather than trusting.
//
// Dormant unless both ACCESS_TEAM_DOMAIN and ACCESS_AUD are set: an unconfigured
// deployment (and every fork of this template) behaves exactly as before rather
// than locking itself out. Configured, it fails closed.

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  sub?: string;
  common_name?: string; // service tokens carry this instead of email
}

export type AccessResult = { ok: true; identity: string } | { ok: false; reason: string };

// Workers isolates are reused across requests, so this survives long enough to
// matter and is bounded by the key set of a single team domain.
const JWKS_TTL_MS = 3_600_000;
let jwksCache: { domain: string; keys: Map<string, CryptoKey>; expiresAt: number } | null = null;

function b64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlToJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(input))) as T;
}

async function fetchKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access: JWKS HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, alg: "RS256", ext: true, key_ops: ["verify"] },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  return keys;
}

async function keyFor(teamDomain: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  const fresh = jwksCache && jwksCache.domain === teamDomain && jwksCache.expiresAt > now;
  if (fresh) {
    const hit = jwksCache?.keys.get(kid);
    // An unknown kid means rotation, not forgery — refetch once before rejecting.
    if (hit) return hit;
  }
  const keys = await fetchKeys(teamDomain);
  jwksCache = { domain: teamDomain, keys, expiresAt: now + JWKS_TTL_MS };
  return keys.get(kid);
}

export async function verifyAccessJwt(
  token: string | undefined,
  teamDomain: string,
  aud: string,
  now: number = Date.now(),
): Promise<AccessResult> {
  if (!token) return { ok: false, reason: "no assertion" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed assertion" };
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = b64urlToJson(rawHeader);
    claims = b64urlToJson(rawPayload);
  } catch {
    return { ok: false, reason: "undecodable assertion" };
  }

  // Pin the algorithm: accepting whatever the token names is how alg-confusion
  // and alg=none get in.
  if (header.alg !== "RS256") return { ok: false, reason: "unexpected alg" };
  if (!header.kid) return { ok: false, reason: "no kid" };

  let key: CryptoKey | undefined;
  try {
    key = await keyFor(teamDomain, header.kid, now);
  } catch {
    return { ok: false, reason: "jwks unavailable" };
  }
  if (!key) return { ok: false, reason: "unknown signing key" };

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSignature) as unknown as BufferSource,
    signed as unknown as BufferSource,
  );
  if (!valid) return { ok: false, reason: "bad signature" };

  // A valid signature only proves Cloudflare issued it — aud is what proves it
  // was issued for THIS application rather than any other app on the team.
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(aud)) return { ok: false, reason: "aud mismatch" };
  if (claims.iss !== `https://${teamDomain}.cloudflareaccess.com`) return { ok: false, reason: "iss mismatch" };

  const seconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= seconds) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return { ok: false, reason: "not yet valid" };

  return { ok: true, identity: claims.email ?? claims.common_name ?? claims.sub ?? "unknown" };
}
