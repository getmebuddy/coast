/**
 * Subscription Action Center — SERVER-ONLY domain helpers.
 *
 * node:crypto-backed functions (idempotency keys, signed route tokens).
 * Import ONLY from API routes / server components — never from client
 * components, or the Next.js build will try to bundle node:crypto for the
 * browser. Pure, non-crypto domain logic lives in lib/subscriptions.ts.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Idempotency (spec FR-10; §13 unit tests)
// ---------------------------------------------------------------------------

export interface IdempotencyInputs {
  userId: string;
  seriesId: string;
  actionType: string;
}

/**
 * Deterministic idempotency key for one open request per (user, series, action
 * type). SHA-256 hex of the NUL-joined tuple.
 *
 * Duplicate-submit policy: a submit with the same key MUST return the existing
 * request (and its timeline) instead of creating a second request. A failed
 * request spawns a NEW request with a new idempotency key (spec §8).
 */
export function idempotencyKey({
  userId,
  seriesId,
  actionType,
}: IdempotencyInputs): string {
  return createHash("sha256")
    .update([userId, seriesId, actionType].join("\u0000"), "utf8")
    .digest("hex");
}


// ---------------------------------------------------------------------------
// Route tokens (spec §9 route integrity; §13 integration tests)
// ---------------------------------------------------------------------------

export interface RouteTokenPayload {
  request_id: string;
  destination: string; // allowlisted registry destination_ref
  registry_version: number;
  exp_epoch: number; // seconds since epoch
}

const ROUTE_TOKEN_VERSION = "v1";

function base64urlEncode(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
}

function signRouteToken(secret: string, signedPart: string): string {
  return createHmac("sha256", secret).update(signedPart, "utf8").digest("hex");
}

/**
 * Issue a signed route token for an external navigation. Format:
 * `v1.<base64url JSON payload>.<hex HMAC-SHA256>`. The client receives the
 * token — never a raw URL — and the server verifies it immediately before
 * launch (spec §9: clients cannot substitute their own destination).
 */
export function issueRouteToken(
  secret: string,
  payload: RouteTokenPayload
): string {
  const encoded = base64urlEncode(JSON.stringify(payload));
  const signedPart = `${ROUTE_TOKEN_VERSION}.${encoded}`;
  return `${signedPart}.${signRouteToken(secret, signedPart)}`;
}

/**
 * Verify a route token and return its destination, or throw. MUST reject when:
 *  - the format or signature is invalid (tampered token),
 *  - the token is expired,
 *  - the destination is not in allowedDestinations (the server passes the
 *    registry destination_ref here, so only an allowlisted registry value
 *    can ever be launched).
 */
export function verifyRouteToken(
  secret: string,
  token: string,
  allowedDestinations: string[]
): string {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== ROUTE_TOKEN_VERSION) {
    throw new Error("verifyRouteToken: malformed token");
  }
  const signedPart = `${parts[0]}.${parts[1]}`;
  const expected = signRouteToken(secret, signedPart);
  const actual = parts[2];
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"))
  ) {
    throw new Error("verifyRouteToken: invalid signature");
  }
  let payload: RouteTokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(parts[1])) as RouteTokenPayload;
  } catch {
    throw new Error("verifyRouteToken: invalid payload");
  }
  if (
    typeof payload.destination !== "string" ||
    typeof payload.exp_epoch !== "number" ||
    typeof payload.request_id !== "string"
  ) {
    throw new Error("verifyRouteToken: invalid payload");
  }
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (payload.exp_epoch <= nowEpoch) {
    throw new Error("verifyRouteToken: token expired");
  }
  if (!allowedDestinations.includes(payload.destination)) {
    throw new Error(
      "verifyRouteToken: destination is not in the allowlisted registry destinations"
    );
  }
  return payload.destination;
}

