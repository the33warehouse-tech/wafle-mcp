/**
 * Checkout tools — talk to the new wafle_orders table via /admin/stores/:slug/orders/*.
 *
 * Disjoint from `tools/orders.ts`, which targets the legacy WC-backed
 * /stores/:slug/orders surface. The two are kept separate so callers can pick
 * which order pipeline they want to inspect:
 *   - ordersTools  → WC orders (rest-orders.php).
 *   - checkoutTools → wafle_orders rows (checkout/admin-rest.php).
 *
 * As a rule of thumb, anything that started life on a *.wafle.click storefront
 * after 2026-05-06 lives in wafle_orders; older WC orders stay reachable via
 * ordersTools.
 */
import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";

const CheckoutOrderStatus = z.enum([
  "pending",
  "pending_payment_proof",
  "pending_cash",
  "paid",
  "cancelled",
  "refunded",
  "failed",
]);

const OrderIdInput = z
  .object({
    slug: StoreSlug,
    order_id: z
      .union([z.number().int().positive(), z.string().min(3)])
      .describe("Numeric primary key OR public_id (e.g. WK9-2026-001-AbCd)."),
  })
  .strict();

export const checkoutTools: WafleTool[] = [
  {
    name: "wafle_checkout_orders_list",
    description:
      "List orders from the wafle_orders table for a store. Returns the new checkout pipeline (cart→MP/Stripe/transfer→paid). Filterable by status, date floor (`since`, ISO 8601), and customer email. For legacy WC orders use `wafle_orders_list` (different table).",
    inputSchema: z
      .object({
        slug: StoreSlug,
        status: CheckoutOrderStatus.optional(),
        since: z.string().optional().describe("ISO 8601 datetime, lower bound on created_at."),
        until: z.string().optional().describe("ISO 8601 datetime, upper bound on created_at."),
        email: z.string().email().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    scopes: ["orders:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/admin/stores/${encodeURIComponent(slug)}/orders`, {
        query: rest,
      });
    },
  },
  {
    name: "wafle_checkout_order_get",
    description:
      "Fetch one order from wafle_orders. `order_id` accepts either the numeric primary key or the public id (WK<L>-YYYY-NNN-rand) shown on the order detail page.",
    inputSchema: OrderIdInput,
    scopes: ["orders:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(
        `/admin/stores/${encodeURIComponent(input.slug)}/orders/${encodeURIComponent(String(input.order_id))}`,
      ),
  },
  {
    name: "wafle_checkout_order_refund",
    description:
      "Refund a paid order — full when `amount_cents` is omitted/0, partial otherwise. Guardrail: any refund > 50% of total_cents requires `confirm:true`. The refund is recorded on the wafle_orders row; the gateway-side refund call is gateway-specific and currently records `manual_refund:true` in metadata (gateway API integration ships in v2).",
    inputSchema: z
      .object({
        slug: StoreSlug,
        order_id: z.union([z.number().int().positive(), z.string().min(3)]),
        amount_cents: z.number().int().nonnegative().optional(),
        reason: z.string().optional(),
        confirm: z.boolean().optional(),
      })
      .strict(),
    scopes: ["orders:refund"],
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (input, ctx) => {
      const { slug, order_id, ...body } = input;
      return ctx.client.post<unknown>(
        `/admin/stores/${encodeURIComponent(slug)}/orders/${encodeURIComponent(String(order_id))}/refund`,
        body,
      );
    },
  },
  {
    name: "wafle_checkout_order_resend_email",
    description:
      "Resend a transactional email tied to an order. Default template: `order_confirmation`. Idempotency-keyed by template+public_id+timestamp so retries don't double-send within the same minute.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        order_id: z.union([z.number().int().positive(), z.string().min(3)]),
        template: z.string().default("order_confirmation"),
      })
      .strict(),
    scopes: ["orders:write"],
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => {
      const { slug, order_id, ...body } = input;
      return ctx.client.post<unknown>(
        `/admin/stores/${encodeURIComponent(slug)}/orders/${encodeURIComponent(String(order_id))}/resend-email`,
        body,
      );
    },
  },
  {
    name: "wafle_checkout_order_mark_paid",
    description:
      "Manually flip a transfer/cash order to paid (proof-of-deposit verified, cash collected at delivery). Returns 422 if the order is on a webhook-driven gateway (mp / stripe) — those move via /webhooks/* automatically.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        order_id: z.union([z.number().int().positive(), z.string().min(3)]),
        proof_ref: z.string().optional().describe("Bank reference or note recorded with the payment."),
      })
      .strict(),
    scopes: ["orders:write"],
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, order_id, ...body } = input;
      return ctx.client.post<unknown>(
        `/admin/stores/${encodeURIComponent(slug)}/orders/${encodeURIComponent(String(order_id))}/mark-paid`,
        body,
      );
    },
  },
  {
    name: "wafle_checkout_cart_recover",
    description:
      "List abandoned carts (cart_token has items but no `paid` order in wafle_orders) for a customer email hash. Used by retargeting drip flows to surface 'you left X in your cart' nudges.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        customer_email_hash: z
          .string()
          .min(64)
          .max(64)
          .regex(/^[a-f0-9]{64}$/i)
          .describe("sha256 of lowercased email"),
        since: z.string().optional().describe("ISO 8601 lower bound on cart updated_at — defaults to 7 days ago"),
      })
      .strict(),
    scopes: ["orders:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return ctx.client.get<unknown>(`/admin/stores/${encodeURIComponent(slug)}/carts/abandoned`, {
        query,
      });
    },
  },
];
