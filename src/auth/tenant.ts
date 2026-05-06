/**
 * Tenant-scoped MCP auth.
 *
 * The HTTP transport hands every request to `authenticateRequest()`. The
 * function decides:
 *
 *   1. Is the JWT well-formed + signed by us?  → no = 401
 *   2. Is the JWT not expired?                  → no = 401
 *   3. Does it carry tenant_id + tenant_slug?   → no = 403
 *   4. Optionally: is it on the legacy bearer allow-list?
 *
 * On success, returns a `TenantAuth` describing who is calling, which is
 * threaded into every tool's `ToolContext` via the per-session `buildServer`.
 *
 * Backwards compatibility:
 *   - The historical `WAFLE_MCP_TOKENS` static bearer list still works for
 *     trusted callers (admin-tier). When that path is taken, the request
 *     gets `mcp:admin` scope but no tenant binding (tools that need a
 *     tenant must be supplied an explicit slug, exactly like before).
 *   - A new env, `WAFLE_MCP_REQUIRE_JWT`, when set to "1" disables the
 *     legacy bearer fallback completely (recommended for prod).
 */
import type { JwtClaims } from "./jwt.js";
import { verifyJwt } from "./jwt.js";
import type { ClientAuthValidator } from "./api-keys.js";

/**
 * The auth context attached to every tool call once the request has been
 * authenticated.
 */
export interface TenantAuth {
  /**
   * Token kind:
   *  - "tenant"  → JWT carrying tenant_id + tenant_slug. Tools MUST scope
   *                their REST calls to this tenant; cross-tenant access is denied.
   *  - "admin"   → legacy static bearer (`WAFLE_MCP_TOKENS`). Cross-tenant
   *                access permitted, but tools labelled `requiredScope:"mcp:admin"`
   *                are still gated on this scope being present.
   */
  kind: "tenant" | "admin";
  /** Numeric tenant id (only set for kind="tenant"). */
  tenantId: number | null;
  /** Tenant slug used in REST paths (only set for kind="tenant"). */
  tenantSlug: string | null;
  /** Granted MCP scopes — at least "mcp:tools", optionally "mcp:admin". */
  scopes: string[];
  /** JTI for audit logging, when provided by the JWT. */
  jti: string | null;
  /** Expiry epoch (seconds). null when admin-tier static token. */
  expiresAt: number | null;
}

export interface AuthFailure {
  status: 401 | 403 | 503;
  reason: string;
}
export type AuthResult = { ok: true; auth: TenantAuth } | { ok: false; failure: AuthFailure };

export interface AuthenticateOptions {
  /** Authorization header value (raw, including "Bearer "). */
  authorization: string | undefined;
  /** Shared secret for HS256 JWT verification. May be empty if JWT is disabled. */
  jwtSecret: string;
  /** Legacy static bearer validator. Used as fallback when not requireJwt. */
  legacyValidator: ClientAuthValidator;
  /** When true, refuse the legacy validator path entirely (JWT-only mode). */
  requireJwt: boolean;
}

const BEARER_RE = /^Bearer\s+(.+)$/i;

export function authenticateRequest(opts: AuthenticateOptions): AuthResult {
  const { authorization, jwtSecret, legacyValidator, requireJwt } = opts;

  if (!authorization || typeof authorization !== "string") {
    return { ok: false, failure: { status: 401, reason: "Missing Authorization: Bearer <token>" } };
  }
  const m = BEARER_RE.exec(authorization);
  if (!m || !m[1]) {
    return { ok: false, failure: { status: 401, reason: "Malformed Authorization header" } };
  }
  const token = m[1].trim();

  // Heuristic: a JWT is exactly three dot-separated base64url segments. This
  // lets us route to the JWT path without trial-and-error against the legacy
  // validator (which is constant-time and fine, but more work).
  const looksLikeJwt = token.split(".").length === 3;

  if (looksLikeJwt && jwtSecret) {
    const v = verifyJwt(token, jwtSecret);
    if (v.ok) {
      return { ok: true, auth: claimsToAuth(v.claims) };
    }
    // If we have a JWT-shaped string but it failed verification AND the
    // legacy validator isn't enabled, surface the JWT error directly.
    if (requireJwt || !legacyValidator.enabled) {
      return { ok: false, failure: { status: v.status, reason: v.reason } };
    }
    // Else fall through to the legacy validator as a last resort.
  }

  if (requireJwt) {
    return { ok: false, failure: { status: 401, reason: "JWT required (WAFLE_MCP_REQUIRE_JWT=1)" } };
  }

  if (!legacyValidator.enabled) {
    return {
      ok: false,
      failure: {
        status: 503,
        reason:
          "MCP server has no auth configured (WAFLE_MCP_TOKENS empty and WAFLE_MCP_JWT_SECRET empty). Refusing traffic.",
      },
    };
  }

  if (legacyValidator.isValid(token)) {
    // Legacy static bearer = master/admin tier with no tenant binding.
    return {
      ok: true,
      auth: {
        kind: "admin",
        tenantId: null,
        tenantSlug: null,
        scopes: ["mcp:tools", "mcp:admin"],
        jti: null,
        expiresAt: null,
      },
    };
  }

  return { ok: false, failure: { status: 403, reason: "Invalid bearer token" } };
}

function claimsToAuth(claims: JwtClaims): TenantAuth {
  return {
    kind: "tenant",
    tenantId: claims.tenant_id,
    tenantSlug: claims.tenant_slug,
    scopes: claims.scope,
    jti: typeof claims.jti === "string" ? claims.jti : null,
    expiresAt: claims.exp,
  };
}

/**
 * Given the JWT-claim auth and an optional input slug, decide which slug a
 * tool should operate on. Rules:
 *
 *   - If kind="tenant" → ALWAYS use the JWT slug. A user-supplied slug is
 *     IGNORED (we don't even raise — the LLM might pass it just to mirror
 *     the schema). This is the security invariant: the bearer dictates the
 *     tenant, never the request body.
 *   - If kind="admin"  → fall back to the user-supplied slug. Admin callers
 *     legitimately need cross-tenant access.
 *
 * Returns null when no slug is available; the caller should treat that as
 * a tool-validation error.
 */
export function effectiveTenantSlug(auth: TenantAuth, requestedSlug: string | undefined | null): string | null {
  if (auth.kind === "tenant") return auth.tenantSlug;
  return typeof requestedSlug === "string" && requestedSlug.length > 0 ? requestedSlug : null;
}

/**
 * Given the JWT-claim auth and an optional input tenant_id, decide which
 * numeric tenant id a tool should operate on. Same rules as
 * `effectiveTenantSlug`.
 */
export function effectiveTenantId(auth: TenantAuth, requestedId: number | undefined | null): number | null {
  if (auth.kind === "tenant") return auth.tenantId;
  return typeof requestedId === "number" && Number.isFinite(requestedId) && requestedId > 0 ? requestedId : null;
}
