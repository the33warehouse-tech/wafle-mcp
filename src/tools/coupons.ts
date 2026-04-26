import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";

const CouponType = z.enum(["percentage", "fixed", "free_shipping"]);

export const couponsTools: WafleTool[] = [
  {
    name: "wafle_coupons_list",
    description:
      "List all coupons of a store. Each row: code, type, value, usage, validity dates, applies-to scope.\n\n" +
      "Use to audit active discounts or to find a code before editing.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["coupons:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(`/stores/${encodeURIComponent(input.slug)}/coupons`),
  },
  {
    name: "wafle_coupons_create",
    description:
      "Create a coupon. Codes are case-insensitive. Date fields are epoch seconds (0 = no bound).\n\n" +
      "Common patterns:\n" +
      "- `type=percentage, value=10` → 10% off whole cart.\n" +
      "- `type=fixed, value=5000, applies_to='product', applies_to_ids=[123]` → ARS 5000 off product 123.\n" +
      "- `type=free_shipping` → no shipping cost.\n",
    inputSchema: z.object({
      slug: StoreSlug,
      code: z.string().min(2),
      type: CouponType,
      value: z.number().nonnegative().describe("Discount magnitude (% for percentage, currency for fixed)."),
      min_subtotal: z.number().nonnegative().default(0),
      max_uses: z.number().int().nonnegative().default(0).describe("0 = unlimited."),
      starts_at: z.number().int().nonnegative().default(0),
      expires_at: z.number().int().nonnegative().default(0),
      active: z.boolean().default(true),
      stackable: z.boolean().default(false),
      applies_to: z.enum(["all", "product", "category"]).default("all"),
      applies_to_ids: z.array(z.union([z.string(), z.number()])).optional(),
    }),
    scopes: ["coupons:write"],
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { slug, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/coupons`, body);
    },
  },
  {
    name: "wafle_coupons_update",
    description: "Patch a coupon by id. Only sent fields change.",
    inputSchema: z.object({
      slug: StoreSlug,
      coupon_id: z.number().int().positive(),
      value: z.number().nonnegative().optional(),
      max_uses: z.number().int().nonnegative().optional(),
      expires_at: z.number().int().nonnegative().optional(),
      active: z.boolean().optional(),
    }),
    scopes: ["coupons:write"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, coupon_id, ...body } = input;
      return ctx.client.patch<unknown>(
        `/stores/${encodeURIComponent(slug)}/coupons/${coupon_id}`,
        body,
      );
    },
  },
  {
    name: "wafle_coupons_delete",
    description: "Delete a coupon by id. Past usage history is preserved on orders.",
    inputSchema: z.object({ slug: StoreSlug, coupon_id: z.number().int().positive() }),
    scopes: ["coupons:write"],
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.delete<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/coupons/${input.coupon_id}`,
      ),
  },
];
