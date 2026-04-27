import { z } from "zod";
import type { WafleTool } from "./registry.js";
import { StoreSlug } from "../schemas/common.js";

/**
 * Custom Domains v1 tools.
 *
 * Lets agents drive the self-serve attach-your-own-domain flow end-to-end:
 *   1. List currently attached domains for a tenant.
 *   2. Add a new domain → returns DNS instructions (TXT/CNAME/file token).
 *   3. Trigger a verification probe + SSL provisioning + nginx writeout.
 *   4. Inspect the per-domain status (verified/active/ssl_failed/disabled).
 *
 * Behind the scenes the wafle backend takes care of:
 *   - acme.sh-driven Let's Encrypt issuance.
 *   - Per-domain nginx server-block render → host-side reload.
 *   - Daily renewal cron with 3-strike circuit-breaker.
 *
 * If `WAFFLE_DOMAINS_MOCK=1` is set on the wafle host, real DNS + acme calls
 * are skipped and the probe reads option-stored mocks. Useful for smoke + CI.
 */
export const domainsTools: WafleTool[] = [
  {
    name: "wafle_domains_list",
    description:
      "List the custom domains attached to a wafle store. Returns each domain's status (pending_verification / verifying / ssl_pending / active / ssl_failed / disabled), SSL expiry, verification token, and DNS-setup instructions for all 3 verification methods (TXT/CNAME/file).\n\n" +
      "Use first when the user asks 'what domains does store X have?' or before giving DNS instructions to a new tenant.",
    inputSchema: z.object({
      slug: StoreSlug,
      status: z
        .enum(["pending_verification", "verifying", "ssl_pending", "active", "ssl_failed", "disabled"])
        .optional()
        .describe("Filter by status."),
      limit: z.number().int().positive().max(200).optional(),
    }),
    scopes: ["domains:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: list custom domains" },
    handler: async (input, ctx) => {
      const qs = new URLSearchParams();
      if (input.status) qs.set("status", input.status);
      if (input.limit) qs.set("limit", String(input.limit));
      const tail = qs.toString() ? `?${qs.toString()}` : "";
      return ctx.client.get<unknown>(`/stores/${encodeURIComponent(input.slug)}/domains${tail}`);
    },
  },
  {
    name: "wafle_domains_add",
    description:
      "Attach a new custom domain (e.g. 'mi-tienda.com') to a wafle store. Wafle generates a verification_token and returns the 3 alternative DNS instructions the tenant must apply.\n\n" +
      "After creating, the tenant updates DNS at their provider, then call `wafle_domains_verify` (or wait for the 5min cron) to drive verification + SSL + nginx provisioning.\n\n" +
      "Validation rules: lowercase FQDN only, no IPs, no wildcards, no .wafle.click subdomains, max 10 active domains per tenant.",
    inputSchema: z.object({
      slug: StoreSlug,
      domain: z.string().min(3).describe("FQDN to attach. Strip protocol + trailing slash. e.g. 'mi-tienda.com' or 'shop.example.com'."),
      storefront_target: z
        .enum(["main", "admin", "custom"])
        .optional()
        .describe("Where requests to this domain should land (default: main = storefront)."),
      custom_target_url: z
        .string()
        .optional()
        .describe("Required if storefront_target='custom'. Absolute URL to proxy to."),
      verification_method: z
        .enum(["txt", "cname", "file"])
        .optional()
        .describe("Preferred verification method to highlight in the UI. Any one method passes."),
      redirect_www: z.boolean().optional().describe("If true (default), www.<domain> is also bound and redirected to the apex."),
      force_https: z.boolean().optional().describe("If true (default), HTTP traffic is 301'd to HTTPS once the cert is live."),
    }),
    scopes: ["domains:write"],
    annotations: { destructiveHint: false, idempotentHint: false, title: "Wafle: add custom domain" },
    handler: async (input, ctx) => {
      const { slug, ...body } = input;
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(slug)}/domains`, body);
    },
  },
  {
    name: "wafle_domains_verify",
    description:
      "Trigger immediate verification + SSL + nginx provisioning for a previously-added domain. Idempotent — safe to call repeatedly. The pipeline:\n" +
      "  1. Probe TXT / CNAME / file methods (any one passes).\n" +
      "  2. If passed → request a Let's Encrypt cert via acme.sh.\n" +
      "  3. Render the per-domain nginx config and signal a reload.\n" +
      "  4. Mark the domain `active` and append events to the log.\n\n" +
      "Rate-limited to 1 attempt per minute per domain (DNS + acme upstream).",
    inputSchema: z.object({
      slug: StoreSlug,
      id: z.number().int().positive().describe("Custom-domain row id (returned by wafle_domains_add or wafle_domains_list)."),
    }),
    scopes: ["domains:write"],
    annotations: { idempotentHint: true, title: "Wafle: verify + provision domain" },
    handler: async (input, ctx) => {
      return ctx.client.post<unknown>(`/stores/${encodeURIComponent(input.slug)}/domains/${input.id}/verify`, {});
    },
  },
  {
    name: "wafle_domains_status",
    description:
      "Fetch the full status of a single attached domain — current status (pending/verifying/active/etc), SSL expiry, last renewal, log of recent events. Includes the original DNS-setup instructions so you can re-show them to the tenant.\n\n" +
      "Use to answer 'is mi-tienda.com working yet?' or to debug a stuck verification.",
    inputSchema: z.object({
      slug: StoreSlug,
      id: z.number().int().positive(),
      include_log: z.boolean().optional().describe("If true, also fetch the last ~20 events from the per-domain log."),
    }),
    scopes: ["domains:read"],
    annotations: { readOnlyHint: true, idempotentHint: true, title: "Wafle: domain status" },
    handler: async (input, ctx) => {
      const head = await ctx.client.get<Record<string, unknown>>(
        `/stores/${encodeURIComponent(input.slug)}/domains/${input.id}`,
      );
      if (input.include_log) {
        try {
          const log = await ctx.client.get<unknown>(
            `/stores/${encodeURIComponent(input.slug)}/domains/${input.id}/log?limit=20`,
          );
          (head as Record<string, unknown>).recent_log = log;
        } catch (e) {
          // Non-fatal — head still useful.
        }
      }
      return head;
    },
  },
];
