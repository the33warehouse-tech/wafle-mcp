/**
 * AI feature tools — thin wrappers around `/wafle/v1/stores/:slug/ai/*`.
 *
 * Six job types live behind these tools:
 *   - product_description, translation, segment_compile,
 *     categorize, review_summary, support_hint.
 *
 * The tools call the REST shortcuts where possible (faster, cached) and
 * fall back to the generic `/ai/jobs` dispatcher for less common shapes.
 */
import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug, Pagination } from "../schemas/common.js";
import { resolveSlug, isTenantSlugError } from "./tenant-helper.js";

const Locale = z
  .string()
  .min(2)
  .max(10)
  .describe("BCP-47-ish locale code, e.g. 'es-AR', 'es-PY', 'pt-BR', 'en-US'.");

const Lang = z
  .string()
  .min(2)
  .max(5)
  .describe("Language code: 'es', 'en', 'pt', or extended 'es-AR' / 'pt-BR'.");

export const aiTools: WafleTool[] = [
  {
    name: "wafle_ai_translate",
    description:
      "Translate a piece of text from one language to another. Cached by sha256(source_text|source_lang|target_lang) — re-translating the same input is free.\n\n" +
      "Preserves markdown, lists, links and {{placeholders}}. Use for product descriptions, emails, or short copy snippets. Source and target are language codes ('es', 'en', 'pt', 'es-AR', 'pt-BR').",
    inputSchema: z.object({
      slug: StoreSlug,
      text: z.string().min(1).describe("Source text to translate."),
      source_lang: Lang,
      target_lang: Lang,
    }),
    scopes: ["ai:use"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/ai/translate`, body);
    },
  },
  {
    name: "wafle_ai_segment_compile",
    description:
      "Compile a natural-language description (e.g. 'clientes que compraron al menos 2 veces y abandonaron carro últimos 30 días') into the email-marketing segmentation DSL. Returns `{ dsl_json, validated, errors }`. Pass `dsl_json` straight into a new segment.",
    inputSchema: z.object({
      slug: StoreSlug,
      natural_language: z.string().min(4).describe("Plain-Spanish description of the audience."),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/ai/segment-compile`, {
        natural_language: input.natural_language,
      });
    },
  },
  {
    name: "wafle_ai_product_describe",
    description:
      "Generate a sales copy description for a product. Reads name + attributes + images from the catalog, runs the configured LLM, and stores the output as a 'pending review' job. Call `wafle_ai_jobs_accept` to apply it (writes data.descriptions.<lang> on the catalog row).\n\n" +
      "Tone: 'persuasivo' | 'tecnico' | 'breve'. Length is approximate words (±15%).",
    inputSchema: z.object({
      slug: StoreSlug,
      sku: z.string().min(1).describe("Product SKU."),
      tone: z.enum(["persuasivo", "tecnico", "breve"]).default("persuasivo"),
      length_words: z.number().int().min(40).max(400).default(100),
      locale: Locale.default("es-AR"),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, sku, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ai/products/${encodeURIComponent(sku)}/describe`,
        body,
      );
    },
  },
  {
    name: "wafle_ai_review_summary",
    description:
      "Summarize the approved reviews of a product into 2–3 sentences plus sentiment + key points. Output goes into a job; call `wafle_ai_jobs_accept` to cache the summary on the reviews aggregate row (24h TTL).",
    inputSchema: z.object({
      slug: StoreSlug,
      sku: z.string().min(1).describe("Product SKU."),
      max_reviews: z.number().int().min(5).max(200).default(50),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, sku, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ai/products/${encodeURIComponent(sku)}/review-summary`,
        body,
      );
    },
  },
  {
    name: "wafle_ai_categorize",
    description:
      "Auto-classify products without a category. Call with a list of SKUs and a list of allowed categories. Each product gets `{ category, confidence }` (or null if nothing fits). Accept the job to write category overrides into the catalog.",
    inputSchema: z.object({
      slug: StoreSlug,
      product_skus: z
        .array(z.string().min(1))
        .min(1)
        .max(25)
        .describe("Up to 25 SKUs (batched 5/call internally)."),
      available_categories: z
        .array(z.string().min(1))
        .min(1)
        .describe("Allowed category slugs."),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/ai/jobs`, {
        job_type: "categorize",
        input: body,
      });
    },
  },
  {
    name: "wafle_ai_support_hint",
    description:
      "Customer-service co-pilot: classify an inbound message, gauge sentiment, decide if it needs escalation, and draft a friendly response. PII (emails, phones) in the message is redacted before being sent to the LLM.",
    inputSchema: z.object({
      slug: StoreSlug,
      inbound_message: z.string().min(2),
      customer_email: z.string().email().optional(),
      total_orders: z.number().int().min(0).optional(),
      last_orders_summary: z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]).optional(),
            status: z.string().optional(),
            total: z.union([z.string(), z.number()]).optional(),
            date: z.string().optional(),
          }),
        )
        .max(10)
        .optional(),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/ai/jobs`, {
        job_type: "support_hint",
        input: body,
      });
    },
  },
  {
    name: "wafle_ai_jobs_list",
    description:
      "Paginated list of AI jobs for a store. Filter by job_type, status, or user_review. Use to surface a 'pending review' queue or to find a specific recent job.",
    inputSchema: z.object({
      slug: StoreSlug,
      job_type: z
        .enum([
          "product_description",
          "translation",
          "segment_compile",
          "categorize",
          "review_summary",
          "support_hint",
        ])
        .optional(),
      status: z.enum(["queued", "running", "done", "failed"]).optional(),
      user_review: z.enum(["pending", "accepted", "rejected", "edited"]).optional(),
      page: Pagination.page,
      per_page: Pagination.per_page,
    }),
    scopes: ["ai:use"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...query } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/ai/jobs`, { query });
    },
  },
  {
    name: "wafle_ai_jobs_get",
    description: "Fetch a single AI job by id. Includes input_payload, output_payload, tokens, cost, model, duration, and user review status.",
    inputSchema: z.object({
      slug: StoreSlug,
      id: z.number().int().positive(),
    }),
    scopes: ["ai:use"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/ai/jobs/${input.id}`);
    },
  },
  {
    name: "wafle_ai_jobs_accept",
    description:
      "Apply an AI job's output to the platform.\n\n" +
      "  - product_description → writes data.descriptions.<lang> on the catalog row.\n" +
      "  - categorize → writes data.category overrides on each product row.\n" +
      "  - review_summary → caches summary on the reviews aggregates row.\n" +
      "Other types have no platform side effect (translation already cached, segment_compile is read-only).",
    inputSchema: z.object({
      slug: StoreSlug,
      id: z.number().int().positive(),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ai/jobs/${input.id}/accept`,
        {},
      );
    },
  },
  {
    name: "wafle_ai_jobs_reject",
    description: "Mark an AI job's output as rejected. Use to keep usage stats clean and to preserve learning signal for prompt tuning.",
    inputSchema: z.object({
      slug: StoreSlug,
      id: z.number().int().positive(),
      reason: z.string().optional(),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, id, ...body } = input;
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ai/jobs/${id}/reject`,
        body,
      );
    },
  },
  {
    name: "wafle_ai_jobs_edit",
    description:
      "Save user edits on an AI job's output and apply them. For product_description, the edited text is what gets written to data.descriptions.<lang>.",
    inputSchema: z.object({
      slug: StoreSlug,
      id: z.number().int().positive(),
      user_edits: z.string().min(1).describe("Edited output text."),
    }),
    scopes: ["ai:use"],
    annotations: {},
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.post<unknown>(
        `/stores/${encodeURIComponent(slug)}/ai/jobs/${input.id}/edit`,
        { user_edits: input.user_edits },
      );
    },
  },
  {
    name: "wafle_ai_usage",
    description: "Token + cost aggregate for a store since a date (defaults to last 30 days). Use for the AI dashboard chart and quota guidance.",
    inputSchema: z.object({
      slug: StoreSlug,
      since: z.string().optional().describe("ISO datetime; defaults to 30 days ago."),
    }),
    scopes: ["ai:use"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/ai/usage`, {
        query: input.since ? { since: input.since } : undefined,
      });
    },
  },
];
