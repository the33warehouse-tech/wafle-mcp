/**
 * Minimal HS256 JWT verifier + signer for tenant-scoped MCP bearer tokens.
 *
 * The wafle backend mints these tokens when a client connects their tenant
 * to the MCP. The MCP server only needs a shared secret (`WAFLE_MCP_JWT_SECRET`)
 * to verify them — there is NO upstream call per request.
 *
 * Claim shape:
 *   {
 *     iss: "wafle-backend",      // optional but recommended
 *     sub: "tenant:<slug>",      // optional: tenant slug for traceability
 *     tenant_id: number,         // REQUIRED: numeric tenant (post id of waffle_store)
 *     tenant_slug: string,       // REQUIRED: store slug, used to build REST paths
 *     scope: ["mcp:tools"]       // REQUIRED: space-separated array (or string)
 *                                //          "mcp:tools" → regular per-tenant tools
 *                                //          "mcp:admin" → cross-tenant master tools
 *     iat: number,               // issued-at (epoch seconds)
 *     exp: number,               // expiry (epoch seconds) — REQUIRED
 *     jti: string,               // unique id (used by backend to revoke)
 *   }
 *
 * Why HS256 (not RS256)?
 *   - The backend (mu-plugin) and the MCP both run inside our infra; sharing a
 *     symmetric secret via env is operationally simpler than rotating a keypair.
 *   - Switching to RS256 later is a 1-file change here (verify uses public key).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface JwtClaims {
  iss?: string;
  sub?: string;
  tenant_id: number;
  tenant_slug: string;
  scope: string[];
  iat?: number;
  exp: number;
  jti?: string;
  // Forward-compat: ignore extra claims rather than rejecting them.
  [k: string]: unknown;
}

export interface JwtVerifyOk {
  ok: true;
  claims: JwtClaims;
}
export interface JwtVerifyErr {
  ok: false;
  /** HTTP-friendly status code: 401 (auth) or 403 (insufficient). */
  status: 401 | 403;
  reason: string;
}
export type JwtVerifyResult = JwtVerifyOk | JwtVerifyErr;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad), "base64");
}

function eqBuffers(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sign a JWT (HS256). Returns the compact serialization `header.payload.sig`.
 *
 * `ttlSeconds` is added to current time to set `exp`. `iat` is set to now.
 */
export function signJwt(
  claims: Omit<JwtClaims, "exp" | "iat"> & { exp?: number; iat?: number },
  secret: string,
  ttlSeconds: number,
): string {
  if (!secret) throw new Error("signJwt: secret required");
  const headerObj = { alg: "HS256", typ: "JWT" };
  const iat = claims.iat ?? nowSec();
  const exp = claims.exp ?? iat + ttlSeconds;
  const payload: JwtClaims = { ...claims, iat, exp };
  const header = base64UrlEncode(Buffer.from(JSON.stringify(headerObj)));
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const sig = base64UrlEncode(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/**
 * Verify a JWT compact string against a shared secret.
 *
 * - Returns `{ok:false,status:401,...}` for any signature/format failure
 *   (so HTTP transport sends 401).
 * - Returns `{ok:false,status:401,...}` for expired tokens (RFC convention).
 * - Returns `{ok:false,status:403,...}` for missing required claims (token
 *   is well-formed but does not authorize anything).
 */
export function verifyJwt(token: string, secret: string): JwtVerifyResult {
  if (!secret) return { ok: false, status: 401, reason: "MCP server has no JWT secret configured" };
  if (!token || typeof token !== "string") return { ok: false, status: 401, reason: "Empty token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 401, reason: "Malformed JWT (expected 3 segments)" };
  const [headerB64, bodyB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as { alg?: string; typ?: string };
  } catch {
    return { ok: false, status: 401, reason: "Malformed JWT header" };
  }
  if (header.alg !== "HS256") {
    return { ok: false, status: 401, reason: `Unsupported alg: ${String(header.alg)} (only HS256)` };
  }

  // Verify signature first — never trust the body until we know the token wasn't tampered.
  const expected = createHmac("sha256", secret).update(`${headerB64}.${bodyB64}`).digest();
  let actual: Buffer;
  try {
    actual = base64UrlDecode(sigB64);
  } catch {
    return { ok: false, status: 401, reason: "Malformed signature" };
  }
  if (!eqBuffers(expected, actual)) {
    return { ok: false, status: 401, reason: "Invalid signature" };
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(bodyB64).toString("utf8")) as JwtClaims;
  } catch {
    return { ok: false, status: 401, reason: "Malformed JWT body" };
  }

  if (typeof claims.exp !== "number") return { ok: false, status: 401, reason: "Missing exp claim" };
  if (claims.exp <= nowSec()) return { ok: false, status: 401, reason: "Token expired" };

  // Normalize `scope` to an array of strings. Accept either array or
  // space-separated string per RFC 8693.
  const rawScope = claims.scope as unknown;
  let scope: string[];
  if (Array.isArray(rawScope)) {
    scope = rawScope.filter((s): s is string => typeof s === "string");
  } else if (typeof rawScope === "string") {
    scope = rawScope.split(/\s+/).filter((s) => s.length > 0);
  } else {
    return { ok: false, status: 403, reason: "Missing scope claim" };
  }
  if (scope.length === 0) return { ok: false, status: 403, reason: "Empty scope claim" };

  if (typeof claims.tenant_id !== "number" || !Number.isInteger(claims.tenant_id) || claims.tenant_id <= 0) {
    return { ok: false, status: 403, reason: "Missing or invalid tenant_id claim" };
  }
  if (typeof claims.tenant_slug !== "string" || claims.tenant_slug.length < 1) {
    return { ok: false, status: 403, reason: "Missing or invalid tenant_slug claim" };
  }

  return {
    ok: true,
    claims: { ...claims, scope },
  };
}

/** True if the granted scope set contains the required MCP scope. */
export function hasMcpScope(granted: string[], required: "mcp:tools" | "mcp:admin"): boolean {
  // mcp:admin implies mcp:tools.
  if (required === "mcp:tools") {
    return granted.includes("mcp:tools") || granted.includes("mcp:admin");
  }
  return granted.includes("mcp:admin");
}
