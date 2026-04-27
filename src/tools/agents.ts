/**
 * AI Agents Builder tools — wrappers around `/wafle/v1/stores/:slug/agents/*`.
 *
 * Lets Claude (or any MCP client) build, run, and inspect tenant agents.
 * Each agent has its own `system_prompt + tools_allowed + guardrails`, so
 * these MCP tools are the meta-layer: tools that create tools.
 */
import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug, Pagination } from "../schemas/common.js";

const AgentSlug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9\-_]+$/i)
  .describe("Agent slug, unique within the store. Lowercase letters, digits, dash, underscore.");

const TriggerType = z.enum(["manual", "event", "schedule", "webhook"]);

const Guardrails = z
  .object({
    require_approval_for: z.array(z.string()).optional(),
    require_approval_for_all_destructive: z.boolean().optional(),
    max_cost_per_run_cents: z.number().int().min(1).max(5000).optional(),
  })
  .partial()
  .describe(
    "Safety knobs: explicit approval list, all-destructive auto-approve gate, max-cost-per-run cap.",
  );

const TriggerConfig = z.record(z.unknown()).optional()
  .describe("Trigger config: { event:'order.created' } | { cron:'0 3 * * *' } | { webhook_token:'...' }.");

export const agentsTools: WafleTool[] = [
  {
    name: "wafle_agents_list",
    description:
      "List custom agents defined for a store. Each agent has system_prompt + tools whitelist + guardrails + trigger. Filter by status (draft/active/paused/archived) or trigger_type.",
    inputSchema: z.object({
      slug: StoreSlug,
      status: z.enum(["draft", "active", "paused", "archived"]).optional(),
      trigger_type: TriggerType.optional(),
    }),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, status, trigger_type } = input;
      const query: Record<string, string> = {};
      if (status) query.status = status;
      if (trigger_type) query.trigger_type = trigger_type;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/agents`, { query });
    },
  },
  {
    name: "wafle_agents_get",
    description:
      "Get one agent by its slug — full definition including system_prompt, tools_allowed, guardrails, trigger_config and stats counters.",
    inputSchema: z.object({ slug: StoreSlug, agent_slug: AgentSlug }),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agents/${encodeURIComponent(input.agent_slug)}`,
      ),
  },
  {
    name: "wafle_agents_create",
    description:
      "Create a new custom agent. Two paths:\n\n" +
      "  1) `from_template` — clone one of the 5 pre-armed templates (customer-support-bot, content-writer-nightly, stock-watcher, abandoned-recovery, fraud-detector). Override `slug`/`name` if needed.\n\n" +
      "  2) From scratch — supply `name`, `system_prompt`, `tools_allowed`, `guardrails`, `trigger_type` (+ trigger_config). Use `wafle_agents_tool_catalog` first to see what tools exist.\n\n" +
      "Cost guardrail (`max_cost_per_run_cents`) is hard-capped at 5000 (USD 50). Max turns is hard-capped at 50.",
    inputSchema: z.object({
      slug: StoreSlug,
      from_template: z
        .enum([
          "customer-support-bot",
          "content-writer-nightly",
          "stock-watcher",
          "abandoned-recovery",
          "fraud-detector",
        ])
        .optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      model: z.string().optional(),
      system_prompt: z.string().optional(),
      tools_allowed: z.array(z.string()).optional(),
      tools_disallowed: z.array(z.string()).optional(),
      max_turns: z.number().int().min(1).max(50).optional(),
      temperature: z.number().min(0).max(1.5).optional(),
      guardrails: Guardrails.optional(),
      trigger_type: TriggerType.optional(),
      trigger_config: TriggerConfig,
    }),
    scopes: ["agents:write"],
    annotations: {},
    handler: async (input, ctx) => {
      const { slug, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/agents`, body);
    },
  },
  {
    name: "wafle_agents_update",
    description:
      "Patch an existing agent — change system_prompt, tools_allowed, guardrails, trigger_config, model, status, etc. Slug + tenant_id are immutable.",
    inputSchema: z.object({
      slug: StoreSlug,
      agent_slug: AgentSlug,
      patch: z
        .object({
          name: z.string().optional(),
          description: z.string().optional(),
          model: z.string().optional(),
          system_prompt: z.string().optional(),
          tools_allowed: z.array(z.string()).optional(),
          tools_disallowed: z.array(z.string()).optional(),
          max_turns: z.number().int().min(1).max(50).optional(),
          temperature: z.number().min(0).max(1.5).optional(),
          guardrails: Guardrails.optional(),
          trigger_type: TriggerType.optional(),
          trigger_config: TriggerConfig,
        })
        .passthrough(),
    }),
    scopes: ["agents:write"],
    annotations: {},
    handler: async (input, ctx) =>
      ctx.client.patch<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agents/${encodeURIComponent(input.agent_slug)}`,
        input.patch,
      ),
  },
  {
    name: "wafle_agents_activate",
    description:
      "Activate an agent — moves status to `active`, which makes it eligible for scheduled/event triggers. No-op if already active.",
    inputSchema: z.object({ slug: StoreSlug, agent_slug: AgentSlug }),
    scopes: ["agents:write"],
    annotations: {},
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agents/${encodeURIComponent(input.agent_slug)}/activate`,
        {},
      ),
  },
  {
    name: "wafle_agents_pause",
    description: "Pause an active agent. Triggers stop firing; existing runs unaffected.",
    inputSchema: z.object({ slug: StoreSlug, agent_slug: AgentSlug }),
    scopes: ["agents:write"],
    annotations: {},
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agents/${encodeURIComponent(input.agent_slug)}/pause`,
        {},
      ),
  },
  {
    name: "wafle_agents_run",
    description:
      "Manually dispatch a run for an agent. Returns the `run_id` and the synchronous run row (ends in status=done|failed|awaiting_approval). Use `wafle_agents_runs_get` to poll.",
    inputSchema: z.object({
      slug: StoreSlug,
      agent_slug: AgentSlug,
      input: z.string().min(1).describe("User message text fed to the agent's first turn."),
      context: z.record(z.unknown()).optional().describe("Extra context attached as trigger_payload."),
    }),
    scopes: ["agents:write"],
    annotations: {},
    handler: async (input, ctx) => {
      const { slug, agent_slug, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agent_slug)}/run`,
        body,
      );
    },
  },
  {
    name: "wafle_agents_runs_list",
    description:
      "List runs for an agent — paginated, filterable by status. Each row: status, tokens, cost_cents, duration_ms.",
    inputSchema: z.object({
      slug: StoreSlug,
      agent_slug: AgentSlug,
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(25),
      status: z
        .enum(["queued", "running", "done", "failed", "cancelled", "awaiting_approval"])
        .optional(),
    }),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true },
    handler: async (input, ctx) => {
      const { slug, agent_slug, page, per_page, status } = input;
      const query: Record<string, string | number> = { page, per_page };
      if (status) query.status = status;
      return ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(slug)}/agents/${encodeURIComponent(agent_slug)}/runs`,
        { query },
      );
    },
  },
  {
    name: "wafle_agents_runs_get",
    description:
      "Get a specific run with its full conversation + audit log (steps: user_input, assistant_text, tool_call, tool_result, approval_request, approval_granted, error).",
    inputSchema: z.object({
      slug: StoreSlug,
      run_id: z.number().int().positive(),
    }),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agent-runs/${input.run_id}`,
      ),
  },
  {
    name: "wafle_agents_runs_approve",
    description:
      "Approve a run that is `awaiting_approval`. Resumes execution from the pending tool call. Optional `note` saved to the audit log.",
    inputSchema: z.object({
      slug: StoreSlug,
      run_id: z.number().int().positive(),
      note: z.string().optional(),
    }),
    scopes: ["agents:write"],
    annotations: { destructiveHint: true },
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agent-runs/${input.run_id}/approve`,
        { note: input.note },
      ),
  },
  {
    name: "wafle_agents_runs_reject",
    description:
      "Reject a run that is `awaiting_approval`. Run goes to `cancelled`; the pending tool call is NOT executed.",
    inputSchema: z.object({
      slug: StoreSlug,
      run_id: z.number().int().positive(),
      note: z.string().optional(),
    }),
    scopes: ["agents:write"],
    annotations: {},
    handler: async (input, ctx) =>
      ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agent-runs/${input.run_id}/reject`,
        { note: input.note },
      ),
  },
  {
    name: "wafle_agents_templates",
    description:
      "List the 5 pre-armed agent templates: customer-support-bot, content-writer-nightly, stock-watcher, abandoned-recovery, fraud-detector. Use the `id` field as `from_template` in `wafle_agents_create`.",
    inputSchema: z.object({}),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/agents/templates"),
  },
  {
    name: "wafle_agents_tool_catalog",
    description:
      "List the catalog of tools that can be added to an agent's `tools_allowed`. Each entry: name, description, scope required, destructive flag, JSON Schema for input.",
    inputSchema: z.object({}),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (_input, ctx) => ctx.client.get<unknown>("/agents/tool-catalog"),
  },
  {
    name: "wafle_agents_stats",
    description:
      "Aggregated stats for an agent: total runs, success rate, total cost, top tool names called.",
    inputSchema: z.object({ slug: StoreSlug, agent_slug: AgentSlug }),
    scopes: ["agents:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) =>
      ctx.client.get<unknown>(
        `/stores/${encodeURIComponent(input.slug)}/agents/${encodeURIComponent(input.agent_slug)}/stats`,
      ),
  },
];
