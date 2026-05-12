import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug, Pagination } from "../schemas/common.js";
import { resolveSlug, isTenantSlugError } from "./tenant-helper.js";

const OrderStatus = z.enum([
  "pending",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
]);

export const ordersTools: WafleTool[] = [
  {
    name: "wafle_orders_list",
    description:
      "List orders for a store with pagination + filters. Filters: status, date range, customer email, search.\n\n" +
      "Use this for any 'pendientes', 'enviados', 'últimos N días' style query. The response includes `meta.gatewayId` and `meta.gatewayType` so you can correlate with payment status.",
    inputSchema: z.object({
      slug: StoreSlug,
      page: Pagination.page,
      per_page: Pagination.per_page,
      status: OrderStatus.optional(),
      from_ts: z.number().int().optional().describe("Epoch seconds, lower bound on `created`."),
      to_ts: z.number().int().optional().describe("Epoch seconds, upper bound on `created`."),
      email: z.string().email().optional().describe("Filter by customer email."),
      search: z.string().optional(),
    }),
    scopes: ["orders:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/orders`, { query: rest });
    },
  },
  {
    name: "wafle_orders_get",
    description:
      "Fetch a single order by id. Returns customer, items, totals, gateway info, status, shipment data, timeline reference.",
    inputSchema: z.object({ slug: StoreSlug, order_id: z.number().int().positive() }),
    scopes: ["orders:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(slug)}/orders/${input.order_id}`,
      );
    },
  },
  {
    name: "wafle_orders_create",
    description:
      "Manually create an order. Use only for migrations or telephone sales — normal orders flow from the storefront.\n\n" +
      "Body uses canonical snake_case shape: items[]+payment_method+gateway_id (see waffle-docs/API-CONVENTIONS.md).\n" +
      "Idempotency-Key header is auto-set; safe to retry on transient errors.",
    inputSchema: z.object({
      slug: StoreSlug,
      customer: z.object({
        email: z.string().email(),
        firstName: z.string().min(1),
        lastName: z.string().optional(),
        phone: z.string().optional(),
      }),
      shipping: z
        .object({
          address: z.string(),
          city: z.string(),
          province: z.string().optional(),
          postalCode: z.string().optional(),
          method: z.string().optional().describe("Shipping method slug, e.g. 'andreani', 'retiro'."),
        })
        .optional(),
      items: z
        .array(
          z.object({
            sku: z.string(),
            name: z.string().optional(),
            quantity: z.number().int().positive().default(1),
            unit_price: z
              .number()
              .nonnegative()
              .optional()
              .describe("Per-unit price in major units (ARS) — same currency as the store."),
            product_id: z
              .number()
              .int()
              .nonnegative()
              .optional()
              .describe("Optional WC product id to bind the line to."),
          }),
        )
        .min(1),
      payment_method: z
        .enum(["mp", "stripe", "transfer", "cash"])
        .default("transfer")
        .describe("Payment method routing — wafle picks the matching gateway unless gateway_id is set."),
      gateway_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Explicit gateway id — overrides payment_method routing."),
      coupon_code: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }),
    scopes: ["orders:write"],
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/orders`, body);
    },
  },
  {
    name: "wafle_orders_ship",
    description:
      "Mark an order as shipped. Records the carrier, tracking number, and updates status to `shipped`.\n\n" +
      "Triggers the customer notification email if the store has it enabled.",
    inputSchema: z.object({
      slug: StoreSlug,
      order_id: z.number().int().positive(),
      carrier: z.string().min(2).describe("Carrier slug, e.g. 'andreani', 'oca', 'viacargo'."),
      tracking_number: z.string().min(2),
      tracking_url: z.string().url().optional(),
      notify_customer: z.boolean().default(true),
    }),
    scopes: ["orders:write"],
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, order_id, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/orders/${order_id}/ship`,
        body,
      );
    },
  },
  {
    name: "wafle_orders_cancel",
    description:
      "Cancel an order. If the gateway supports auto-refund and the order was paid, wafle will trigger the refund.\n\n" +
      "Destructive: the order moves to `cancelled` and inventory is restocked. Confirm with the user before running.",
    inputSchema: z.object({
      slug: StoreSlug,
      order_id: z.number().int().positive(),
      reason: z.string().optional(),
      refund: z.boolean().default(true).describe("Whether to also issue a refund (if applicable)."),
    }),
    scopes: ["orders:write"],
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, order_id, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/orders/${order_id}/cancel`,
        body,
      );
    },
  },
  {
    name: "wafle_orders_refund",
    description:
      "Refund a paid order, fully or partially. The refund is sent through whichever gateway captured the payment (MercadoPago / Stripe / manual transfer).\n\n" +
      "Destructive AND irreversible. Confirm amount before calling.",
    inputSchema: z.object({
      slug: StoreSlug,
      order_id: z.number().int().positive(),
      amount: z.number().nonnegative().optional().describe("Omit for full refund; set for partial."),
      reason: z.string().optional(),
    }),
    scopes: ["orders:refund"],
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, order_id, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/orders/${order_id}/refund`,
        body,
      );
    },
  },
  {
    name: "wafle_orders_add_note",
    description:
      "Add an internal or customer-visible note to an order. Notes appear in the timeline and (if `customer=true`) in the customer's order detail page + email.",
    inputSchema: z.object({
      slug: StoreSlug,
      order_id: z.number().int().positive(),
      text: z.string().min(1),
      customer_visible: z.boolean().default(false),
    }),
    scopes: ["orders:write"],
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/orders/${input.order_id}/note`,
        { text: input.text, customer: input.customer_visible },
      );
    },
  },
  {
    name: "wafle_orders_timeline",
    description:
      "Get the chronological timeline of an order: status changes, payment events, shipment, notes, refunds.\n\n" +
      "Use to audit how an order got into its current state.",
    inputSchema: z.object({ slug: StoreSlug, order_id: z.number().int().positive() }),
    scopes: ["orders:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(slug)}/orders/${input.order_id}/timeline`,
      );
    },
  },
];
