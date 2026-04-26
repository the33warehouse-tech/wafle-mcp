/**
 * Per-store resources.
 *
 * Each resource here either reads the wafle REST API and projects a slice
 * (often a "snapshot" the LLM consumes without further tool calls) or
 * combines multiple endpoints into a single read.
 *
 * Resources never mutate state. If you need to mutate, use a tool.
 */
import type { WafleResource, ResourceParams, ResourceContext } from "./registry.js";

const SLUG_RE = /^[a-z0-9_-]+$/i;

function requireSlug(p: ResourceParams): string {
  const slug = p.params["slug"];
  if (!slug || !SLUG_RE.test(slug) || slug.length < 2 || slug.length > 64) {
    throw new Error(`Invalid store slug in URI: '${slug ?? "(missing)"}'`);
  }
  return slug;
}

async function safeGet<T>(ctx: ResourceContext, path: string, query?: Record<string, unknown>): Promise<T | { error: string }> {
  try {
    return await ctx.client.get<T>(path, query ? { query: query as Record<string, string | number | boolean> } : {});
  } catch (err) {
    const e = err as { kind?: string; status?: number; message?: string };
    return { error: `${e.kind ?? "unknown"} ${e.status ?? ""}: ${e.message ?? String(err)}`.trim() };
  }
}

interface AnyOrders {
  orders?: Array<Record<string, unknown>>;
  total?: number;
}

interface AnyAnalytics {
  range?: string;
  orders?: number;
  revenue?: number;
  top_products?: Record<string, number>;
  conversion?: Record<string, number>;
  events?: Record<string, number>;
}

interface AnyAbandoned {
  sessions?: Array<Record<string, unknown>>;
  total?: number;
}

interface AnyGateways {
  gateways?: Array<Record<string, unknown>>;
}

interface AnyProducts {
  products?: Array<Record<string, unknown>>;
  total?: number;
}

interface AnyStore {
  id?: number;
  slug?: string;
  name?: string;
  domain?: string;
  payment_methods?: string[];
  shipping_methods?: string[];
  catalog_mode?: string;
  enabled_gateways?: number[];
  status?: string;
  pixel_meta?: string;
  pixel_tiktok?: string;
  pixel_ga4?: string;
}

/** Project the wafle store list into a leaner row for the LLM. */
function projectStoreRow(s: AnyStore): Record<string, unknown> {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    domain: s.domain,
    status: s.status,
    catalog_mode: s.catalog_mode,
    payment_methods: s.payment_methods,
    shipping_methods: s.shipping_methods,
    enabled_gateways: s.enabled_gateways,
  };
}

export const storesResources: WafleResource[] = [
  {
    uri: "wafle://stores",
    name: "Stores list",
    description:
      "Lean list of every wafle store the configured key can see: id, slug, name, domain, status, catalog mode, payment + shipping methods, gateway IDs. Use as a starting point before drilling into a specific store.",
    mimeType: "application/json",
    ttlMs: 60_000,
    scopes: ["stores:read"],
    handler: async (_p, ctx) => {
      const data = await ctx.client.get<{ stores?: AnyStore[] }>("/stores");
      const stores = Array.isArray(data?.stores) ? data.stores.map(projectStoreRow) : [];
      return { count: stores.length, stores };
    },
  },
  {
    uri: "wafle://stores/{slug}",
    name: "Store snapshot",
    description:
      "Comprehensive snapshot of a single store, suitable for the LLM to reason about without further tool calls: full settings, 7-day KPIs, abandoned-cart count, top products, and the most recent order. Built from 4 REST calls in parallel.",
    mimeType: "application/json",
    ttlMs: 60_000,
    scopes: ["stores:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const enc = encodeURIComponent(slug);
      const [storeRaw, analytics, abandoned, ordersRecent] = await Promise.all([
        safeGet<{ stores?: AnyStore[] } | AnyStore>(ctx, `/stores/${enc}`),
        safeGet<AnyAnalytics>(ctx, `/stores/${enc}/analytics`, { range: "7d" }),
        safeGet<AnyAbandoned>(ctx, `/stores/${enc}/abandoned`, { per_page: 1 }),
        safeGet<AnyOrders>(ctx, `/stores/${enc}/orders`, { per_page: 1, page: 1 }),
      ]);

      // Wafle returns either a single object or `{ stores: [single] }` shape — defensive.
      let store: AnyStore | undefined;
      if (storeRaw && typeof storeRaw === "object" && !("error" in storeRaw)) {
        if ("stores" in storeRaw && Array.isArray((storeRaw as { stores?: AnyStore[] }).stores)) {
          store = (storeRaw as { stores: AnyStore[] }).stores[0];
        } else {
          store = storeRaw as AnyStore;
        }
      }
      const lastOrder = !("error" in ordersRecent) && Array.isArray(ordersRecent.orders) ? ordersRecent.orders[0] : null;
      const topProducts = !("error" in analytics) && analytics.top_products
        ? Object.entries(analytics.top_products).slice(0, 5).map(([sku, units]) => ({ sku, units }))
        : [];

      return {
        slug,
        store: store ? projectStoreRow(store) : { error: "store_settings_unavailable" },
        kpis_7d: "error" in analytics
          ? { error: analytics.error }
          : {
              orders: analytics.orders ?? 0,
              revenue: analytics.revenue ?? 0,
              conversion: analytics.conversion ?? null,
              events: analytics.events ?? null,
            },
        abandoned_count: "error" in abandoned ? null : (abandoned.total ?? abandoned.sessions?.length ?? 0),
        top_products: topProducts,
        last_order: lastOrder
          ? {
              id: lastOrder["id"],
              status: lastOrder["status"],
              total: lastOrder["total"],
              created: lastOrder["created"],
            }
          : null,
        generated_at: new Date().toISOString(),
      };
    },
  },
  {
    uri: "wafle://stores/{slug}/orders/recent",
    name: "Recent orders",
    description: "Last 20 orders of a store with summary fields (id, status, total, customer email, created). Cached 30s.",
    mimeType: "application/json",
    ttlMs: 30_000,
    scopes: ["orders:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await ctx.client.get<AnyOrders>(`/stores/${encodeURIComponent(slug)}/orders`, {
        query: { per_page: 20, page: 1 },
      });
      const orders = Array.isArray(data.orders)
        ? data.orders.map((o) => ({
            id: o["id"],
            status: o["status"],
            total: o["total"],
            currency: o["currency"],
            customer_email: (o["customer"] as { email?: string } | undefined)?.email ?? null,
            payment_method: o["paymentMethod"] ?? o["payment_method"] ?? null,
            created: o["created"],
          }))
        : [];
      return { slug, count: orders.length, total: data.total ?? orders.length, orders };
    },
  },
  {
    uri: "wafle://stores/{slug}/abandoned",
    name: "Abandoned carts",
    description: "Top 20 abandoned cart sessions (timestamp, captured customer email if any, item count, total). Cached 60s.",
    mimeType: "application/json",
    ttlMs: 60_000,
    scopes: ["abandoned:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await ctx.client.get<AnyAbandoned>(`/stores/${encodeURIComponent(slug)}/abandoned`, {
        query: { per_page: 20, page: 1 },
      });
      const sessions = Array.isArray(data.sessions)
        ? data.sessions.map((s) => ({
            session_id: s["id"] ?? s["session_id"],
            email: s["email"] ?? null,
            items_count: Array.isArray(s["items"]) ? (s["items"] as unknown[]).length : null,
            total: s["total"] ?? null,
            last_activity: s["last_activity"] ?? s["updated"] ?? null,
          }))
        : [];
      return { slug, count: sessions.length, total: data.total ?? sessions.length, sessions };
    },
  },
  {
    uri: "wafle://stores/{slug}/analytics/7d",
    name: "Analytics — 7 days",
    description: "Compact 7-day analytics summary: orders, revenue, AOV, top SKUs, conversion funnel.",
    mimeType: "application/json",
    ttlMs: 5 * 60 * 1000,
    scopes: ["analytics:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await ctx.client.get<AnyAnalytics>(`/stores/${encodeURIComponent(slug)}/analytics`, {
        query: { range: "7d" },
      });
      const orders = data.orders ?? 0;
      const revenue = data.revenue ?? 0;
      return {
        slug,
        range: "7d",
        orders,
        revenue,
        aov: orders > 0 ? Math.round(revenue / orders) : 0,
        top_products: data.top_products ?? {},
        conversion: data.conversion ?? null,
        events: data.events ?? null,
      };
    },
  },
  {
    uri: "wafle://stores/{slug}/analytics/30d",
    name: "Analytics — 30 days",
    description: "Compact 30-day analytics summary: orders, revenue, AOV, top SKUs, conversion funnel.",
    mimeType: "application/json",
    ttlMs: 5 * 60 * 1000,
    scopes: ["analytics:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await ctx.client.get<AnyAnalytics>(`/stores/${encodeURIComponent(slug)}/analytics`, {
        query: { range: "30d" },
      });
      const orders = data.orders ?? 0;
      const revenue = data.revenue ?? 0;
      return {
        slug,
        range: "30d",
        orders,
        revenue,
        aov: orders > 0 ? Math.round(revenue / orders) : 0,
        top_products: data.top_products ?? {},
        conversion: data.conversion ?? null,
        events: data.events ?? null,
      };
    },
  },
  {
    uri: "wafle://stores/{slug}/products/sample",
    name: "Top products sample",
    description: "Top 20 products of a store (id, sku, name, price, stock, status). Useful as a seed list before deeper queries.",
    mimeType: "application/json",
    ttlMs: 2 * 60 * 1000,
    scopes: ["products:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await ctx.client.get<AnyProducts>(`/stores/${encodeURIComponent(slug)}/products`, {
        query: { per_page: 20, page: 1 },
      });
      const products = Array.isArray(data.products)
        ? data.products.map((pr) => ({
            id: pr["id"],
            sku: pr["sku"],
            slug: pr["slug"],
            name: pr["name"],
            price: pr["price"],
            stock: pr["stock"],
            status: pr["status"],
          }))
        : [];
      return { slug, count: products.length, total: data.total ?? products.length, products };
    },
  },
  {
    uri: "wafle://stores/{slug}/email/segments",
    name: "Customer segments",
    description: "Customer segments defined for a store (slug, name, criteria summary, estimated size).",
    mimeType: "application/json",
    ttlMs: 60_000,
    scopes: ["customers:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await safeGet<{ segments?: Array<Record<string, unknown>> }>(
        ctx,
        `/stores/${encodeURIComponent(slug)}/customers/segments`,
      );
      if ("error" in data) return { slug, error: data.error, segments: [] };
      const segments = Array.isArray(data.segments) ? data.segments : [];
      return { slug, count: segments.length, segments };
    },
  },
  {
    uri: "wafle://stores/{slug}/email/recent-campaigns",
    name: "Recent email campaigns",
    description: "Last 10 email/marketing campaigns of a store with stats (sent, opened, clicked, bounced).",
    mimeType: "application/json",
    ttlMs: 60_000,
    scopes: ["analytics:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await safeGet<{ campaigns?: Array<Record<string, unknown>> }>(
        ctx,
        `/stores/${encodeURIComponent(slug)}/marketing/campaigns`,
        { per_page: 10, page: 1 },
      );
      if ("error" in data) return { slug, error: data.error, campaigns: [] };
      const campaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      return { slug, count: campaigns.length, campaigns };
    },
  },
  {
    uri: "wafle://stores/{slug}/ads/connections",
    name: "Ad platform connections",
    description: "Status of Meta / Google / TikTok ad connections for a store: id, platform, active flag, last_sync_at.",
    mimeType: "application/json",
    ttlMs: 5 * 60 * 1000,
    scopes: ["analytics:read"],
    handler: async (p, ctx) => {
      const slug = requireSlug(p);
      const data = await safeGet<{ connections?: Array<Record<string, unknown>>; gateways?: Array<Record<string, unknown>> }>(
        ctx,
        `/stores/${encodeURIComponent(slug)}/ads/connections`,
      );
      if ("error" in data) {
        // Fallback: derive from gateways list if /ads/connections is not yet exposed by the wafle build.
        const gw = await safeGet<AnyGateways>(ctx, `/gateways`);
        return {
          slug,
          error: data.error,
          fallback_gateways: "error" in gw ? null : gw.gateways,
          connections: [],
        };
      }
      const connections = Array.isArray(data.connections) ? data.connections : [];
      return { slug, count: connections.length, connections };
    },
  },
];
