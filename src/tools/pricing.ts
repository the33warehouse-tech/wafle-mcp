import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";
import { resolveSlug, isTenantSlugError } from "./tenant-helper.js";

const RuleType = z.enum(["multiplier", "discount_tier", "category_markup", "fixed_price"]);

export const pricingTools: WafleTool[] = [
  {
    name: "wafle_pricing_rules_list",
    description:
      "List all dynamic pricing rules of a store: catalog-wide multipliers, category markups, sale discount tiers, fixed prices on specific SKUs.\n\n" +
      "Use before editing — pricing rules compose, so you need to know what's already there.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["pricing:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/v2/pricing-rules`);
    },
  },
  {
    name: "wafle_pricing_rules_create",
    description:
      "Create a new pricing rule. Types:\n" +
      "- `multiplier`: catalog-wide markup (e.g. 2.2 = +120% on every base price).\n" +
      "- `discount_tier`: percentage discount when subtotal crosses a threshold.\n" +
      "- `category_markup`: per-category multiplier override.\n" +
      "- `fixed_price`: pin a specific SKU to a fixed price (overrides multiplier).\n\n" +
      "Always preview with `wafle_pricing_compute_preview` before committing rules in production.",
    inputSchema: z.object({
      slug: StoreSlug,
      type: RuleType,
      value: z.union([z.number(), z.array(z.unknown())]).describe(
        "For `multiplier`: a number. For `discount_tier`: array `[{min_subtotal, percent}]`. For `fixed_price`: number. For `category_markup`: number.",
      ),
      target: z
        .string()
        .optional()
        .describe("Category slug or SKU depending on type."),
      active: z.boolean().default(true),
      label: z.string().optional(),
    }),
    scopes: ["pricing:write"],
    annotations: { idempotentHint: false },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/v2/pricing-rules`, body);
    },
  },
  {
    name: "wafle_pricing_rules_update",
    description: "Patch an existing pricing rule by id.",
    inputSchema: z.object({
      slug: StoreSlug,
      rule_id: z.number().int().positive(),
      value: z.union([z.number(), z.array(z.unknown())]).optional(),
      active: z.boolean().optional(),
      label: z.string().optional(),
    }),
    scopes: ["pricing:write"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, rule_id, ...body } = input;
      return ctx.client.patch<unknown>(
        `/stores/${encodeURIComponent(slug)}/v2/pricing-rules/${rule_id}`,
        body,
      );
    },
  },
  {
    name: "wafle_pricing_rules_delete",
    description: "Delete a pricing rule by id. Irreversible — confirm before calling.",
    inputSchema: z.object({ slug: StoreSlug, rule_id: z.number().int().positive() }),
    scopes: ["pricing:write"],
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.delete<unknown>(
        `/stores/${encodeURIComponent(slug)}/v2/pricing-rules/${input.rule_id}`,
      );
    },
  },
  {
    name: "wafle_pricing_compute_preview",
    description:
      "Compute the final price of a list of (sku, qty) pairs given the store's current rules. Returns base price, applied rules, final price.\n\n" +
      "Use as a sanity check before publishing pricing changes — answers 'how much would I be charging?' without disturbing the live cart.",
    inputSchema: z.object({
      slug: StoreSlug,
      items: z
        .array(
          z.object({
            sku: z.string().min(1),
            qty: z.number().int().positive().default(1),
          }),
        )
        .min(1),
    }),
    scopes: ["pricing:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/pricing/preview`,
        { items: input.items },
      );
    },
  },
];
