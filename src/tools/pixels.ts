import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";
import { resolveSlug, isTenantSlugError } from "./tenant-helper.js";

export const pixelsTools: WafleTool[] = [
  {
    name: "wafle_pixels_get",
    description:
      "Fetch the current marketing pixel IDs configured for a store: Meta (Facebook), TikTok, GA4, Google Ads.",
    inputSchema: z.object({ slug: StoreSlug }),
    scopes: ["pixels:read"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(slug)}/pixels`);
    },
  },
  {
    name: "wafle_pixels_set",
    description:
      "Set / update marketing pixel IDs of a store. Pass only the pixels you want to change; omit fields stay untouched. Pass `null` to clear a pixel.",
    inputSchema: z.object({
      slug: StoreSlug,
      meta: z.string().nullable().optional().describe("Meta pixel id."),
      tiktok: z.string().nullable().optional(),
      ga4: z.string().nullable().optional(),
      google_ads: z.string().nullable().optional(),
    }),
    scopes: ["pixels:write"],
    annotations: { idempotentHint: true },
    handler: async (input, ctx) => {
      const slug = resolveSlug(input.slug, ctx);
      if (isTenantSlugError(slug)) throw new Error(slug.message);
      const { slug: _s, ...body } = input;
      // Map to wafle's flat field names on the store record (pixel_meta, pixel_tiktok, etc.).
      const payload: Record<string, unknown> = {};
      if ("meta" in body) payload["pixel_meta"] = body.meta;
      if ("tiktok" in body) payload["pixel_tiktok"] = body.tiktok;
      if ("ga4" in body) payload["pixel_ga4"] = body.ga4;
      if ("google_ads" in body) payload["pixel_google_ads"] = body.google_ads;
      return ctx.client.patch<unknown>(`/stores/${encodeURIComponent(slug)}`, payload);
    },
  },
];
