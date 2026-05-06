/**
 * Tenant-scoped auth: JWT verifier + per-tool admin filtering + cross-tenant
 * isolation guarantees.
 *
 * The invariant we want to nail:
 *   1. A JWT signed by us with tenant=A grants ONLY tenant=A access.
 *   2. A JWT for tenant=A cannot see admin-only tools in tools/list.
 *   3. A JWT for tenant=A cannot CALL admin-only tools (CallTool denies).
 *   4. Expired or unsigned tokens are rejected.
 *   5. The slug supplied in args is overridden by the JWT slug.
 */
import { describe, it, expect } from "vitest";
import { signJwt, verifyJwt, hasMcpScope } from "../src/auth/jwt.js";
import { authenticateRequest, effectiveTenantSlug } from "../src/auth/tenant.js";
import { makeValidator } from "../src/auth/api-keys.js";
import { buildServer } from "../src/server.js";
import { makeClient, makeFetchMock, silentLogger } from "./helpers.js";
import { expandGranted, ALL_SCOPES } from "../src/auth/scopes.js";

const SECRET = "test-secret-only-for-vitest-do-not-use-in-prod";

function bearer(token: string): string {
  return `Bearer ${token}`;
}

describe("jwt: signJwt / verifyJwt round-trip", () => {
  it("verifies a token we just signed", () => {
    const t = signJwt(
      { tenant_id: 42, tenant_slug: "gamerland", scope: ["mcp:tools"] },
      SECRET,
      300,
    );
    const v = verifyJwt(t, SECRET);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.claims.tenant_id).toBe(42);
    expect(v.claims.tenant_slug).toBe("gamerland");
    expect(v.claims.scope).toEqual(["mcp:tools"]);
    expect(v.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a token signed with a different secret", () => {
    const t = signJwt(
      { tenant_id: 1, tenant_slug: "x", scope: ["mcp:tools"] },
      SECRET,
      60,
    );
    const v = verifyJwt(t, "wrong-secret-completely-different-string");
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(401);
    expect(v.reason).toMatch(/Invalid signature/);
  });

  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const t = signJwt(
      { tenant_id: 1, tenant_slug: "x", scope: ["mcp:tools"], exp: past },
      SECRET,
      60,
    );
    const v = verifyJwt(t, SECRET);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.status).toBe(401);
    expect(v.reason).toMatch(/expired/i);
  });

  it("rejects malformed tokens", () => {
    const v = verifyJwt("not-a-jwt", SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(401);
  });

  it("rejects tokens missing tenant claims with 403", () => {
    // Hand-roll a JWT with no tenant fields.
    const t = signJwt(
      { tenant_id: undefined as unknown as number, tenant_slug: undefined as unknown as string, scope: ["mcp:tools"] },
      SECRET,
      60,
    );
    const v = verifyJwt(t, SECRET);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(403);
  });

  it("accepts a string-form scope (RFC 8693)", () => {
    const t = signJwt(
      { tenant_id: 1, tenant_slug: "x", scope: "mcp:tools mcp:admin" as unknown as string[] },
      SECRET,
      60,
    );
    const v = verifyJwt(t, SECRET);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.claims.scope).toEqual(["mcp:tools", "mcp:admin"]);
  });

  it("hasMcpScope: admin implies tools but not vice-versa", () => {
    expect(hasMcpScope(["mcp:admin"], "mcp:tools")).toBe(true);
    expect(hasMcpScope(["mcp:admin"], "mcp:admin")).toBe(true);
    expect(hasMcpScope(["mcp:tools"], "mcp:tools")).toBe(true);
    expect(hasMcpScope(["mcp:tools"], "mcp:admin")).toBe(false);
    expect(hasMcpScope([], "mcp:tools")).toBe(false);
  });
});

describe("authenticateRequest: header parsing + routing", () => {
  const legacyValidator = makeValidator("0123456789abcdef0123456789abcdef");

  it("rejects missing Authorization", () => {
    const r = authenticateRequest({
      authorization: undefined,
      jwtSecret: SECRET,
      legacyValidator,
      requireJwt: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.status).toBe(401);
  });

  it("accepts a valid JWT and binds the tenant", () => {
    const t = signJwt(
      { tenant_id: 7, tenant_slug: "lensitive", scope: ["mcp:tools"] },
      SECRET,
      300,
    );
    const r = authenticateRequest({
      authorization: bearer(t),
      jwtSecret: SECRET,
      legacyValidator,
      requireJwt: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auth.kind).toBe("tenant");
    expect(r.auth.tenantSlug).toBe("lensitive");
    expect(r.auth.tenantId).toBe(7);
    expect(r.auth.scopes).toContain("mcp:tools");
  });

  it("falls back to legacy admin bearer when JWT missing", () => {
    const r = authenticateRequest({
      authorization: bearer("0123456789abcdef0123456789abcdef"),
      jwtSecret: SECRET,
      legacyValidator,
      requireJwt: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.auth.kind).toBe("admin");
    expect(r.auth.tenantSlug).toBeNull();
    expect(r.auth.scopes).toEqual(expect.arrayContaining(["mcp:admin"]));
  });

  it("requireJwt=true refuses legacy admin bearer", () => {
    const r = authenticateRequest({
      authorization: bearer("0123456789abcdef0123456789abcdef"),
      jwtSecret: SECRET,
      legacyValidator,
      requireJwt: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.status).toBe(401);
  });

  it("503 when no auth method configured at all", () => {
    const r = authenticateRequest({
      authorization: bearer("anything"),
      jwtSecret: "",
      legacyValidator: makeValidator(undefined),
      requireJwt: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.status).toBe(503);
  });
});

describe("effectiveTenantSlug: JWT wins over user input", () => {
  it("kind=tenant ignores user-supplied slug", () => {
    const slug = effectiveTenantSlug(
      { kind: "tenant", tenantId: 1, tenantSlug: "lensitive", scopes: ["mcp:tools"], jti: null, expiresAt: null },
      "gamerland",
    );
    expect(slug).toBe("lensitive");
  });

  it("kind=admin uses requested slug", () => {
    const slug = effectiveTenantSlug(
      { kind: "admin", tenantId: null, tenantSlug: null, scopes: ["mcp:admin"], jti: null, expiresAt: null },
      "gamerland",
    );
    expect(slug).toBe("gamerland");
  });

  it("kind=admin returns null when no slug supplied", () => {
    const slug = effectiveTenantSlug(
      { kind: "admin", tenantId: null, tenantSlug: null, scopes: ["mcp:admin"], jti: null, expiresAt: null },
      undefined,
    );
    expect(slug).toBeNull();
  });
});

// ---------------- server-level tests ----------------

function setupTenantServer(slug: string) {
  const m = makeFetchMock();
  const client = makeClient({ fetchImpl: m.fetch });
  const built = buildServer({
    client,
    logger: silentLogger() as never,
    grantedScopes: expandGranted(ALL_SCOPES),
    tenantAuth: {
      kind: "tenant",
      tenantId: 1,
      tenantSlug: slug,
      scopes: ["mcp:tools"],
      jti: "test-jti",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });
  return { m, ...built };
}

function setupAdminServer() {
  const m = makeFetchMock();
  const client = makeClient({ fetchImpl: m.fetch });
  const built = buildServer({
    client,
    logger: silentLogger() as never,
    grantedScopes: expandGranted(ALL_SCOPES),
    tenantAuth: {
      kind: "admin",
      tenantId: null,
      tenantSlug: null,
      scopes: ["mcp:tools", "mcp:admin"],
      jti: null,
      expiresAt: null,
    },
  });
  return { m, ...built };
}

describe("registry filtering: tenant clients cannot see admin tools", () => {
  it("listForCaller hides mcp:admin tools from tenant scope", () => {
    const { registry } = setupTenantServer("gamerland");
    const visible = registry.listForCaller(["mcp:tools"]);
    const visibleNames = new Set(visible.map((t) => t.name));
    // Admin-only tools — must be filtered out.
    expect(visibleNames.has("wafle_system_health")).toBe(false);
    expect(visibleNames.has("wafle_system_release_deploy")).toBe(false);
    expect(visibleNames.has("wafle_system_audit_query")).toBe(false);
    expect(visibleNames.has("wafle_gateways_list")).toBe(false);
    expect(visibleNames.has("wafle_gateways_create")).toBe(false);
    expect(visibleNames.has("wafle_gateways_delete")).toBe(false);
    expect(visibleNames.has("wafle_stores_list")).toBe(false);
    expect(visibleNames.has("wafle_stores_create")).toBe(false);
    expect(visibleNames.has("wafle_auth_keys_list")).toBe(false);
    expect(visibleNames.has("wafle_auth_keys_create")).toBe(false);
    expect(visibleNames.has("wafle_resources_invalidate")).toBe(false);
    // Tenant tools — must remain visible.
    expect(visibleNames.has("wafle_stores_get")).toBe(true);
    expect(visibleNames.has("wafle_orders_list")).toBe(true);
    expect(visibleNames.has("wafle_products_list")).toBe(true);
  });

  it("listForCaller exposes everything to admin scope", () => {
    const { registry } = setupAdminServer();
    const visible = registry.listForCaller(["mcp:tools", "mcp:admin"]);
    expect(visible.length).toBe(registry.size());
  });
});

describe("CallTool denies admin tools for tenant callers (defense in depth)", () => {
  it("calling wafle_system_health from tenant context returns Unknown tool", async () => {
    const { registry } = setupTenantServer("gamerland");
    const t = registry.get("wafle_system_health");
    expect(t).toBeDefined();
    // Even though the tool is registered, an in-band scope check at run() rejects it.
    const res = await t!.run({});
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    // Could be either the registry-level scope-denied message or the
    // server-level Unknown tool fallback. Both are acceptable defense layers.
    expect(text).toMatch(/mcp:admin|requires|unknown/i);
  });
});

describe("cross-tenant isolation: input.slug is overridden by JWT", () => {
  it("wafle_stores_get uses JWT slug even if user passes another", async () => {
    const { registry, m } = setupTenantServer("lensitive");
    m.push({ body: { slug: "lensitive" } });
    // User passes a different slug — must be ignored.
    const r = await registry.get("wafle_stores_get")!.run({ slug: "gamerland" });
    expect(r.isError).toBe(false);
    expect(m.calls.length).toBe(1);
    expect(m.calls[0]!.url).toMatch(/\/stores\/lensitive$/);
    // CRITICAL: the request did NOT hit /stores/gamerland.
    expect(m.calls[0]!.url).not.toMatch(/\/stores\/gamerland/);
  });

  it("wafle_stores_settings_update writes to JWT slug, not input slug", async () => {
    const { registry, m } = setupTenantServer("lensitive");
    m.push({ body: { ok: true } });
    const r = await registry
      .get("wafle_stores_settings_update")!
      .run({ slug: "gamerland", settings: { theme_color: "#123" } });
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.url).toMatch(/\/stores\/lensitive$/);
    expect(m.calls[0]!.url).not.toMatch(/gamerland/);
  });

  it("wafle_stores_get without slug works for tenant (JWT supplies it)", async () => {
    const { registry, m } = setupTenantServer("gamerland");
    m.push({ body: {} });
    const r = await registry.get("wafle_stores_get")!.run({});
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland$/);
  });
});

describe("admin caller still has full slug control", () => {
  it("admin can pass any slug and it is honoured", async () => {
    const { registry, m } = setupAdminServer();
    m.push({ body: {} });
    await registry.get("wafle_stores_get")!.run({ slug: "gamerland" });
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland$/);
  });

  it("admin without slug gets a tool error", async () => {
    const { registry } = setupAdminServer();
    const r = await registry.get("wafle_stores_get")!.run({});
    expect(r.isError).toBe(true);
  });
});
