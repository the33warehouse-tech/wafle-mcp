/**
 * Prompt registry: argument validation, snake_case enforcement, rendering.
 */
import { describe, it, expect } from "vitest";
import { PromptRegistry, createPromptRegistry } from "../src/prompts/index.js";

describe("PromptRegistry — registration", () => {
  it("rejects non-snake_case prompt names", () => {
    const r = new PromptRegistry();
    expect(() =>
      r.register({
        name: "BadName",
        description: "x",
        arguments: [],
        handler: () => ({ messages: [] }),
      }),
    ).toThrow(/snake_case/);
  });

  it("rejects duplicate prompt names", () => {
    const r = new PromptRegistry();
    const p = {
      name: "good",
      description: "x",
      arguments: [],
      handler: () => ({ messages: [] }),
    };
    r.register(p);
    expect(() => r.register(p)).toThrow(/duplicate/i);
  });

  it("rejects non-snake_case argument names", () => {
    const r = new PromptRegistry();
    expect(() =>
      r.register({
        name: "good",
        description: "x",
        arguments: [{ name: "BadArg", description: "x", required: true }],
        handler: () => ({ messages: [] }),
      }),
    ).toThrow(/snake_case/);
  });
});

describe("PromptRegistry — argument validation", () => {
  const r = new PromptRegistry();
  r.register({
    name: "test_p",
    description: "test",
    arguments: [
      { name: "store_slug", description: "slug", required: true },
      { name: "order_id", description: "id", required: false },
    ],
    handler: (args) => ({
      messages: [
        { role: "user", content: { type: "text", text: `slug=${args["store_slug"]} order=${args["order_id"] ?? "none"}` } },
      ],
    }),
  });

  it("missing required argument throws", () => {
    expect(() => r.get("test_p", {})).toThrow(/required/);
  });

  it("renders with required arg only", () => {
    const out = r.get("test_p", { store_slug: "gamerland" });
    expect(out.messages[0]!.content.text).toBe("slug=gamerland order=none");
  });

  it("renders with optional arg", () => {
    const out = r.get("test_p", { store_slug: "gamerland", order_id: 87 });
    expect(out.messages[0]!.content.text).toBe("slug=gamerland order=87");
  });

  it("trims whitespace from string args", () => {
    const out = r.get("test_p", { store_slug: "  gamerland  " });
    expect(out.messages[0]!.content.text).toBe("slug=gamerland order=none");
  });

  it("rejects oversized args", () => {
    const huge = "x".repeat(10_000);
    expect(() => r.get("test_p", { store_slug: huge })).toThrow(/exceeds/);
  });

  it("treats empty string as missing", () => {
    expect(() => r.get("test_p", { store_slug: "" })).toThrow(/required/);
  });

  it("get on unknown prompt throws", () => {
    expect(() => r.get("does_not_exist", {})).toThrow(/Unknown/);
  });
});

describe("PromptRegistry — full registry", () => {
  it("registers all 5 expected prompts", () => {
    const r = createPromptRegistry();
    expect(r.size()).toBe(5);
    const names = r.list().map((p) => p.name);
    expect(names).toContain("onboarding_tienda_nueva");
    expect(names).toContain("pedido_enviar");
    expect(names).toContain("segmentar_y_campania");
    expect(names).toContain("conectar_meta_y_sync");
    expect(names).toContain("debug_orden_fallida");
  });

  it("onboarding renders a user message containing the slug", () => {
    const r = createPromptRegistry();
    const out = r.get("onboarding_tienda_nueva", {
      store_name: "Calista",
      store_slug: "calista",
    });
    expect(out.messages.length).toBe(1);
    expect(out.messages[0]!.role).toBe("user");
    expect(out.messages[0]!.content.text).toMatch(/calista/i);
    expect(out.messages[0]!.content.text).toMatch(/wafle_stores_create/);
    expect(out.messages[0]!.content.text).toMatch(/wafle_auth_keys_create/);
  });

  it("onboarding includes MP block only when token provided", () => {
    const r = createPromptRegistry();
    const without = r.get("onboarding_tienda_nueva", { store_name: "X", store_slug: "x" });
    expect(without.messages[0]!.content.text).not.toMatch(/wafle_gateways_create/);
    expect(without.messages[0]!.content.text).toMatch(/Sin gateway de pago/);
    const withMp = r.get("onboarding_tienda_nueva", {
      store_name: "X",
      store_slug: "x",
      mp_access_token: "APP_USR-123",
    });
    expect(withMp.messages[0]!.content.text).toMatch(/wafle_gateways_create/);
    expect(withMp.messages[0]!.content.text).toMatch(/APP_USR-123/);
  });

  it("pedido_enviar renders carrier + tracking", () => {
    const r = createPromptRegistry();
    const out = r.get("pedido_enviar", {
      store_slug: "gamerland",
      order_id: 87,
      carrier: "andreani",
      tracking_number: "ABC123",
    });
    const text = out.messages[0]!.content.text;
    expect(text).toMatch(/87/);
    expect(text).toMatch(/andreani/);
    expect(text).toMatch(/ABC123/);
    expect(text).toMatch(/wafle_orders_ship/);
  });

  it("conectar_meta_y_sync renders the connection IDs", () => {
    const r = createPromptRegistry();
    const out = r.get("conectar_meta_y_sync", {
      store_slug: "gamerland",
      business_manager_id: "111",
      ad_account_id: "act_222",
      catalog_id: "333",
      schedule_interval: "6h",
    });
    const text = out.messages[0]!.content.text;
    expect(text).toMatch(/business_manager_id.*111/);
    expect(text).toMatch(/act_222/);
    expect(text).toMatch(/wafle_ads_catalog_schedule_set/);
  });

  it("debug_orden_fallida — retry section only when retry_gateway_type provided", () => {
    const r = createPromptRegistry();
    const noRetry = r.get("debug_orden_fallida", { store_slug: "gamerland", order_id: 145 });
    expect(noRetry.messages[0]!.content.text).not.toMatch(/Reintentar con gateway secundario/);
    const withRetry = r.get("debug_orden_fallida", {
      store_slug: "gamerland",
      order_id: 145,
      retry_gateway_type: "transfer",
    });
    expect(withRetry.messages[0]!.content.text).toMatch(/Reintentar con gateway secundario/);
    expect(withRetry.messages[0]!.content.text).toMatch(/type=transfer/);
  });

  it("segmentar_y_campania includes preview block when send_preview_to provided", () => {
    const r = createPromptRegistry();
    const withPreview = r.get("segmentar_y_campania", {
      store_slug: "gamerland",
      segment_name: "Top",
      criteria_description: "high spenders",
      template_slug: "promo",
      subject: "Hello",
      send_preview_to: "me@example.com",
    });
    expect(withPreview.messages[0]!.content.text).toMatch(/wafle_marketing_campaigns_send_preview/);
  });
});
