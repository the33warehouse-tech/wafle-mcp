import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug, Pagination } from "../schemas/common.js";

export const customersTools: WafleTool[] = [
  {
    name: "wafle_customers_list",
    description:
      "List customers of a store with pagination + filters: search by email/name, has-orders, segment.\n\n" +
      "Wafle treats customers as derived data over `orders` — there's no separate sign-up table for storefronts.",
    inputSchema: z.object({
      slug: StoreSlug,
      page: Pagination.page,
      per_page: Pagination.per_page,
      search: z.string().optional(),
      segment: z.string().optional().describe("Segment slug, e.g. 'high_value', 'recovered'."),
    }),
    scopes: ["customers:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/customers`, { query: rest });
    },
  },
  {
    name: "wafle_customers_get",
    description:
      "Fetch a single customer profile by email. Returns aggregated stats: lifetime value, order count, last seen, top SKUs.",
    inputSchema: z.object({ slug: StoreSlug, email: z.string().email() }),
    scopes: ["customers:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/customers/${encodeURIComponent(input.email)}`,
      ),
  },
  {
    name: "wafle_customers_orders",
    description: "List the orders of a single customer (by email).",
    inputSchema: z.object({
      slug: StoreSlug,
      email: z.string().email(),
      page: Pagination.page,
      per_page: Pagination.per_page,
    }),
    scopes: ["customers:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(`/stores/${encodeURIComponent(input.slug)}/orders`, {
        query: { email: input.email, page: input.page, per_page: input.per_page },
      }),
  },
  {
    name: "wafle_customers_segments_list",
    description:
      "List all customer segments configured for a store. Segments power the `segment=` filter in `wafle_customers_list` and the audience exports.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["customers:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(`/stores/${encodeURIComponent(input.slug)}/segments`),
  },
];
