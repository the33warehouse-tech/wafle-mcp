/**
 * Helper for tenant-scoped tools.
 *
 * Each tool that hits a `/stores/<slug>/...` endpoint should read its slug
 * via this helper rather than directly from `input.slug`. Behaviour:
 *
 *   - If the caller authenticated with a tenant-scoped JWT, the slug from
 *     the JWT wins, full stop. The user-supplied `input.slug` (if any) is
 *     ignored — this is the security invariant the whole feature rests on.
 *   - If the caller is admin-tier (legacy static bearer / stdio), the
 *     user-supplied slug is honoured, exactly as before.
 *   - If neither has a slug, the tool returns a structured error string.
 *
 * Tools call it like:
 *
 *     handler: async (input, ctx) => {
 *       const slug = mustResolveSlug(input.slug, ctx);
 *       if (typeof slug !== "string") return slug; // error payload
 *       return ctx.client.get(`/stores/${encodeURIComponent(slug)}/orders`);
 *     }
 *
 * For now we keep the existing shape (every tool receives `input.slug` and
 * passes it through). Migrating each tool to call `mustResolveSlug` is an
 * incremental step we'll do as tools are touched. The crucial security
 * filter — tools/list filtering and the admin-scope check — is already
 * enforced in the registry, so even without per-tool migration a tenant
 * cannot call admin-only tools or be visible to them.
 */
import type { ToolContext } from "./registry.js";
import { effectiveTenantSlug } from "../auth/tenant.js";

export interface TenantSlugError {
  __tenant_error: true;
  message: string;
}

/**
 * Returns the slug to operate on, or a `TenantSlugError` if none can be
 * resolved. The error object is shaped so a tool can return it directly
 * via `throw` or convert to a structuredContent error.
 */
export function resolveSlug(
  requested: string | undefined | null,
  ctx: ToolContext,
): string | TenantSlugError {
  // No tenantAuth = stdio / admin tier. Use the requested slug verbatim.
  if (!ctx.tenantAuth) {
    if (typeof requested === "string" && requested.length > 0) return requested;
    return {
      __tenant_error: true,
      message: "Missing required parameter: slug. Pass a store slug, e.g. 'gamerland'.",
    };
  }

  const eff = effectiveTenantSlug(ctx.tenantAuth, requested);
  if (typeof eff === "string" && eff.length > 0) {
    if (
      ctx.tenantAuth.kind === "tenant" &&
      typeof requested === "string" &&
      requested.length > 0 &&
      requested !== eff
    ) {
      // Log the override so we can trace probes / mistakes — but don't
      // surface it as an error: the LLM might pass slug to mirror the schema.
      ctx.log.warn(
        { requested, effective: eff, jti: ctx.tenantAuth.jti },
        "tenant token: ignoring user-supplied slug, using JWT tenant_slug",
      );
    }
    return eff;
  }

  if (ctx.tenantAuth.kind === "admin") {
    return {
      __tenant_error: true,
      message: "Missing required parameter: slug. Admin-tier clients must pass a store slug explicitly.",
    };
  }

  return {
    __tenant_error: true,
    message: "tenant_not_authorized: bearer token does not carry a tenant binding",
  };
}

/** Type guard. */
export function isTenantSlugError(v: unknown): v is TenantSlugError {
  return typeof v === "object" && v !== null && (v as TenantSlugError).__tenant_error === true;
}
