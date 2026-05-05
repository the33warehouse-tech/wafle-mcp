/**
 * Users + memberships tools.
 *
 * These tools are useful when the MCP is authenticated with a SESSION token
 * (`WAFLE_USER_SESSION=wfl_session_…`) — they let the LLM operate as the
 * actual human across multiple tenants.
 *
 * They will also work with the master API key (treat as a "system admin"
 * actor with no membership context — `wafle_users_me` returns 401 in that
 * case; the membership endpoints respect the API key's tenant binding).
 */
import { z } from "zod";
import type { WafleTool } from "./registry.js";

const Empty = z.object({}).describe("No parameters.");

export const usersTools: WafleTool[] = [
  {
    name: "wafle_users_me",
    description:
      "Return the currently-authenticated human's profile + memberships + current tenant.\n\n" +
      "Requires a session token (WAFLE_USER_SESSION). Will fail with 401 if the MCP is using a legacy API key.",
    inputSchema: Empty,
    scopes: ["auth:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: who am I (human)" },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/auth/users/me"),
  },
  {
    name: "wafle_users_memberships_list",
    description:
      "List the current human's memberships across all tenants. Returns each tenant's slug, name, role, and effective scopes.",
    inputSchema: Empty,
    scopes: ["auth:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/memberships/me"),
  },
  {
    name: "wafle_users_switch_tenant",
    description:
      "Set the session's `current_tenant_id` so subsequent calls without an explicit `/stores/<slug>/` path apply to this tenant.\n\n" +
      "Returns the membership for the tenant. Errors with `wafle_users_no_membership` if the user is not a member.",
    inputSchema: z
      .object({
        tenant_id: z.number().int().describe("Numeric tenant id (CPT post id of the store)."),
      })
      .describe("Tenant to switch to."),
    scopes: ["auth:read"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>("/auth/users/me/switch-tenant", { tenant_id: input.tenant_id }),
  },
  {
    name: "wafle_invitations_create",
    description:
      "Invite a teammate to a tenant by email. Sends an invitation email with a magic link.\n\n" +
      "Requires the actor to be `owner` or `admin` of the target tenant.",
    inputSchema: z
      .object({
        email: z.string().email().describe("Email address of the invitee."),
        tenant_slug: z.string().optional().describe("Tenant slug, e.g. 'gamerland'."),
        tenant_id: z.number().int().optional().describe("Numeric tenant id (alternative to slug)."),
        role: z
          .enum(["viewer", "manager", "admin", "owner"])
          .describe("Role to grant on accept."),
      })
      .refine((v) => !!v.tenant_slug || !!v.tenant_id, {
        message: "Provide tenant_slug or tenant_id.",
      })
      .describe("Invitation parameters."),
    scopes: ["auth:read"],
    annotations: { destructiveHint: false, openWorldHint: false },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>("/memberships/invitations", input),
  },
  {
    name: "wafle_members_list",
    description:
      "List all members of a tenant — accepted memberships + pending invitations. Requires `owner` or `admin` role.",
    inputSchema: z
      .object({
        tenant_slug: z.string().describe("Tenant slug, e.g. 'gamerland'."),
      })
      .describe("Tenant filter."),
    scopes: ["auth:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(`/memberships/tenants/${encodeURIComponent(input.tenant_slug)}/members`),
  },
  {
    name: "wafle_members_update_role",
    description:
      "Update a member's role / scopes / is_active for a given tenant. Requires `owner` role on the tenant.",
    inputSchema: z
      .object({
        tenant_slug: z.string().describe("Tenant slug."),
        user_id: z.number().int().describe("User id of the member to update."),
        role: z.enum(["viewer", "manager", "admin", "owner"]).optional(),
        scopes: z.array(z.string()).optional().describe("Override the role's default scopes."),
        is_active: z.boolean().optional(),
      })
      .describe("Update parameters."),
    scopes: ["auth:read"],
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (input, ctx) => {
      const { tenant_slug, user_id, ...rest } = input;
      return ctx.client.patch<unknown>(
        `/memberships/tenants/${encodeURIComponent(tenant_slug)}/members/${user_id}`,
        rest,
      );
    },
  },
];
