/**
 * "Meta" tools for the MCP server itself — not wafle business logic.
 *
 * - wafle_resources_invalidate: drop the resource cache (full or partial).
 * - wafle_prompts_list: same data as prompts/list, callable by LLMs whose
 *   client doesn't expose the Prompts API. Returns `{ name, description,
 *   arguments[] }` for each prompt.
 *
 * Plus long-running variants of existing wafle tools that should emit
 * progress notifications.
 */
import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";
import { makeMcpProgressEmitter, pollWithProgress } from "../utils/progress.js";
import { createPromptRegistry } from "../prompts/index.js";

// Prompt registry is stateless once built — singleton fine.
const PROMPT_REGISTRY_SINGLETON = createPromptRegistry();

export const metaTools: WafleTool[] = [
  {
    name: "wafle_resources_invalidate",
    description:
      "Invalidate the in-memory MCP resource cache. Pass `uri_pattern` to drop matching entries (substring match), or omit to flush everything.\n\n" +
      "Master only. Use after a destructive write (mutating products, settings) if you want the next `resources/read` to fetch fresh data.",
    inputSchema: z.object({
      uri_pattern: z.string().optional().describe("Substring of the resource URI to drop (e.g. 'gamerland'). Omit to flush all."),
    }),
    scopes: ["system:admin"],
    annotations: { destructiveHint: false, idempotentHint: true, title: "Wafle: invalidate resource cache" },
    handler: async (input, ctx) => {
      if (!ctx.resources) {
        return { ok: false, error: "no resource registry attached to this server build" };
      }
      const removed = ctx.resources.invalidate(input.uri_pattern);
      const stats = ctx.resources.cacheStats();
      return { ok: true, removed, remaining: stats.size, keys_remaining: stats.keys, pattern: input.uri_pattern ?? null };
    },
  },
  {
    name: "wafle_prompts_list",
    description:
      "List the server-defined prompts available on this MCP server. Returns name, description, and argument schema for each. Useful for clients that don't surface the prompts/list MCP method.",
    inputSchema: z.object({}),
    scopes: [],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async () => ({ count: PROMPT_REGISTRY_SINGLETON.size(), prompts: PROMPT_REGISTRY_SINGLETON.list() }),
  },
  {
    name: "wafle_products_sync_trigger_and_wait",
    description:
      "Trigger a catalog sync AND wait until it finishes (or 5min timeout). Emits MCP progress notifications during the wait — clients that support progress (Claude Desktop) show a live bar.\n\n" +
      "Use when the LLM wants to take an action *after* the sync is done. For fire-and-forget, use `wafle_products_sync_trigger` (returns immediately).",
    inputSchema: z.object({
      slug: StoreSlug,
      mode: z.enum(["incremental", "full"]).default("incremental"),
      timeout_seconds: z.number().int().min(30).max(900).default(300).describe("Hard timeout in seconds (30-900). Default 300 (5 min)."),
    }),
    scopes: ["products:admin"],
    annotations: { destructiveHint: false, idempotentHint: false, title: "Wafle: sync products + wait" },
    handler: async (input, ctx) => {
      const triggerResp = await ctx.client.post<{ job_id?: string; id?: string; mode?: string }>(
        `/stores/${encodeURIComponent(input.slug)}/products/sync`,
        { mode: input.mode },
      );
      const jobId = triggerResp.job_id ?? triggerResp.id;
      if (!jobId) {
        return { ok: false, error: "wafle did not return a job id", trigger_response: triggerResp };
      }
      const onProgress = makeMcpProgressEmitter(
        ctx.extras?.sendNotification,
        ctx.extras?.progressToken,
      );
      const opts: Parameters<typeof pollWithProgress>[1] = {
        statusPath: `/system/queue/job/${encodeURIComponent(jobId)}`,
        intervalMs: 2_000,
        timeoutMs: input.timeout_seconds * 1_000,
        initialMessage: `sync ${input.mode} started (job ${jobId})`,
      };
      if (onProgress) opts.onProgress = onProgress;
      const result = await pollWithProgress(ctx.client, opts);
      // Best-effort cache invalidation after a successful sync.
      if (result.terminal && !["failed", "error", "cancelled", "canceled"].includes(result.status) && ctx.resources) {
        ctx.resources.invalidate(input.slug);
      }
      return {
        ok: result.terminal && !["failed", "error", "cancelled", "canceled"].includes(result.status),
        job_id: jobId,
        terminal: result.terminal,
        status: result.status,
        polls: result.polls,
        timed_out: result.timedOut,
        result: result.raw,
      };
    },
  },
  {
    name: "wafle_csv_import",
    description:
      "Import a CSV product feed into a store with `catalog_mode=csv`. Long-running. Emits progress notifications during the import (rows processed / total).\n\n" +
      "Returns the final import summary: imported, updated, errors, duration.",
    inputSchema: z.object({
      slug: StoreSlug,
      csv_url: z.string().url().describe("Public HTTPS URL of the CSV (Google Drive direct, S3 signed, etc.)."),
      mapping: z
        .record(z.string())
        .optional()
        .describe("Optional column mapping. Default expects 'sku', 'name', 'price', 'stock', 'image', 'description' columns."),
      timeout_seconds: z.number().int().min(30).max(900).default(300),
    }),
    scopes: ["products:admin"],
    annotations: { destructiveHint: false, idempotentHint: false, title: "Wafle: import CSV (long-running)" },
    handler: async (input, ctx) => {
      const triggerResp = await ctx.client.post<{ run_id?: string; id?: string; job_id?: string }>(
        `/stores/${encodeURIComponent(input.slug)}/csv/import`,
        {
          url: input.csv_url,
          ...(input.mapping ? { mapping: input.mapping } : {}),
        },
      );
      const jobId = triggerResp.run_id ?? triggerResp.job_id ?? triggerResp.id;
      if (!jobId) {
        return { ok: false, error: "wafle did not return a job/run id for CSV import", trigger_response: triggerResp };
      }
      const onProgress = makeMcpProgressEmitter(
        ctx.extras?.sendNotification,
        ctx.extras?.progressToken,
      );
      const opts: Parameters<typeof pollWithProgress>[1] = {
        statusPath: `/system/queue/job/${encodeURIComponent(jobId)}`,
        intervalMs: 2_000,
        timeoutMs: input.timeout_seconds * 1_000,
        initialMessage: `csv import started (job ${jobId})`,
      };
      if (onProgress) opts.onProgress = onProgress;
      const result = await pollWithProgress(ctx.client, opts);
      if (result.terminal && !["failed", "error", "cancelled", "canceled"].includes(result.status) && ctx.resources) {
        ctx.resources.invalidate(input.slug);
      }
      return {
        ok: result.terminal && !["failed", "error", "cancelled", "canceled"].includes(result.status),
        job_id: jobId,
        terminal: result.terminal,
        status: result.status,
        polls: result.polls,
        timed_out: result.timedOut,
        result: result.raw,
      };
    },
  },
  {
    name: "wafle_ads_sync_full",
    description:
      "Run a full ads-platform catalog sync (Meta Catalog API or equivalent) AND wait until it finishes. Emits progress notifications.\n\n" +
      "Long-running (5+ minutes for large catalogs). For fire-and-forget, call the underlying create endpoint directly.",
    inputSchema: z.object({
      connection_id: z.number().int().positive(),
      filters: z
        .record(z.unknown())
        .optional()
        .describe("Optional filters (e.g. `{ in_stock: true }`)."),
      timeout_seconds: z.number().int().min(30).max(900).default(600),
    }),
    scopes: ["analytics:read", "products:admin"],
    annotations: { destructiveHint: false, idempotentHint: false, title: "Wafle: ads sync full (long-running)" },
    handler: async (input, ctx) => {
      const triggerResp = await ctx.client.post<{ sync_id?: string | number; id?: string | number; job_id?: string | number }>(
        `/ads/connections/${input.connection_id}/sync`,
        {
          mode: "full",
          ...(input.filters ? { filters: input.filters } : {}),
        },
      );
      const jobId = String(triggerResp.sync_id ?? triggerResp.job_id ?? triggerResp.id ?? "");
      if (!jobId) {
        return { ok: false, error: "wafle did not return a sync id", trigger_response: triggerResp };
      }
      const onProgress = makeMcpProgressEmitter(
        ctx.extras?.sendNotification,
        ctx.extras?.progressToken,
      );
      const opts: Parameters<typeof pollWithProgress>[1] = {
        statusPath: `/ads/syncs/${encodeURIComponent(jobId)}`,
        intervalMs: 3_000,
        timeoutMs: input.timeout_seconds * 1_000,
        initialMessage: `ads sync started (id ${jobId})`,
      };
      if (onProgress) opts.onProgress = onProgress;
      const result = await pollWithProgress(ctx.client, opts);
      return {
        ok: result.terminal && !["failed", "error", "cancelled", "canceled"].includes(result.status),
        sync_id: jobId,
        terminal: result.terminal,
        status: result.status,
        polls: result.polls,
        timed_out: result.timedOut,
        result: result.raw,
      };
    },
  },
];
