import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";
import { resolveSlug, isTenantSlugError } from "./tenant-helper.js";

export const shippingTools: WafleTool[] = [
  {
    name: "wafle_shipping_rates_quote",
    description:
      "Quote shipping rates for a destination + cart. Returns one row per available carrier (andreani, oca, viacargo, retiro, gratis) with cost + ETA.\n\n" +
      "Use as an estimate before checkout, or to debug 'why isn't carrier X showing up?'.",
    inputSchema: z.object({
      slug: StoreSlug,
      destination: z.object({
        postalCode: z.string().min(3),
        province: z.string().optional(),
        city: z.string().optional(),
        country: z.string().length(2).default("AR"),
      }),
      items: z
        .array(
          z.object({
            sku: z.string(),
            quantity: z.number().int().positive().default(1),
            weightKg: z.number().nonnegative().optional(),
          }),
        )
        .min(1),
      subtotal: z.number().nonnegative().optional().describe("Cart subtotal in store currency, used for free-shipping logic."),
    }),
    scopes: ["shipping:quote"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/shipping/rates`, body);
    },
  },
  {
    name: "wafle_shipping_carriers_status",
    description:
      "Run the carrier connection self-test for a store. Hits each configured carrier API once and reports `ok|degraded|down` + latency.\n\n" +
      "Use when shipping rates are flaky or empty.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["shipping:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/shipping/test`);
    },
  },
];
