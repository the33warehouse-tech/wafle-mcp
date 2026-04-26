import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug, Pagination } from "../schemas/common.js";

export const productsTools: WafleTool[] = [
  {
    name: "wafle_products_list",
    description:
      "List products of a single store with pagination + optional search/filter. Returns id, slug, name, sku, price, stock, status, images.\n\n" +
      "Use to browse catalog or to find a product id before editing/overriding.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        page: Pagination.page,
        per_page: Pagination.per_page,
        search: z.string().optional().describe("Free-text search across name/sku."),
        category: z.string().optional().describe("Filter by category slug."),
        status: z.enum(["active", "inactive", "draft"]).optional(),
      })
      .describe("List options."),
    scopes: ["products:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/products`, { query: rest });
    },
  },
  {
    name: "wafle_products_search",
    description:
      "Lightweight search of products by name/sku. Equivalent to `wafle_products_list` with `search` set, but optimized for autocomplete.",
    inputSchema: z.object({
      slug: StoreSlug,
      q: z.string().min(1).describe("Search term (name or SKU substring)."),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    scopes: ["products:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(`/stores/${encodeURIComponent(input.slug)}/products`, {
        query: { search: input.q, per_page: input.limit, page: 1 },
      }),
  },
  {
    name: "wafle_products_get",
    description:
      "Fetch a single product by slug (the URL-friendly id). Returns full detail including variants, images, attributes and overrides.",
    inputSchema: z.object({
      slug: StoreSlug,
      product_slug: z.string().min(1).describe("Product slug (URL portion)."),
    }),
    scopes: ["products:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/products/${encodeURIComponent(input.product_slug)}`,
      ),
  },
  {
    name: "wafle_products_create_manual",
    description:
      "Manually create a product in a store whose `catalog_mode = manual`.\n\n" +
      "Do NOT use on stores with `catalog_mode = supabase_sync` — those products come from the upstream catalog and a manual create will be overwritten on next sync. For sync stores, use `wafle_products_override` to tweak fields without losing them on sync.",
    inputSchema: z.object({
      slug: StoreSlug,
      name: z.string().min(2),
      sku: z.string().min(1),
      price: z.number().nonnegative(),
      stock: z.number().int().nonnegative().default(0),
      description: z.string().optional(),
      images: z.array(z.string().url()).optional().describe("List of image URLs."),
      category: z.string().optional(),
      status: z.enum(["active", "inactive", "draft"]).default("active"),
    }),
    scopes: ["products:write"],
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { slug, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/products`, body);
    },
  },
  {
    name: "wafle_products_update",
    description:
      "Partial update of a product by numeric id. PATCH semantics — only the fields you pass change.\n\n" +
      "For sync stores, prefer `wafle_products_override` so the sync engine respects your tweaks.",
    inputSchema: z.object({
      slug: StoreSlug,
      product_id: z.number().int().positive(),
      name: z.string().min(2).optional(),
      price: z.number().nonnegative().optional(),
      stock: z.number().int().nonnegative().optional(),
      status: z.enum(["active", "inactive", "draft"]).optional(),
      description: z.string().optional(),
      images: z.array(z.string().url()).optional(),
    }),
    scopes: ["products:write"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, product_id, ...body } = input;
      return ctx.client.patch<unknown>(
        `/stores/${encodeURIComponent(slug)}/products/${product_id}`,
        body,
      );
    },
  },
  {
    name: "wafle_products_override",
    description:
      "Set per-product overrides (price, name, description, images) that survive catalog syncs. Use on `supabase_sync` stores when you need to tweak a single product without forking the whole catalog.\n\n" +
      "Wafle stores overrides server-side and re-applies them after every sync.",
    inputSchema: z.object({
      slug: StoreSlug,
      product_id: z.number().int().positive(),
      overrides: z.record(z.unknown()).describe("Object of fields to override."),
    }),
    scopes: ["products:write"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.patch<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/products/${input.product_id}`,
        { overrides: input.overrides },
      ),
  },
  {
    name: "wafle_products_sync_trigger",
    description:
      "Trigger an asynchronous catalog sync for a store. Returns a job id; poll `wafle_products_sync_status` until done.\n\n" +
      "Only meaningful on `catalog_mode = supabase_sync` stores. On manual stores it's a no-op error.",
    inputSchema: z.object({
      slug: StoreSlug,
      mode: z.enum(["incremental", "full"]).default("incremental").describe("`full` rewrites all products; `incremental` only changed ones."),
    }),
    scopes: ["products:admin"],
    annotations: { idempotentHint: false, destructiveHint: false },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(`/stores/${encodeURIComponent(input.slug)}/products/sync`, {
        mode: input.mode,
      }),
  },
  {
    name: "wafle_products_sync_status",
    description:
      "Get the status of a product-sync job (pending|running|done|failed). Pair with `wafle_products_sync_trigger`.",
    inputSchema: z.object({
      job_id: z.string().min(3).describe("Job id returned by `wafle_products_sync_trigger`."),
    }),
    scopes: ["products:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(`/system/queue/job/${encodeURIComponent(input.job_id)}`),
  },
];
