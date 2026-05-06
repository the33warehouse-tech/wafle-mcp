import { z } from "zod";
import type { WafleTool } from "./registry.js";

const GatewayType = z.enum([
  "mp_ar",
  "mp_mx",
  "mp_co",
  "mp_cl",
  "stripe",
  "transfer",
]);

// Gateways tools operate by `gateway_id` and `wafle_gateways_list` is a
// global cross-tenant view. They are admin-only — per-tenant clients should
// instead use `wafle_stores_get`/`wafle_stores_settings_update` to inspect
// or change the gateway IDs their store points at.
export const gatewaysTools: WafleTool[] = [
  {
    name: "wafle_gateways_list",
    description:
      "List all payment gateways across all stores (master view). Each gateway includes type, currency, active flag, store association.\n\n" +
      "Use to audit which stores have which gateways configured. Secrets are NEVER returned (only `{set:true}` markers).",
    inputSchema: z.object({}),
    scopes: ["gateways:read"],
    requiredMcpScope: "mcp:admin",
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/gateways"),
  },
  {
    name: "wafle_gateways_create",
    description:
      "Create a new gateway. Types:\n" +
      "- `mp_ar | mp_mx | mp_co | mp_cl`: MercadoPago, requires `creds.access_token` + `creds.public_key`.\n" +
      "- `stripe`: requires `creds.secret_key` + `creds.publishable_key`.\n" +
      "- `transfer`: requires `meta.cbu`, `meta.cbu_alias`, `meta.cbu_titular`, `meta.cbu_cuit`.\n\n" +
      "After creating, run `wafle_gateways_test` to verify credentials before pointing a store at it.",
    inputSchema: z.object({
      name: z.string().min(2),
      type: GatewayType,
      currency: z.string().length(3),
      active: z.boolean().default(true),
      description: z.string().optional(),
      creds: z.record(z.unknown()).optional().describe("Provider-specific credentials."),
      meta: z.record(z.unknown()).optional().describe("Provider-specific metadata."),
      store_slug: z.string().optional().describe("Optional: associate the gateway with a store on creation."),
    }),
    scopes: ["gateways:admin"],
    requiredMcpScope: "mcp:admin",
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (input, ctx) => ctx.client.post<unknown>("/gateways", input),
  },
  {
    name: "wafle_gateways_update",
    description:
      "Patch an existing gateway. Use to rotate credentials (`creds`) or toggle `active`.\n\n" +
      "Destructive in the sense that an inactive gateway will reject new charges; live transactions in flight are unaffected.",
    inputSchema: z.object({
      gateway_id: z.number().int().positive(),
      name: z.string().min(2).optional(),
      active: z.boolean().optional(),
      creds: z.record(z.unknown()).optional(),
      meta: z.record(z.unknown()).optional(),
      description: z.string().optional(),
    }),
    scopes: ["gateways:admin"],
    requiredMcpScope: "mcp:admin",
    annotations: { idempotentHint: true },
    handler: async (input, ctx) => {
      const { gateway_id, ...body } = input;
      return ctx.client.patch<unknown>(`/gateways/${gateway_id}`, body);
    },
  },
  {
    name: "wafle_gateways_test",
    description:
      "Run a live credential test against the gateway provider. For MP it calls `users/me`; for Stripe it calls `accounts/account`; for transfer it returns ok.\n\n" +
      "Use after `wafle_gateways_create` or `wafle_gateways_update` (rotated creds). Read-only on the upstream provider.",
    inputSchema: z.object({ gateway_id: z.number().int().positive() }),
    scopes: ["gateways:write"],
    requiredMcpScope: "mcp:admin",
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(`/gateways/${input.gateway_id}/test`),
  },
  {
    name: "wafle_gateways_delete",
    description:
      "Delete a gateway. Fails if the gateway is currently the default for any store — switch the store first.\n\n" +
      "Destructive and irreversible. Confirm with the user.",
    inputSchema: z.object({ gateway_id: z.number().int().positive() }),
    scopes: ["gateways:admin"],
    requiredMcpScope: "mcp:admin",
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (input, ctx) => ctx.client.delete<unknown>(`/gateways/${input.gateway_id}`),
  },
];
