// What a D1 failure means for the caller (#45). The ingest route used to
// answer every storage failure with 400 "insert failed", which tells a CI
// reporter its payload is wrong when the account's daily allowance was what
// ran out. Reporters treat 4xx as terminal, so a quota day turned every
// consumer repo's default branch red for a condition entirely on this side.
//
// Message strings are the ones Cloudflare documents in the D1 error list
// (developers.cloudflare.com/d1/observability/debug-d1/#error-list). Code 7500
// is what the 2026-09-12 read-cap outage actually carried.

export type D1Failure =
  // The account's daily row read or write allowance is spent. Nothing succeeds
  // until the 00:00 UTC reset, so that is when to come back.
  | { kind: "quota"; retryAfter: number }
  // The database restarted, was overloaded, or lost its connection. D1's own
  // advice is to retry; a minute is enough for a reset to finish.
  | { kind: "transient"; retryAfter: number }
  // The statement was rejected for what it tried to store — the caller's to fix.
  | { kind: "constraint" }
  // Anything else: a server-side fault the caller can do nothing about.
  | { kind: "unknown" };

const QUOTA = /daily row (read|write) limit|code: 7500/i;
const TRANSIENT =
  /D1 DB is overloaded|Network connection lost|reset because its code was updated|storage caused object to be reset|exceeded its (memory|CPU time) limit and was reset/i;
const CONSTRAINT = /constraint failed|SQLITE_CONSTRAINT|D1_TYPE_ERROR/i;

const TRANSIENT_RETRY_SECONDS = 60;

// Seconds from now until the next 00:00 UTC, when the daily allowances reset.
export function secondsUntilUtcMidnight(nowSeconds: number): number {
  const day = 86_400;
  return day - (nowSeconds % day);
}

export function classifyD1Error(message: string, nowSeconds: number): D1Failure {
  if (QUOTA.test(message)) return { kind: "quota", retryAfter: secondsUntilUtcMidnight(nowSeconds) };
  if (TRANSIENT.test(message)) return { kind: "transient", retryAfter: TRANSIENT_RETRY_SECONDS };
  if (CONSTRAINT.test(message)) return { kind: "constraint" };
  return { kind: "unknown" };
}
