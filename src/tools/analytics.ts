import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";
import { resolveSlug, isTenantSlugError } from "./tenant-helper.js";

const Range = z.enum(["1d", "7d", "30d", "90d", "ytd", "custom"]).describe("Predefined window or 'custom' (then provide from_ts/to_ts).");

export const analyticsTools: WafleTool[] = [
  {
    name: "wafle_analytics_summary",
    description:
      "High-level KPIs for a store over a window: orders, revenue, AOV, top products, conversion funnel, abandoned-cart rate.\n\n" +
      "Use as the starting point of any 'how is store X doing?' question.",
    inputSchema: z.object({
      slug: StoreSlug,
      range: Range.default("7d"),
      from_ts: z.number().int().optional(),
      to_ts: z.number().int().optional(),
    }),
    scopes: ["analytics:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/analytics`, { query: rest });
    },
  },
  {
    name: "wafle_analytics_by_period",
    description:
      "Time-series breakdown of analytics: revenue + orders bucketed by day/week/month.\n\n" +
      "Use for charts and 'compare last 30d to previous 30d' workflows.",
    inputSchema: z.object({
      slug: StoreSlug,
      bucket: z.enum(["day", "week", "month"]).default("day"),
      range: Range.default("30d"),
      from_ts: z.number().int().optional(),
      to_ts: z.number().int().optional(),
    }),
    scopes: ["analytics:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/analytics`, { query: { ...rest, group: rest.bucket } });
    },
  },
];
