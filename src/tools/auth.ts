import { z } from "zod";
import type { WafleTool } from "./registry.js";

const Empty = z.object({}).describe("No parameters.");

export const authTools: WafleTool[] = [
  {
    name: "wafle_auth_me",
    description:
      "Return information about the wafle admin key currently configured for this MCP server.\n\n" +
      "Use this to verify the server is correctly authenticated before running other tools, or to debug a 401 error. The response is `{ ok: true, type: 'master' | 'store', store_slug?, scopes? }`.\n\n" +
      "Do NOT use this to authenticate end-user requests — wafle's REST has separate magic-link auth for storefront customers.",
    inputSchema: Empty,
    scopes: ["auth:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: who am I" },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/auth/me"),
  },
  {
    name: "wafle_auth_keys_list",
    description:
      "List API keys associated with the master account (or with a specific store, if the upstream key supports it).\n\n" +
      "Returns prefix + scopes for each key. Full secrets are NEVER returned by wafle. Use to audit who has access.\n\n" +
      "Admin-only: tenant clients cannot enumerate API keys.",
    inputSchema: z
      .object({
        store_slug: z.string().optional().describe("Optional: filter to keys scoped to this store."),
      })
      .describe("Filter options."),
    scopes: ["auth:read"],
    requiredMcpScope: "mcp:admin",
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(input.store_slug ? `/auth/keys?store=${encodeURIComponent(input.store_slug)}` : "/auth/keys"),
  },
  {
    name: "wafle_auth_keys_create",
    description:
      "Create a new wafle API key with the given scopes. Returns the secret ONCE — store it immediately.\n\n" +
      "Use when onboarding a new dashboard user, integration, or agent. Prefer narrowly-scoped keys.\n\n" +
      "If the wafle backend has not yet implemented `/auth/keys POST`, this tool returns the upstream error untouched.\n\n" +
      "Admin-only: tenant clients cannot mint API keys.",
    inputSchema: z
      .object({
        name: z.string().min(2).describe("Human-readable label, e.g. 'Vigía COO automation'."),
        scopes: z.array(z.string()).min(1).describe("Scopes to grant; see scope matrix in the readme."),
        store_slug: z.string().optional().describe("Optional: scope the key to a single store."),
        expires_at: z.number().int().optional().describe("Optional epoch seconds at which the key expires."),
      })
      .describe("Key creation parameters."),
    scopes: ["auth:read"],
    requiredMcpScope: "mcp:admin",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>("/auth/keys", {
        name: input.name,
        scopes: input.scopes,
        ...(input.store_slug !== undefined ? { store_slug: input.store_slug } : {}),
        ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
      }),
  },
];
