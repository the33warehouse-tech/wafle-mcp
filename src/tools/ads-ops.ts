/**
 * Deep ads ops tools — six analyst-grade tools for managing merchant ad accounts.
 *
 * These wrap (or are *intended* to wrap) wafle backend endpoints that cross-tab
 * Meta Marketing API spend with wafle CAPI server-side truth. They give the LLM
 * the same view a marketing analyst would use:
 *
 *   - wafle_ads_breakdown_by_creative          (creative-level performance)
 *   - wafle_ads_propose_pause_underperformers  (read-only proposer; never auto-pauses)
 *   - wafle_ads_audience_overlap_check         (audience cannibalization detector)
 *   - wafle_ads_creative_performance_log       (per-creative timeseries history)
 *   - wafle_ads_generate_report_monthly        (executive monthly snapshot)
 *   - wafle_ads_compare_periods                (period-over-period deltas)
 *
 * Backend status (2026-05-06):
 *   - `/stores/:slug/marketing/profit?range=...` — EXISTS in wafle-core, used by
 *     `wafle_ads_compare_periods` and `wafle_ads_generate_report_monthly`.
 *   - `/stores/:slug/ads/summary` — EXISTS (consumed by `wafle_ads_performance_summary`).
 *   - The rest of the endpoints below are NOT YET IMPLEMENTED in wafle-core. The
 *     handlers attempt the real call first and, on 404 / not-found, fall back to
 *     a clearly-labelled `mock: true` response so an LLM (and the human
 *     reviewing the output) knows it is mocked. The shape mirrors what the
 *     production endpoint will return so swapping in the real call is a
 *     one-line change inside each handler — search for `MOCK_FALLBACK`.
 *
 * Conventions:
 *   - All money in cents, ad-account currency.
 *   - All ROAS as multiples (1.5 == 150%).
 *   - All dates ISO 8601 (`YYYY-MM-DD` for day-grain, full timestamp for
 *     event-grain).
 *   - Tools NEVER mutate. Mutations live in `ads-writer.ts`.
 */
import { z } from "zod";
import type { WafleTool, ToolContext } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";
import { WafleApiError } from "../client/errors.js";

const RangeShortcut = z
  .enum(["1d", "7d", "14d", "28d", "30d", "90d"])
  .describe("Lookback shortcut. Aligned with the merchant's tz, ending today.");

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe("ISO date (YYYY-MM-DD) in the merchant's timezone.");

const IsoMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM")
  .describe("ISO month (YYYY-MM), e.g. '2026-04'.");

/**
 * Try a real wafle endpoint; if the backend doesn't have it yet (404 / 501 /
 * "endpoint not implemented" message), return the supplied mock with
 * `mock: true` and an explanatory `mock_reason`. Any other error propagates so
 * the LLM sees genuine failures.
 */
async function realOrMock<T extends Record<string, unknown>>(
  ctx: ToolContext,
  realCall: () => Promise<unknown>,
  mockBuilder: () => T,
): Promise<T | Record<string, unknown>> {
  try {
    const result = await realCall();
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, unknown>;
    }
    return { value: result } as Record<string, unknown>;
  } catch (err) {
    if (err instanceof WafleApiError && (err.status === 404 || err.status === 501)) {
      ctx.log.warn(
        { kind: "mock_fallback", status: err.status },
        "ads-ops endpoint not implemented yet, returning mock",
      );
      return {
        ...mockBuilder(),
        mock: true,
        mock_reason: `wafle backend returned ${err.status}; endpoint not implemented yet (TODO: replace MOCK_FALLBACK)`,
      };
    }
    throw err;
  }
}

export const adsOpsTools: WafleTool[] = [
  // ────────────────────────────────────────────────────────────────────────
  // 1. Creative-level breakdown
  // ────────────────────────────────────────────────────────────────────────
  {
    name: "wafle_ads_breakdown_by_creative",
    description:
      "Per-creative performance breakdown for a campaign (or whole account if `campaign_id` omitted). " +
      "Returns spend, impressions, clicks, conversions, ROAS and CPA for every creative_id active in the window. " +
      "Cross-tabbed against wafle CAPI orders, so ROAS reflects server-side truth, not Meta's pixel.\n\n" +
      "Use when you need to find the *one* creative carrying a campaign vs the ones bleeding spend. " +
      "Sort defaults to spend desc; a `winner` flag tags creatives whose ROAS is in the top quartile " +
      "AND spend is above the per-creative significance floor (default 5,000 cents).",
    inputSchema: z.object({
      slug: StoreSlug,
      campaign_id: z.string().min(1).optional().describe("Optional Meta campaign id; omit for account-wide."),
      range: RangeShortcut.default("7d"),
      min_spend_cents: z
        .number()
        .int()
        .nonnegative()
        .default(5_000)
        .describe("Hide creatives with cumulative spend below this — avoids LLM noise on pre-launch creatives."),
      sort: z.enum(["spend_desc", "roas_desc", "cpa_asc"]).default("spend_desc"),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: ads breakdown by creative" },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return realOrMock(
        ctx,
        () =>
          ctx.client.get(
            `/stores/${encodeURIComponent(slug)}/ads/breakdown/creative`,
            { query: query as Record<string, string | number> },
          ),
        () => ({
          slug,
          range: query.range,
          campaign_id: query.campaign_id ?? null,
          generated_at: new Date().toISOString(),
          creatives: [
            {
              creative_id: "120201234567890001",
              name: "VID_carousel_skincare_v3",
              spend_cents: 85_000,
              impressions: 142_300,
              clicks: 4_120,
              conversions: 38,
              revenue_cents: 215_000,
              roas: 2.53,
              cpa_cents: 2_237,
              winner: true,
            },
            {
              creative_id: "120201234567890002",
              name: "STC_offer_30off",
              spend_cents: 64_000,
              impressions: 110_700,
              clicks: 2_180,
              conversions: 12,
              revenue_cents: 49_000,
              roas: 0.77,
              cpa_cents: 5_333,
              winner: false,
            },
          ],
        }),
      );
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // 2. Propose pauses (read-only — never executes)
  // ────────────────────────────────────────────────────────────────────────
  {
    name: "wafle_ads_propose_pause_underperformers",
    description:
      "READ-ONLY proposer: returns a list of adsets with ROAS below `threshold_roas` AND spend above " +
      "`min_spend_cents` over `range`. Each item carries a `recommendation` ∈ {pause, reduce_budget, keep} " +
      "based on (a) how far below threshold, (b) Learning Phase status, (c) trend vs previous period.\n\n" +
      "This tool NEVER mutates. To execute, the caller must explicitly call `wafle_ads_campaign_pause`, " +
      "`wafle_ads_bulk_pause`, or `wafle_ads_campaign_update_budget` with the ids returned here. The output " +
      "is shaped to be pasted back into a follow-up tool call by the LLM.",
    inputSchema: z.object({
      slug: StoreSlug,
      range: RangeShortcut.default("7d"),
      threshold_roas: z
        .number()
        .positive()
        .default(1.5)
        .describe("Minimum acceptable ROAS multiple; adsets below are flagged."),
      min_spend_cents: z
        .number()
        .int()
        .nonnegative()
        .default(5_000)
        .describe("Floor — ignore adsets that haven't spent enough to draw a conclusion."),
      campaign_id: z.string().min(1).optional().describe("Optional: only propose within this campaign."),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: propose ads pauses" },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return realOrMock(
        ctx,
        () =>
          ctx.client.get(
            `/stores/${encodeURIComponent(slug)}/ads/propose/pause-underperformers`,
            { query: query as Record<string, string | number> },
          ),
        () => ({
          slug,
          range: query.range,
          threshold_roas: query.threshold_roas,
          min_spend_cents: query.min_spend_cents,
          generated_at: new Date().toISOString(),
          proposals: [
            {
              campaign_id: "23859000111111111",
              campaign_name: "PROSP-CO-skincare-broad",
              adset_id: "23859000222222222",
              adset_name: "AS_25-45_AR_LAL3pct_seedpurchasers",
              current_status: "ACTIVE",
              spend_cents: 42_000,
              roas: 0.62,
              cpa_cents: 6_700,
              learning_phase: "limited_learning",
              vs_prev_period_pct: -38.4,
              recommendation: "pause",
              reason: "ROAS 0.62x < threshold 1.5x, spend $420 above floor, prev period ROAS was 1.1x (-38%)",
            },
            {
              campaign_id: "23859000333333333",
              campaign_name: "RTG-AR-cart-abandoners-7d",
              adset_id: "23859000444444444",
              adset_name: "AS_cart7d_excl_purchasers",
              current_status: "ACTIVE",
              spend_cents: 18_500,
              roas: 1.21,
              cpa_cents: 4_500,
              learning_phase: "active",
              vs_prev_period_pct: -8.0,
              recommendation: "reduce_budget",
              reason: "ROAS 1.21x below threshold but trend stable; suggest -30% daily budget vs pause",
            },
          ],
          summary: {
            count_pause: 1,
            count_reduce_budget: 1,
            count_keep: 0,
            total_spend_at_risk_cents: 60_500,
          },
        }),
      );
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // 3. Audience overlap
  // ────────────────────────────────────────────────────────────────────────
  {
    name: "wafle_ads_audience_overlap_check",
    description:
      "Compute % overlap between custom audiences in the connected ad account. " +
      "Returns a matrix (audience_a × audience_b → overlap_pct + overlap_users). " +
      "Use this when the merchant runs many similar adsets — high overlap (>40%) typically means " +
      "they're bidding against themselves and inflating CPM. Pass specific `audience_ids` to limit " +
      "the matrix or omit to compare all audiences with > `min_size` users.\n\n" +
      "Note: Meta's overlap API is sampled (it builds the matrix once a day), so values may be a few " +
      "hours stale. The wafle backend caches results for 6 hours per (slug, audience_set) tuple.",
    inputSchema: z.object({
      slug: StoreSlug,
      audience_ids: z
        .array(z.string().min(1))
        .min(2)
        .max(20)
        .optional()
        .describe("Specific audiences to compare; omit to auto-pick those above min_size."),
      min_size: z
        .number()
        .int()
        .positive()
        .default(1_000)
        .describe("When auto-picking, only include audiences with at least this many users."),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: audience overlap matrix" },
    handler: async (input, ctx) => {
      const { slug, ...query } = input;
      return realOrMock(
        ctx,
        () =>
          ctx.client.get(
            `/stores/${encodeURIComponent(slug)}/ads/audiences/overlap`,
            {
              query: {
                ...(query.audience_ids ? { audience_ids: query.audience_ids } : {}),
                min_size: query.min_size,
              },
            },
          ),
        () => ({
          slug,
          generated_at: new Date().toISOString(),
          audiences: [
            { id: "12000111", name: "AR_purchasers_180d", size: 24_500 },
            { id: "12000222", name: "AR_LAL_3pct_purchasers", size: 1_200_000 },
            { id: "12000333", name: "AR_addtocart_30d", size: 18_900 },
          ],
          overlaps: [
            { audience_a: "12000111", audience_b: "12000222", overlap_pct: 8.4, overlap_users: 2_058 },
            { audience_a: "12000111", audience_b: "12000333", overlap_pct: 51.2, overlap_users: 12_544 },
            { audience_a: "12000222", audience_b: "12000333", overlap_pct: 1.1, overlap_users: 13_200 },
          ],
          warnings: [
            {
              kind: "high_overlap",
              audience_a: "12000111",
              audience_b: "12000333",
              overlap_pct: 51.2,
              note: "purchasers_180d ⊂ addtocart_30d; exclude purchasers from cart RTG to avoid self-bidding",
            },
          ],
        }),
      );
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // 4. Creative performance log (timeseries)
  // ────────────────────────────────────────────────────────────────────────
  {
    name: "wafle_ads_creative_performance_log",
    description:
      "Daily timeseries for a single creative_id since `since`. Each row: spend, impressions, clicks, " +
      "conversions, revenue, roas, frequency, ctr, cpm.\n\n" +
      "Use to detect (a) Learning Phase exit, (b) creative fatigue (frequency rising + CTR falling), " +
      "(c) the right scale moment (3+ days of stable ROAS above target). The response also includes " +
      "`fatigue_score` (0..1, higher = more fatigued) and `phase` ∈ {learning, active, fatigued, off}.",
    inputSchema: z.object({
      slug: StoreSlug,
      creative_id: z.string().min(1).describe("Meta creative id."),
      since: IsoDate.describe("Inclusive lower bound on the day."),
      until: IsoDate.optional().describe("Inclusive upper bound; defaults to today."),
    }),
    scopes: ["ads:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: creative performance log" },
    handler: async (input, ctx) => {
      const { slug, creative_id, ...query } = input;
      return realOrMock(
        ctx,
        () =>
          ctx.client.get(
            `/stores/${encodeURIComponent(slug)}/ads/creatives/${encodeURIComponent(creative_id)}/log`,
            { query: query as Record<string, string> },
          ),
        () => ({
          slug,
          creative_id,
          since: query.since,
          until: query.until ?? new Date().toISOString().slice(0, 10),
          phase: "active",
          fatigue_score: 0.32,
          days: [
            { date: "2026-04-29", spend_cents: 12_000, impressions: 21_400, clicks: 612, conversions: 6, revenue_cents: 31_200, roas: 2.6, frequency: 1.2, ctr: 0.0286, cpm: 561 },
            { date: "2026-04-30", spend_cents: 13_500, impressions: 24_100, clicks: 698, conversions: 7, revenue_cents: 35_800, roas: 2.65, frequency: 1.4, ctr: 0.029, cpm: 560 },
            { date: "2026-05-01", spend_cents: 14_200, impressions: 26_800, clicks: 720, conversions: 7, revenue_cents: 36_400, roas: 2.56, frequency: 1.5, ctr: 0.0269, cpm: 530 },
            { date: "2026-05-02", spend_cents: 15_000, impressions: 29_300, clicks: 742, conversions: 8, revenue_cents: 41_200, roas: 2.75, frequency: 1.7, ctr: 0.0253, cpm: 512 },
            { date: "2026-05-03", spend_cents: 16_400, impressions: 32_500, clicks: 731, conversions: 6, revenue_cents: 31_800, roas: 1.94, frequency: 2.0, ctr: 0.0225, cpm: 505 },
            { date: "2026-05-04", spend_cents: 17_100, impressions: 35_200, clicks: 685, conversions: 5, revenue_cents: 27_500, roas: 1.61, frequency: 2.3, ctr: 0.0195, cpm: 486 },
            { date: "2026-05-05", spend_cents: 17_600, impressions: 38_400, clicks: 619, conversions: 4, revenue_cents: 22_400, roas: 1.27, frequency: 2.6, ctr: 0.0161, cpm: 458 },
          ],
        }),
      );
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // 5. Monthly executive report
  // ────────────────────────────────────────────────────────────────────────
  {
    name: "wafle_ads_generate_report_monthly",
    description:
      "Generate a structured monthly ads report for a store. Returns total spend, total revenue, profit, " +
      "blended ROAS, top 5 winning campaigns, bottom 5 losing campaigns, and a `recommendations` array of " +
      "human-readable strings. Designed as the input for Claude to author the executive narrative — DO NOT " +
      "paste raw JSON into the report; rewrite into prose using `recommendations` as bullet points and the " +
      "winners/losers as supporting evidence.\n\n" +
      "Backed by `/stores/:slug/marketing/profit?range=...` (which already aggregates spend × wafle revenue " +
      "per campaign) plus a month-aware aggregation layer.",
    inputSchema: z.object({
      slug: StoreSlug,
      month: IsoMonth.describe("Month to report on, e.g. '2026-04'."),
    }),
    scopes: ["ads:read", "analytics:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: monthly ads report" },
    handler: async (input, ctx) => {
      const { slug, month } = input;
      // Resolve [first day, last day] of month.
      const [yStr, mStr] = month.split("-");
      const y = Number(yStr);
      const m = Number(mStr);
      const start = `${month}-01`;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const end = `${month}-${String(lastDay).padStart(2, "0")}`;

      return realOrMock(
        ctx,
        async () => {
          // Real path: month-grain endpoint preferred; otherwise compose via /marketing/profit with explicit range.
          try {
            return await ctx.client.get(
              `/stores/${encodeURIComponent(slug)}/marketing/report/monthly`,
              { query: { month } },
            );
          } catch (err) {
            if (err instanceof WafleApiError && (err.status === 404 || err.status === 501)) {
              // Fall back to the existing profit endpoint with explicit date range.
              return await ctx.client.get(
                `/stores/${encodeURIComponent(slug)}/marketing/profit`,
                { query: { start, end } },
              );
            }
            throw err;
          }
        },
        () => ({
          slug,
          month,
          period: { start, end },
          totals: {
            spend_cents: 4_820_000,
            revenue_cents: 11_544_000,
            cogs_cents: 4_900_000,
            profit_cents: 1_824_000,
            roas: 2.39,
            margin_pct: 0.158,
          },
          winners: [
            { campaign_id: "23859000111111111", name: "PROSP-AR-LAL3-skincare", spend_cents: 920_000, revenue_cents: 3_220_000, roas: 3.5 },
            { campaign_id: "23859000222222222", name: "RTG-AR-cart-7d", spend_cents: 410_000, revenue_cents: 1_476_000, roas: 3.6 },
            { campaign_id: "23859000333333333", name: "DPA-AR-broadcatalog", spend_cents: 680_000, revenue_cents: 2_244_000, roas: 3.3 },
            { campaign_id: "23859000444444444", name: "BRAND-AR-search", spend_cents: 240_000, revenue_cents: 720_000, roas: 3.0 },
            { campaign_id: "23859000555555555", name: "RTG-AR-pageview-30d", spend_cents: 320_000, revenue_cents: 928_000, roas: 2.9 },
          ],
          losers: [
            { campaign_id: "23859000666666666", name: "TEST-CO-broad", spend_cents: 180_000, revenue_cents: 72_000, roas: 0.4 },
            { campaign_id: "23859000777777777", name: "PROSP-AR-interests-old", spend_cents: 240_000, revenue_cents: 144_000, roas: 0.6 },
            { campaign_id: "23859000888888888", name: "RTG-AR-blogvisitors", spend_cents: 110_000, revenue_cents: 88_000, roas: 0.8 },
            { campaign_id: "23859000999999999", name: "TEST-AR-reels-music", spend_cents: 95_000, revenue_cents: 76_000, roas: 0.8 },
            { campaign_id: "23859001000000000", name: "PROSP-CL-cold", spend_cents: 320_000, revenue_cents: 288_000, roas: 0.9 },
          ],
          recommendations: [
            "Pausar TEST-CO-broad y PROSP-AR-interests-old — ROAS sostenido <0.7 con $4.2k de spend combinado.",
            "Escalar PROSP-AR-LAL3-skincare +30% diario; estable en 3.5x desde semana 2.",
            "Investigar caída de DPA-AR-broadcatalog en últimos 5 días (ver wafle_ads_creative_performance_log para los creatives top).",
            "Audience overlap entre RTG-cart-7d y RTG-pageview-30d: 38% — excluir cart de pageview RTG.",
            "Margin global 15.8%; debajo del 22% objetivo — revisar COGS y gateway fees del próximo mes.",
          ],
        }),
      );
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // 6. Period comparison
  // ────────────────────────────────────────────────────────────────────────
  {
    name: "wafle_ads_compare_periods",
    description:
      "Compare two date ranges (e.g. '2026-04' vs '2026-03', or two arbitrary date windows) and return " +
      "delta % per metric: spend, revenue, ROAS, CPA, conversions, profit. " +
      "Both ranges are evaluated against the wafle CAPI server-side truth so the comparison is honest " +
      "(Meta's pixel attribution can drift quarter to quarter and produce false deltas).\n\n" +
      "Use to answer 'how did April do vs March?' or 'did the new creative pack improve things in the " +
      "last 14 days vs the prior 14?'. Ranges can be passed as ISO months or as start/end dates; the two " +
      "windows must NOT overlap.",
    inputSchema: z
      .object({
        slug: StoreSlug,
        period_a: z.union([
          z.object({ month: IsoMonth }),
          z.object({ start: IsoDate, end: IsoDate }),
        ]),
        period_b: z.union([
          z.object({ month: IsoMonth }),
          z.object({ start: IsoDate, end: IsoDate }),
        ]),
      })
      .describe("Compare period_a (newer) vs period_b (baseline)."),
    scopes: ["ads:read", "analytics:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: compare ad periods" },
    handler: async (input, ctx) => {
      const { slug, period_a, period_b } = input;
      const flatten = (p: typeof period_a): { start: string; end: string } => {
        if ("month" in p) {
          const [yStr, mStr] = p.month.split("-");
          const y = Number(yStr);
          const m = Number(mStr);
          const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
          return { start: `${p.month}-01`, end: `${p.month}-${String(lastDay).padStart(2, "0")}` };
        }
        return { start: p.start, end: p.end };
      };
      const a = flatten(period_a);
      const b = flatten(period_b);

      return realOrMock(
        ctx,
        async () => {
          // Compose via two /marketing/profit calls to compute deltas client-side.
          const [resA, resB] = await Promise.all([
            ctx.client.get<Record<string, unknown>>(
              `/stores/${encodeURIComponent(slug)}/marketing/profit`,
              { query: { start: a.start, end: a.end } },
            ),
            ctx.client.get<Record<string, unknown>>(
              `/stores/${encodeURIComponent(slug)}/marketing/profit`,
              { query: { start: b.start, end: b.end } },
            ),
          ]);
          const num = (o: Record<string, unknown>, k: string): number => {
            const v = o[k];
            return typeof v === "number" ? v : Number(v ?? 0);
          };
          const pct = (curr: number, prev: number): number =>
            prev === 0 ? (curr === 0 ? 0 : 1) : (curr - prev) / prev;
          const metrics: Record<string, { period_a: number; period_b: number; delta_pct: number }> = {};
          for (const k of ["spend_cents", "revenue_cents", "profit_cents", "conversions", "roas", "cpa_cents"]) {
            const ca = num(resA, k);
            const cb = num(resB, k);
            metrics[k] = { period_a: ca, period_b: cb, delta_pct: pct(ca, cb) };
          }
          return {
            slug,
            period_a: a,
            period_b: b,
            metrics,
          };
        },
        () => ({
          slug,
          period_a: a,
          period_b: b,
          metrics: {
            spend_cents: { period_a: 4_820_000, period_b: 4_120_000, delta_pct: 0.170 },
            revenue_cents: { period_a: 11_544_000, period_b: 9_080_000, delta_pct: 0.271 },
            profit_cents: { period_a: 1_824_000, period_b: 1_240_000, delta_pct: 0.471 },
            conversions: { period_a: 612, period_b: 488, delta_pct: 0.254 },
            roas: { period_a: 2.39, period_b: 2.20, delta_pct: 0.086 },
            cpa_cents: { period_a: 7_876, period_b: 8_443, delta_pct: -0.067 },
          },
          summary: "Spend +17%, revenue +27%, profit +47%. ROAS subió de 2.20 → 2.39 (+8.6%). CPA bajó 6.7%.",
        }),
      );
    },
  },
];
