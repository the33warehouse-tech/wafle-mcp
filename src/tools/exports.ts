import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";

const ExportFormat = z.enum(["csv", "json"]).default("csv");

export const exportsTools: WafleTool[] = [
  {
    name: "wafle_exports_customers",
    description:
      "Export the customer list of a store as CSV (default) or JSON. Includes email, name, phone, total spent, order count, last seen.\n\n" +
      "Use for CRM imports or general data exports. Wafle returns the raw CSV/JSON in the response body — for large stores prefer the dashboard download flow.",
    inputSchema: z.object({
      slug: StoreSlug,
      format: ExportFormat,
      segment: z.string().optional(),
      min_orders: z.number().int().nonnegative().optional(),
    }),
    scopes: ["customers:export"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/exports/customers`, { query: rest });
    },
  },
  {
    name: "wafle_exports_meta_audience",
    description:
      "Export an audience formatted for Meta (Facebook/Instagram) custom audiences: hashed email + phone per row, schema-compatible with Meta's CSV upload.\n\n" +
      "Filter by segment to build retargeting (high-intent, recovered, top-spenders) cohorts.",
    inputSchema: z.object({
      slug: StoreSlug,
      segment: z.string().optional().describe("Segment slug; omit for all customers."),
      min_total_spent: z.number().nonnegative().optional(),
      since_ts: z.number().int().optional(),
    }),
    scopes: ["customers:export"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/exports/meta-audience`, { query: rest });
    },
  },
  {
    name: "wafle_exports_google_ads",
    description:
      "Export an audience formatted for Google Ads Customer Match: hashed email/phone with the column names Google expects.",
    inputSchema: z.object({
      slug: StoreSlug,
      segment: z.string().optional(),
      since_ts: z.number().int().optional(),
    }),
    scopes: ["customers:export"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const { slug, ...rest } = input;
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/exports/google-ads`, { query: rest });
    },
  },
];
