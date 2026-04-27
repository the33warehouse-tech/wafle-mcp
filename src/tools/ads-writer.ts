/**
 * Ads writer + recommender + anomaly tools.
 *
 * Thin wrappers around `/wafle/v1/stores/:slug/ads/*` writer surface introduced
 * in waffle-core ads/v0.2.0. Eight tools covering:
 *
 *   - wafle_ads_campaign_pause / resume / update_budget
 *   - wafle_ads_bulk_pause
 *   - wafle_ads_recommendations_list / apply
 *   - wafle_ads_anomalies_list
 *   - wafle_ads_performance_summary
 *
 * The descriptions are intentionally rich so an LLM picking among tools can
 * reason about *which* data source backs each one (Meta API direct vs wafle
 * cross-tab vs CAPI server-side truth).
 */
import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";

const MetaCampaignId = z
  .string()
  .min(1)
  .describe("Meta Marketing API campaign id (e.g. '23859000123456789').");

const MetaAdsetId = z
  .string()
  .min(1)
  .describe("Meta Marketing API ad set id.");

export const adsWriterTools: WafleTool[] = [
  {
    name: "wafle_ads_campaign_pause",
    description:
      "Pause a Meta Ads campaign by id. Idempotent — pausing an already-paused campaign returns ok=true. Uses the tenant's connected Meta access token; the LLM does not need to pass credentials.\n\n" +
      "Use when ROAS is below threshold or as the apply step of a pause-recommendation. For multi-campaign pauses, prefer `wafle_ads_bulk_pause` to avoid round-trip cost.",
    inputSchema: z.object({
      slug: StoreSlug,
      campaign_id: MetaCampaignId,
    }),
    scopes: ["ads:write"],
    annotations: { destructiveHint: true, idempotentHint: true, title: "Wafle: pause Meta campaign" },
    handler: async (input, ctx) => {
      const { slug, campaign_id } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ads/campaigns/${encodeURIComponent(campaign_id)}/pause`,
        {},
      );
    },
  },
  {
    name: "wafle_ads_campaign_resume",
    description:
      "Resume a paused Meta Ads campaign by id. Sets status to ACTIVE. Idempotent for already-active campaigns.\n\n" +
      "Note: campaigns paused for 14+ days lose their Learning Phase signal — Meta will re-enter Learning when you resume them.",
    inputSchema: z.object({
      slug: StoreSlug,
      campaign_id: MetaCampaignId,
    }),
    scopes: ["ads:write"],
    annotations: { destructiveHint: false, idempotentHint: true, title: "Wafle: resume Meta campaign" },
    handler: async (input, ctx) => {
      const { slug, campaign_id } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ads/campaigns/${encodeURIComponent(campaign_id)}/resume`,
        {},
      );
    },
  },
  {
    name: "wafle_ads_campaign_update_budget",
    description:
      "Update a Meta campaign's budget. Pass `daily_budget_cents` (preferred) or `lifetime_budget_cents` — the two are mutually exclusive in the Marketing API.\n\n" +
      "Cents are in the ad account currency. The recommender follows a +30% / max +50% rule when scaling winners; if you call this directly, mirror that constraint to avoid blowing the Learning Phase.",
    inputSchema: z.object({
      slug: StoreSlug,
      campaign_id: MetaCampaignId,
      daily_budget_cents: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Daily budget in cents."),
      lifetime_budget_cents: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Lifetime budget in cents (mutually exclusive with daily)."),
    }),
    scopes: ["ads:write"],
    annotations: { destructiveHint: true, idempotentHint: false, title: "Wafle: update Meta campaign budget" },
    handler: async (input, ctx) => {
      const { slug, campaign_id, ...body } = input;
      if (!body.daily_budget_cents && !body.lifetime_budget_cents) {
        return { ok: false, errors: ["must pass daily_budget_cents or lifetime_budget_cents"] };
      }
      return ctx.client.patch<unknown>(
        `/stores/${encodeURIComponent(slug)}/ads/campaigns/${encodeURIComponent(campaign_id)}/budget`,
        body,
      );
    },
  },
  {
    name: "wafle_ads_bulk_pause",
    description:
      "Pause many Meta campaigns in a single tool call. Returns per-id success/failure so partial successes are visible.\n\n" +
      "Best for ROAS-floor sweeps (\"pause everything below 1.5x last 7d\") and seasonal cleanup. The wafle backend serializes the underlying Marketing API requests with a 1 RPS throttle to stay below Meta's per-app rate limit.",
    inputSchema: z.object({
      slug: StoreSlug,
      campaign_ids: z.array(z.string().min(1)).min(1).max(50).describe("Up to 50 Meta campaign ids."),
    }),
    scopes: ["ads:write"],
    annotations: { destructiveHint: true, idempotentHint: true, title: "Wafle: bulk pause Meta campaigns" },
    handler: async (input, ctx) => {
      const { slug, campaign_ids } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ads/campaigns/bulk-pause`,
        { campaign_ids },
      );
    },
  },
  {
    name: "wafle_ads_recommendations_list",
    description:
      "List ads recommendations generated by wafle's AI engine. Recommendations cross-tab the Meta API spend with the *server-side truth* (wafle CAPI orders + revenue), so CPA/ROAS reflect what actually happened — not Meta's own attribution.\n\n" +
      "Each card has: title, description, action (the actual writer call to apply it), confidence (0..1), expected_impact, severity. Apply with `wafle_ads_recommendation_apply`.",
    inputSchema: z.object({
      slug: StoreSlug,
      status: z.enum(["pending", "applied", "dismissed", "expired"]).optional().describe("Default: pending non-expired."),
      severity: z.enum(["info", "warning", "critical"]).optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(25),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: list ads recommendations" },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/ads/recommendations`, { query });
    },
  },
  {
    name: "wafle_ads_recommendation_apply",
    description:
      "Apply a wafle ads recommendation by id — runs the underlying writer action (pause campaign, raise budget, etc.) and marks the recommendation applied. Idempotent: re-applying returns the previous result.\n\n" +
      "If the action requires human judgment (request_human_review, generate_creative_variants), the call queues the work and returns ok=true with `queued: true`.",
    inputSchema: z.object({
      slug: StoreSlug,
      recommendation_id: z.number().int().positive(),
    }),
    scopes: ["ads:write"],
    annotations: { destructiveHint: true, idempotentHint: true, title: "Wafle: apply ads recommendation" },
    handler: async (input, ctx) => {
      const { slug, recommendation_id } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ads/recommendations/${recommendation_id}/apply`,
        {},
      );
    },
  },
  {
    name: "wafle_ads_anomalies_list",
    description:
      "List ads anomalies detected by the cron-driven detector (runs every 30 minutes). Each anomaly includes kind (cpa_spike, roas_break, conversion_drop, spend_overrun, learning_limited_stuck, tracking_drift), severity, scope, and the metrics that triggered it.\n\n" +
      "Anomalies fire admin-inbox notifications (warning+) and push notifications (critical only) with a 6h cooldown per (kind, scope_id) pair. Use this tool to read raw history.",
    inputSchema: z.object({
      slug: StoreSlug,
      kind: z.string().optional().describe("Filter by anomaly kind."),
      severity: z.enum(["info", "warning", "critical"]).optional(),
      since: z.string().optional().describe("ISO 8601 lower bound on created_at."),
      acknowledged: z.boolean().optional(),
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(50),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: list ads anomalies" },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/ads/anomalies`, { query });
    },
  },
  {
    name: "wafle_ads_performance_summary",
    description:
      "Account-level cross-tabbed performance — joins Meta Marketing API spend/impressions/clicks with wafle CAPI orders/revenue.\n\n" +
      "Each campaign returns: spend, meta_reported_orders (from pixel), wafle_orders (server-side truth), cpa_real_cents (spend / wafle_orders), roas_real, learning_phase, plus a prev_period block for trend analysis. Use this as the input to any optimization decision — it's what the recommender feeds the LLM.",
    inputSchema: z.object({
      slug: StoreSlug,
      days: z.number().int().min(1).max(90).default(7).describe("Window in days, max 90."),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: ads performance summary" },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/ads/summary`, { query });
    },
  },
];
