/**
 * Per-domain tool tests. Each tool we exercise here is one we expect Claude
 * to actually pick — happy + at least one error path. We focus on path/method
 * correctness because that is the contract the LLM relies on.
 */
import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/tools/index.js";
import { makeClient, makeFetchMock, silentLogger } from "./helpers.js";
import { expandGranted, ALL_SCOPES } from "../src/auth/scopes.js";

function setup() {
  const m = makeFetchMock();
  const client = makeClient({ fetchImpl: m.fetch });
  const registry = createRegistry({
    client,
    log: silentLogger() as never,
    grantedScopes: expandGranted(ALL_SCOPES),
  });
  return { m, client, registry };
}

describe("auth tools", () => {
  it("wafle_auth_me hits /auth/me", async () => {
    const { m, registry } = setup();
    m.push({ body: { ok: true, type: "master" } });
    const r = await registry.get("wafle_auth_me")!.run({});
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.url).toMatch(/\/auth\/me$/);
    expect(m.calls[0]!.method).toBe("GET");
  });
});

describe("stores tools", () => {
  it("wafle_stores_list hits /stores", async () => {
    const { m, registry } = setup();
    m.push({ body: { stores: [] } });
    const r = await registry.get("wafle_stores_list")!.run({});
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.url).toMatch(/\/stores$/);
  });

  it("wafle_stores_get encodes slug", async () => {
    const { m, registry } = setup();
    m.push({ body: {} });
    await registry.get("wafle_stores_get")!.run({ slug: "gamerland" });
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland$/);
  });

  it("wafle_stores_create POSTs payload", async () => {
    const { m, registry } = setup();
    m.push({ body: { id: 99, slug: "new" } });
    const r = await registry.get("wafle_stores_create")!.run({ slug: "new", name: "New", domain: "n.com" });
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.method).toBe("POST");
    expect(JSON.parse(m.calls[0]!.body!).slug).toBe("new");
  });

  it("wafle_stores_update sends PATCH without slug in body", async () => {
    const { m, registry } = setup();
    m.push({ body: {} });
    await registry.get("wafle_stores_update")!.run({ slug: "gamerland", theme_color: "#fff" });
    expect(m.calls[0]!.method).toBe("PATCH");
    const body = JSON.parse(m.calls[0]!.body!);
    expect(body.slug).toBeUndefined();
    expect(body.theme_color).toBe("#fff");
  });
});

describe("orders tools (critical path)", () => {
  it("wafle_orders_list passes filters via query string", async () => {
    const { m, registry } = setup();
    m.push({ body: { orders: [] } });
    await registry.get("wafle_orders_list")!.run({
      slug: "gamerland",
      status: "pending",
      page: 2,
      per_page: 20,
    });
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland\/orders\?/);
    expect(m.calls[0]!.url).toMatch(/status=pending/);
    expect(m.calls[0]!.url).toMatch(/page=2/);
  });

  it("wafle_orders_create POSTs canonical snake_case shape (items[] + payment_method)", async () => {
    const { m, registry } = setup();
    m.push({ body: { order_id: 123, status: "pending" } });
    await registry.get("wafle_orders_create")!.run({
      slug: "gamerland",
      customer: { email: "x@y.com", firstName: "Foo" },
      items: [{ sku: "X-1", name: "Test", quantity: 2, unit_price: 1500, product_id: 7 }],
      payment_method: "transfer",
      gateway_id: 9,
    });
    expect(m.calls[0]!.method).toBe("POST");
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland\/orders$/);
    const body = JSON.parse(m.calls[0]!.body!);
    // Canonical snake_case fields are forwarded.
    expect(body.items).toBeDefined();
    expect(body.items[0].quantity).toBe(2);
    expect(body.items[0].unit_price).toBe(1500);
    expect(body.items[0].product_id).toBe(7);
    expect(body.payment_method).toBe("transfer");
    expect(body.gateway_id).toBe(9);
    // No legacy keys leaked.
    expect(body.cart).toBeUndefined();
    expect(body.payment).toBeUndefined();
    expect(body.paymentMethod).toBeUndefined();
  });

  it("wafle_orders_ship POSTs to /ship with carrier+tracking", async () => {
    const { m, registry } = setup();
    m.push({ body: { ok: true, status: "shipped" } });
    await registry.get("wafle_orders_ship")!.run({
      slug: "gamerland",
      order_id: 87,
      carrier: "andreani",
      tracking_number: "ABC123",
      tracking_url: "https://andreani.com/x",
    });
    expect(m.calls[0]!.method).toBe("POST");
    expect(m.calls[0]!.url).toMatch(/\/orders\/87\/ship$/);
    const body = JSON.parse(m.calls[0]!.body!);
    expect(body.carrier).toBe("andreani");
    expect(body.tracking_number).toBe("ABC123");
    expect(body.notify_customer).toBe(true);
  });

  it("wafle_orders_refund POSTs amount + reason", async () => {
    const { m, registry } = setup();
    m.push({ body: { ok: true } });
    await registry.get("wafle_orders_refund")!.run({
      slug: "gamerland",
      order_id: 5,
      amount: 1000,
      reason: "duplicate",
    });
    expect(m.calls[0]!.url).toMatch(/\/orders\/5\/refund$/);
    expect(JSON.parse(m.calls[0]!.body!).amount).toBe(1000);
  });

  it("wafle_orders_cancel default refund=true", async () => {
    const { m, registry } = setup();
    m.push({ body: { ok: true } });
    await registry.get("wafle_orders_cancel")!.run({ slug: "ga", order_id: 1 });
    expect(JSON.parse(m.calls[0]!.body!).refund).toBe(true);
  });

  it("wafle_orders_get bubbles 404 as not_found", async () => {
    const { m, registry } = setup();
    m.push({ status: 404, body: { code: "not_found", message: "no order" } });
    const r = await registry.get("wafle_orders_get")!.run({ slug: "ga", order_id: 999 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: "not_found", status: 404 });
  });
});

describe("gateways tools", () => {
  it("wafle_gateways_list", async () => {
    const { m, registry } = setup();
    m.push({ body: { gateways: [] } });
    await registry.get("wafle_gateways_list")!.run({});
    expect(m.calls[0]!.url).toMatch(/\/gateways$/);
  });

  it("wafle_gateways_test POSTs /gateways/:id/test", async () => {
    const { m, registry } = setup();
    m.push({ body: { ok: true } });
    await registry.get("wafle_gateways_test")!.run({ gateway_id: 65 });
    expect(m.calls[0]!.method).toBe("POST");
    expect(m.calls[0]!.url).toMatch(/\/gateways\/65\/test$/);
  });

  it("wafle_gateways_delete DELETEs by id", async () => {
    const { m, registry } = setup();
    m.push({ body: { ok: true } });
    await registry.get("wafle_gateways_delete")!.run({ gateway_id: 65 });
    expect(m.calls[0]!.method).toBe("DELETE");
    expect(m.calls[0]!.url).toMatch(/\/gateways\/65$/);
  });
});

describe("products tools", () => {
  it("wafle_products_list builds query", async () => {
    const { m, registry } = setup();
    m.push({ body: {} });
    await registry.get("wafle_products_list")!.run({
      slug: "lensitive",
      search: "lente",
      per_page: 10,
      page: 1,
    });
    expect(m.calls[0]!.url).toMatch(/search=lente/);
    expect(m.calls[0]!.url).toMatch(/per_page=10/);
  });

  it("wafle_products_create_manual POSTs body", async () => {
    const { m, registry } = setup();
    m.push({ body: { id: 1 } });
    const r = await registry.get("wafle_products_create_manual")!.run({
      slug: "lensitive",
      name: "Mochila",
      sku: "SKU-1",
      price: 100,
    });
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.method).toBe("POST");
    expect(JSON.parse(m.calls[0]!.body!).sku).toBe("SKU-1");
  });
});

describe("customers + analytics", () => {
  it("wafle_customers_orders pipes email to /orders?email=", async () => {
    const { m, registry } = setup();
    m.push({ body: {} });
    await registry.get("wafle_customers_orders")!.run({
      slug: "ga",
      email: "a@b.com",
      page: 1,
      per_page: 50,
    });
    expect(m.calls[0]!.url).toMatch(/email=a%40b\.com/);
  });

  it("wafle_analytics_summary range default 7d", async () => {
    const { m, registry } = setup();
    m.push({ body: {} });
    await registry.get("wafle_analytics_summary")!.run({ slug: "ga" });
    expect(m.calls[0]!.url).toMatch(/range=7d/);
  });
});

describe("coupons tools", () => {
  it("wafle_coupons_create POSTs full body", async () => {
    const { m, registry } = setup();
    m.push({ body: { id: 10 } });
    await registry.get("wafle_coupons_create")!.run({
      slug: "ga",
      code: "SUMMER",
      type: "percentage",
      value: 15,
    });
    const b = JSON.parse(m.calls[0]!.body!);
    expect(b.code).toBe("SUMMER");
    expect(b.type).toBe("percentage");
    expect(b.value).toBe(15);
  });
});

describe("system tools", () => {
  it("wafle_system_health hits /health", async () => {
    const { m, registry } = setup();
    m.push({ body: { status: "ok" } });
    await registry.get("wafle_system_health")!.run({});
    expect(m.calls[0]!.url).toMatch(/\/health$/);
  });

  it("wafle_system_audit_query supports filters", async () => {
    const { m, registry } = setup();
    m.push({ body: { entries: [] } });
    await registry.get("wafle_system_audit_query")!.run({
      page: 1,
      per_page: 20,
      actor_type: "master",
    });
    expect(m.calls[0]!.url).toMatch(/actor_type=master/);
    expect(m.calls[0]!.url).toMatch(/\/audit\?/);
  });

  it("wafle_system_release_deploy is annotated destructive", async () => {
    const { registry } = setup();
    const t = registry.get("wafle_system_release_deploy")!;
    expect(t.annotations.destructiveHint).toBe(true);
  });
});

describe("pixels tools", () => {
  it("wafle_pixels_set maps to flat fields on PATCH /stores/:slug", async () => {
    const { m, registry } = setup();
    m.push({ body: {} });
    await registry.get("wafle_pixels_set")!.run({
      slug: "ga",
      meta: "111",
      tiktok: null,
    });
    expect(m.calls[0]!.method).toBe("PATCH");
    const b = JSON.parse(m.calls[0]!.body!);
    expect(b.pixel_meta).toBe("111");
    expect(b.pixel_tiktok).toBe(null);
    expect(b.pixel_ga4).toBeUndefined();
  });
});

describe("ads ops tools (deep)", () => {
  it("wafle_ads_breakdown_by_creative GETs /ads/breakdown/creative with query", async () => {
    const { m, registry } = setup();
    m.push({ body: { creatives: [] } });
    const r = await registry
      .get("wafle_ads_breakdown_by_creative")!
      .run({ slug: "gamerland", campaign_id: "23859000111", range: "14d", min_spend_cents: 1000 });
    expect(r.isError).toBe(false);
    expect(m.calls[0]!.method).toBe("GET");
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland\/ads\/breakdown\/creative\?/);
    expect(m.calls[0]!.url).toMatch(/range=14d/);
    expect(m.calls[0]!.url).toMatch(/campaign_id=23859000111/);
  });

  it("wafle_ads_propose_pause_underperformers falls back to mock on 404", async () => {
    const { m, registry } = setup();
    m.push({ status: 404, body: { code: "not_found", message: "endpoint not implemented" } });
    const r = await registry
      .get("wafle_ads_propose_pause_underperformers")!
      .run({ slug: "gamerland", threshold_roas: 1.5 });
    expect(r.isError).toBe(false);
    const out = r.structuredContent as Record<string, unknown>;
    expect(out.mock).toBe(true);
    expect(Array.isArray(out.proposals)).toBe(true);
  });

  it("wafle_ads_audience_overlap_check passes audience_ids array", async () => {
    const { m, registry } = setup();
    m.push({ body: { audiences: [], overlaps: [] } });
    await registry
      .get("wafle_ads_audience_overlap_check")!
      .run({ slug: "gamerland", audience_ids: ["aaa", "bbb"], min_size: 500 });
    expect(m.calls[0]!.method).toBe("GET");
    expect(m.calls[0]!.url).toMatch(/\/stores\/gamerland\/ads\/audiences\/overlap/);
    expect(m.calls[0]!.url).toMatch(/audience_ids=aaa/);
    expect(m.calls[0]!.url).toMatch(/audience_ids=bbb/);
  });

  it("wafle_ads_creative_performance_log GETs the creative log path", async () => {
    const { m, registry } = setup();
    m.push({ body: { days: [] } });
    await registry
      .get("wafle_ads_creative_performance_log")!
      .run({ slug: "gamerland", creative_id: "cr_42", since: "2026-04-01" });
    expect(m.calls[0]!.url).toMatch(/\/ads\/creatives\/cr_42\/log\?/);
    expect(m.calls[0]!.url).toMatch(/since=2026-04-01/);
  });

  it("wafle_ads_generate_report_monthly hits monthly endpoint then falls back to /marketing/profit", async () => {
    const { m, registry } = setup();
    // First call: monthly endpoint not yet implemented.
    m.push({ status: 404, body: { code: "not_found" } });
    // Second call: profit endpoint succeeds.
    m.push({
      body: { spend_cents: 1000, revenue_cents: 3000, profit_cents: 800, roas: 3.0 },
    });
    const r = await registry
      .get("wafle_ads_generate_report_monthly")!
      .run({ slug: "gamerland", month: "2026-04" });
    expect(r.isError).toBe(false);
    expect(m.calls.length).toBeGreaterThanOrEqual(2);
    expect(m.calls[0]!.url).toMatch(/\/marketing\/report\/monthly\?month=2026-04/);
    expect(m.calls[1]!.url).toMatch(/\/marketing\/profit\?/);
    expect(m.calls[1]!.url).toMatch(/start=2026-04-01/);
    expect(m.calls[1]!.url).toMatch(/end=2026-04-30/);
  });

  it("wafle_ads_compare_periods makes 2 profit calls and computes deltas", async () => {
    const { m, registry } = setup();
    m.push({ body: { spend_cents: 1200, revenue_cents: 3000, profit_cents: 600, conversions: 30, roas: 2.5, cpa_cents: 4000 } });
    m.push({ body: { spend_cents: 1000, revenue_cents: 2000, profit_cents: 400, conversions: 20, roas: 2.0, cpa_cents: 5000 } });
    const r = await registry.get("wafle_ads_compare_periods")!.run({
      slug: "gamerland",
      period_a: { month: "2026-04" },
      period_b: { month: "2026-03" },
    });
    expect(r.isError).toBe(false);
    expect(m.calls.length).toBe(2);
    const out = r.structuredContent as Record<string, unknown>;
    const metrics = out.metrics as Record<string, { period_a: number; period_b: number; delta_pct: number }>;
    expect(metrics.spend_cents.delta_pct).toBeCloseTo(0.2, 5); // (1200-1000)/1000
    expect(metrics.revenue_cents.delta_pct).toBeCloseTo(0.5, 5);
  });
});

describe("registry total count", () => {
  it("registers >= 50 tools", () => {
    const { registry } = setup();
    expect(registry.size()).toBeGreaterThanOrEqual(50);
  });

  it("every tool name starts with wafle_", () => {
    const { registry } = setup();
    for (const t of registry.list()) expect(t.name.startsWith("wafle_")).toBe(true);
  });
});
