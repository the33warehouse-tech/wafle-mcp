/**
 * Resource registry: TTL cache, URI templates, scope checks, concurrent reads.
 */
import { describe, it, expect } from "vitest";
import { ResourceRegistry, type WafleResource } from "../src/resources/registry.js";
import { createResourceRegistry } from "../src/resources/index.js";
import { makeClient, makeFetchMock, silentLogger } from "./helpers.js";
import { expandGranted, ALL_SCOPES } from "../src/auth/scopes.js";

function ctx(opts?: { fetchImpl?: typeof fetch }) {
  const m = opts?.fetchImpl ? null : makeFetchMock();
  const fetchImpl = opts?.fetchImpl ?? m!.fetch;
  const client = makeClient({ fetchImpl });
  return {
    m,
    client,
    log: silentLogger() as never,
    grantedScopes: expandGranted(ALL_SCOPES),
  };
}

describe("ResourceRegistry — registration", () => {
  it("rejects URIs without wafle:// scheme", () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    expect(() =>
      r.register({
        uri: "https://example.com",
        name: "x",
        description: "x",
        mimeType: "application/json",
        handler: async () => ({}),
      } as WafleResource),
    ).toThrow(/wafle:\/\//);
  });

  it("rejects duplicate URIs", () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    const res: WafleResource = {
      uri: "wafle://test/x",
      name: "x",
      description: "x",
      mimeType: "application/json",
      handler: async () => ({ ok: true }),
    };
    r.register(res);
    expect(() => r.register(res)).toThrow(/duplicate/i);
  });
});

describe("ResourceRegistry — URI templates", () => {
  it("resolves template params and decodes", () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    r.register({
      uri: "wafle://stores/{slug}/orders",
      name: "orders",
      description: "orders",
      mimeType: "application/json",
      handler: async (p) => ({ slug: p.params["slug"] }),
    });
    const resolved = r.resolve("wafle://stores/gamerland/orders");
    expect(resolved).not.toBeNull();
    expect(resolved!.params["slug"]).toBe("gamerland");
  });

  it("does not match a template that needs more segments", () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    r.register({
      uri: "wafle://stores/{slug}/orders",
      name: "orders",
      description: "orders",
      mimeType: "application/json",
      handler: async () => ({}),
    });
    expect(r.resolve("wafle://stores/gamerland")).toBeNull();
    expect(r.resolve("wafle://stores/gamerland/orders/extra")).toBeNull();
  });

  it("URL-decodes template params", () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    r.register({
      uri: "wafle://stores/{slug}",
      name: "store",
      description: "store",
      mimeType: "application/json",
      handler: async (p) => ({ slug: p.params["slug"] }),
    });
    const resolved = r.resolve("wafle://stores/multi%20word");
    expect(resolved!.params["slug"]).toBe("multi word");
  });
});

describe("ResourceRegistry — TTL cache", () => {
  it("returns cached body within TTL window", async () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    let calls = 0;
    r.register({
      uri: "wafle://test/cached",
      name: "x",
      description: "x",
      mimeType: "application/json",
      ttlMs: 60_000,
      handler: async () => {
        calls++;
        return { calls };
      },
    });
    const a = await r.read("wafle://test/cached");
    const b = await r.read("wafle://test/cached");
    expect(a.body).toBe(b.body);
    expect(calls).toBe(1);
  });

  it("ttl=0 disables caching (every call hits handler)", async () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    let calls = 0;
    r.register({
      uri: "wafle://test/nocache",
      name: "x",
      description: "x",
      mimeType: "application/json",
      ttlMs: 0,
      handler: async () => {
        calls++;
        return { calls };
      },
    });
    await r.read("wafle://test/nocache");
    await r.read("wafle://test/nocache");
    expect(calls).toBe(2);
  });

  it("invalidate(pattern) drops only matching entries; no arg flushes all", async () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    r.register({
      uri: "wafle://stores/{slug}",
      name: "store",
      description: "x",
      mimeType: "application/json",
      ttlMs: 60_000,
      handler: async (p) => ({ slug: p.params["slug"] }),
    });
    await r.read("wafle://stores/gamerland");
    await r.read("wafle://stores/lensitive");
    expect(r.cacheStats().size).toBe(2);
    const removed = r.invalidate("gamerland");
    expect(removed).toBe(1);
    expect(r.cacheStats().keys).toEqual(["wafle://stores/lensitive"]);
    const all = r.invalidate();
    expect(all).toBe(1);
    expect(r.cacheStats().size).toBe(0);
  });

  it("coalesces concurrent reads of the same URI into a single in-flight call", async () => {
    const c = ctx();
    const r = new ResourceRegistry(c);
    let calls = 0;
    r.register({
      uri: "wafle://test/concurrent",
      name: "x",
      description: "x",
      mimeType: "application/json",
      ttlMs: 60_000,
      handler: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return { calls };
      },
    });
    const [a, b, d] = await Promise.all([
      r.read("wafle://test/concurrent"),
      r.read("wafle://test/concurrent"),
      r.read("wafle://test/concurrent"),
    ]);
    expect(calls).toBe(1);
    expect(a.body).toBe(b.body);
    expect(b.body).toBe(d.body);
  });
});

describe("ResourceRegistry — scope check", () => {
  it("denies read when granted scopes lack the requirement", async () => {
    const c = { ...ctx(), grantedScopes: expandGranted(["orders:read"]) };
    const r = new ResourceRegistry(c);
    r.register({
      uri: "wafle://test/admin",
      name: "x",
      description: "x",
      mimeType: "application/json",
      scopes: ["system:admin"],
      handler: async () => ({ secret: 1 }),
    });
    await expect(r.read("wafle://test/admin")).rejects.toThrow(/Scope denied/);
  });

  it("warn-mode (granted=null) skips scope checks", async () => {
    const c = { ...ctx(), grantedScopes: null };
    const r = new ResourceRegistry(c);
    r.register({
      uri: "wafle://test/admin",
      name: "x",
      description: "x",
      mimeType: "application/json",
      scopes: ["system:admin"],
      handler: async () => ({ ok: true }),
    });
    const out = await r.read("wafle://test/admin");
    expect(JSON.parse(out.body)).toEqual({ ok: true });
  });
});

describe("ResourceRegistry — full registry from index", () => {
  it("registers >= 14 resources", () => {
    const c = ctx();
    const r = createResourceRegistry(c);
    expect(r.size()).toBeGreaterThanOrEqual(14);
  });

  it("every URI starts with wafle://", () => {
    const c = ctx();
    const r = createResourceRegistry(c);
    for (const e of r.list()) expect(e.uri.startsWith("wafle://")).toBe(true);
  });

  it("includes the documented system + stores URIs", () => {
    const c = ctx();
    const r = createResourceRegistry(c);
    const uris = r.list().map((e) => e.uri);
    expect(uris).toContain("wafle://system/health");
    expect(uris).toContain("wafle://system/scopes-catalog");
    expect(uris).toContain("wafle://docs/api-conventions");
    expect(uris).toContain("wafle://docs/architecture");
    expect(uris).toContain("wafle://stores");
    expect(uris).toContain("wafle://stores/{slug}");
    expect(uris).toContain("wafle://stores/{slug}/orders/recent");
    expect(uris).toContain("wafle://stores/{slug}/abandoned");
    expect(uris).toContain("wafle://stores/{slug}/analytics/7d");
    expect(uris).toContain("wafle://stores/{slug}/analytics/30d");
    expect(uris).toContain("wafle://stores/{slug}/products/sample");
    expect(uris).toContain("wafle://stores/{slug}/email/segments");
    expect(uris).toContain("wafle://stores/{slug}/email/recent-campaigns");
    expect(uris).toContain("wafle://stores/{slug}/ads/connections");
  });

  it("scopes-catalog is purely synthetic and works without network", async () => {
    const c = ctx();
    const r = createResourceRegistry(c);
    const out = await r.read("wafle://system/scopes-catalog");
    const parsed = JSON.parse(out.body);
    expect(parsed.count).toBeGreaterThan(20);
    expect(parsed.scopes[0]).toMatchObject({ scope: expect.any(String), domain: expect.any(String), tier: expect.any(String) });
  });

  it("docs resources return markdown", async () => {
    const c = ctx();
    const r = createResourceRegistry(c);
    const out = await r.read("wafle://docs/architecture");
    expect(out.mimeType).toBe("text/markdown");
    expect(out.body).toMatch(/wafle architecture/i);
  });
});

describe("ResourceRegistry — store snapshot wiring", () => {
  it("wafle://stores/{slug} fans out to 4 endpoints in parallel", async () => {
    const c = ctx();
    const m = c.m!;
    // store
    m.push({ body: { id: 10, slug: "gamerland", name: "Gamerland", domain: "gl.test", status: "publish", catalog_mode: "supabase_sync", payment_methods: ["mp"], shipping_methods: ["andreani"], enabled_gateways: [1] } });
    // analytics
    m.push({ body: { range: "7d", orders: 36, revenue: 6025100, top_products: { "gl-001": 4, "gl-002": 3 }, conversion: { views: 100 }, events: { add_to_cart: 12 } } });
    // abandoned
    m.push({ body: { sessions: [{ id: 1 }], total: 5 } });
    // orders
    m.push({ body: { orders: [{ id: 99, status: "pending", total: "100" }], total: 50 } });
    const r = createResourceRegistry(c);
    const out = await r.read("wafle://stores/gamerland");
    const parsed = JSON.parse(out.body);
    expect(parsed.slug).toBe("gamerland");
    expect(parsed.kpis_7d.orders).toBe(36);
    expect(parsed.kpis_7d.revenue).toBe(6025100);
    expect(parsed.abandoned_count).toBe(5);
    expect(parsed.last_order.id).toBe(99);
    expect(parsed.top_products.length).toBe(2);
  });

  it("rejects an invalid slug at URI parse time", async () => {
    const c = ctx();
    const r = createResourceRegistry(c);
    await expect(r.read("wafle://stores/x/orders/recent")).rejects.toThrow(/invalid store slug/i);
  });
});
