import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { Pagination } from "../schemas/common.js";

export const systemTools: WafleTool[] = [
  {
    name: "wafle_system_health",
    description:
      "Health snapshot of the wafle backend: db / redis / upstream catalog / WooCommerce core. Returns latency per check.\n\n" +
      "Use as a cheap first call when something looks off in production.",
    inputSchema: z.object({}),
    scopes: ["system:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/health"),
  },
  {
    name: "wafle_system_stores_health",
    description:
      "Per-store health: products count, orders in last 24h, errors, gateway connectivity. Heavier than `wafle_system_health`.",
    inputSchema: z.object({}),
    scopes: ["system:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/health/stores"),
  },
  {
    name: "wafle_system_versions_list",
    description:
      "List the deployed versions of every wafle component (api, plugin, dashboard, themes). Use before deploying or rolling back.",
    inputSchema: z.object({}),
    scopes: ["system:admin"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/system/versions"),
  },
  {
    name: "wafle_system_release_deploy",
    description:
      "Deploy a specific version of a component. Server-side this kicks off the deploy pipeline.\n\n" +
      "DESTRUCTIVE — touches production. Confirm with the user, run `wafle_system_versions_list` first, and prefer a staging deploy if available.",
    inputSchema: z.object({
      component: z.string().min(2).describe("e.g. 'api', 'dashboard', 'plugin'."),
      version: z.string().min(1).describe("Version string, e.g. '0.1.5'."),
    }),
    scopes: ["system:admin"],
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (input, ctx) => ctx.client.post<unknown>("/system/deploy", input),
  },
  {
    name: "wafle_system_release_rollback",
    description:
      "Roll back a component to its previous deployed version. DESTRUCTIVE — confirm with the user.",
    inputSchema: z.object({
      component: z.string().min(2),
    }),
    scopes: ["system:admin"],
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (input, ctx) => ctx.client.post<unknown>("/system/rollback", input),
  },
  {
    name: "wafle_system_audit_query",
    description:
      "Query the audit log: who called what, when. Filter by store, actor type (master/store), endpoint, date range.\n\n" +
      "Use for forensics: 'who refunded order 87?', 'who toggled gateway 65 inactive?'.",
    inputSchema: z.object({
      page: Pagination.page,
      per_page: Pagination.per_page,
      store_id: z.number().int().positive().optional(),
      actor_type: z.enum(["master", "store", "system"]).optional(),
      endpoint: z.string().optional().describe("Substring match on the endpoint path."),
      from_ts: z.number().int().optional(),
      to_ts: z.number().int().optional(),
    }),
    scopes: ["system:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => ctx.client.get<unknown>("/audit", { query: input }),
  },
  {
    name: "wafle_system_queue_stats",
    description:
      "Get the current background-queue stats: pending/running/done/failed counts, throughput, lag.\n\n" +
      "Use to debug 'why didn't my sync finish?' or to spot a backlog.",
    inputSchema: z.object({}),
    scopes: ["system:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/system/queue/stats"),
  },
  {
    name: "wafle_system_queue_failed",
    description: "List failed queue jobs with their last error. Pair with `wafle_system_queue_retry`.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).default(50),
    }),
    scopes: ["system:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => ctx.client.get<unknown>("/system/queue/failed", { query: input }),
  },
  {
    name: "wafle_system_queue_retry",
    description:
      "Retry a failed queue job by id, or all failed jobs of a kind.",
    inputSchema: z.object({
      job_id: z.string().optional(),
      kind: z.string().optional().describe("If set, retries every failed job of this kind."),
    }).refine((v) => v.job_id || v.kind, {
      message: "Provide at least one of job_id, kind.",
    }),
    scopes: ["system:write"],
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (input, ctx) => ctx.client.post<unknown>("/system/queue/retry", input),
  },
];
