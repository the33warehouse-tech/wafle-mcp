import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";

export const storesTools: WafleTool[] = [
  {
    name: "wafle_stores_list",
    description:
      "List all wafle stores the configured key can see. Each store includes id, slug, name, domain, brand color, payment + shipping config, gateway IDs, and customer-service contacts.\n\n" +
      "Use this as the first call when the user asks 'what stores does X have?' or before any per-store action — you'll need the slug.",
    inputSchema: z.object({}).describe("No parameters."),
    scopes: ["stores:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: list stores" },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/stores"),
  },
  {
    name: "wafle_stores_get",
    description:
      "Fetch the full configuration of a single store. Includes payment gateway IDs (mp/stripe/transfer), shipping methods (andreani/oca/retiro), CBU/alias, social pixels, theme, abandoned-cart settings.\n\n" +
      "Use before editing settings — you need the current shape to send a delta.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["stores:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => ctx.client.get<unknown>(`/stores/${encodeURIComponent(input.slug)}`),
  },
  {
    name: "wafle_stores_create",
    description:
      "Create a brand new wafle store. Required: slug, name, domain.\n\n" +
      "Use to onboard a new client. After creating, you'll typically run `wafle_gateways_create`, `wafle_stores_settings_update`, and either `wafle_products_sync_trigger` (for catalog-sync stores) or `wafle_products_create_manual` for manual catalogs.\n\n" +
      "DESTRUCTIVE side effect: also provisions a per-store API key, audit log entry, and a default gateway slot.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        name: z.string().min(2).describe("Human-readable name, e.g. 'Lensitive'."),
        domain: z.string().min(3).describe("Public domain, e.g. 'lensitive.com.ar'."),
        theme_color: z.string().optional().describe("Hex color for storefront, e.g. '#8b5cf6'."),
        catalog_mode: z
          .enum(["supabase_sync", "manual"])
          .optional()
          .describe("Where the catalog comes from."),
        currency: z.string().length(3).optional().describe("ISO currency code, e.g. 'ARS'."),
      })
      .describe("Store provisioning input."),
    scopes: ["stores:admin"],
    annotations: { destructiveHint: false, idempotentHint: false, title: "Wafle: create store" },
    handler: async (input, ctx) => ctx.client.post<unknown>("/stores", input),
  },
  {
    name: "wafle_stores_update",
    description:
      "Update top-level store fields. Only the fields you pass are changed (PATCH semantics).\n\n" +
      "Common edits: theme_color, domain, free_shipping_from, payment_methods, shipping_methods. To change pixel/marketing IDs use `wafle_pixels_set`.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        name: z.string().min(2).optional(),
        domain: z.string().min(3).optional(),
        theme_color: z.string().optional(),
        free_shipping_from: z.number().nonnegative().optional().describe("Subtotal threshold for free shipping in store currency. 0 disables."),
        payment_methods: z
          .array(z.enum(["mp", "stripe", "transfer"]))
          .optional()
          .describe("Whitelist of enabled payment methods."),
        shipping_methods: z
          .array(z.string())
          .optional()
          .describe("e.g. ['andreani','oca','retiro','gratis']"),
        cbu: z.string().optional(),
        cbu_alias: z.string().optional(),
        cbu_titular: z.string().optional(),
        cbu_cuit: z.string().optional(),
      })
      .describe("Partial update payload."),
    scopes: ["stores:write"],
    annotations: { idempotentHint: true, title: "Wafle: update store" },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.patch<unknown>(`/stores/${encodeURIComponent(slug)}`, rest);
    },
  },
  {
    name: "wafle_stores_settings_get",
    description:
      "Alias of `wafle_stores_get` returning only the settings subtree (no items/orders). Convenient for review/diff workflows.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["stores:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const data = await ctx.client.get<{ stores?: unknown }>(`/stores/${encodeURIComponent(input.slug)}`);
      return data;
    },
  },
  {
    name: "wafle_stores_settings_update",
    description:
      "Update the store's settings subtree (operationally identical to `wafle_stores_update` today; provided as a stable name for the future split).",
    inputSchema: z
      .object({
        slug: StoreSlug,
        settings: z.record(z.unknown()).describe("Object of fields to merge."),
      })
      .describe("Settings update payload."),
    scopes: ["stores:write"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.patch<unknown>(`/stores/${encodeURIComponent(input.slug)}`, input.settings),
  },
];
