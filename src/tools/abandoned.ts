import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug, Pagination } from "../schemas/common.js";

export const abandonedTools: WafleTool[] = [
  {
    name: "wafle_abandoned_list",
    description:
      "List abandoned cart sessions: last activity, items, optional email captured before exit.\n\n" +
      "Use to estimate recovery potential or to feed a manual outreach campaign.",
    inputSchema: z.object({
      slug: StoreSlug,
      page: Pagination.page,
      per_page: Pagination.per_page,
      with_email: z.boolean().optional().describe("If true, only sessions where the user typed an email."),
      since_ts: z.number().int().optional().describe("Only sessions newer than this epoch second."),
    }),
    scopes: ["abandoned:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/abandoned`, { query: rest });
    },
  },
  {
    name: "wafle_abandoned_send_recovery",
    description:
      "Trigger a recovery email to the captured address of an abandoned-cart session. The email contains a one-click recovery link with the cart pre-filled.\n\n" +
      "Idempotent: re-sending within the cooldown window is a no-op (wafle returns the existing send id).",
    inputSchema: z.object({
      slug: StoreSlug,
      session_id: z.string().min(3),
      template: z.string().optional().describe("Template id to use. Default: store's configured recovery template."),
      coupon_code: z.string().optional().describe("Optional coupon to attach as incentive."),
    }),
    scopes: ["abandoned:send"],
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(`/stores/${encodeURIComponent(input.slug)}/recovery-queue`, {
        sessionId: input.session_id,
        ...(input.template !== undefined ? { template: input.template } : {}),
        ...(input.coupon_code !== undefined ? { coupon: input.coupon_code } : {}),
      }),
  },
];
