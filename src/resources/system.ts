/**
 * System / global resources.
 *
 * These resources are not tied to a single store. They expose health,
 * the scope catalog, and reference docs.
 */
import type { WafleResource } from "./registry.js";
import { ALL_SCOPES } from "../auth/scopes.js";

const SCOPE_DOMAINS: Record<string, { domain: string; tier: "read" | "write" | "admin" }> = {};
for (const s of ALL_SCOPES) {
  const [domain, action] = s.split(":");
  SCOPE_DOMAINS[s] = {
    domain: domain ?? "unknown",
    tier:
      action === "admin"
        ? "admin"
        : action === "write" || action === "send" || action === "refund" || action === "quote" || action === "export"
          ? "write"
          : "read",
  };
}

/**
 * Static catalog of every wafle scope: domain, tier, human label.
 *
 * Sourced from `src/auth/scopes.ts`, which is the single source of truth.
 */
function scopesCatalog(): { count: number; scopes: Array<{ scope: string; domain: string; tier: string; label: string }> } {
  const scopes = ALL_SCOPES.map((s) => {
    const meta = SCOPE_DOMAINS[s]!;
    return {
      scope: s,
      domain: meta.domain,
      tier: meta.tier,
      label: humanLabelForScope(s),
    };
  });
  return { count: scopes.length, scopes };
}

function humanLabelForScope(scope: string): string {
  const [domain, action] = scope.split(":");
  const verbMap: Record<string, string> = {
    read: "read",
    write: "write",
    admin: "administer",
    send: "send",
    refund: "refund",
    quote: "quote",
    export: "export",
  };
  const verb = verbMap[action ?? ""] ?? action ?? "use";
  return `${domain ?? scope} — ${verb}`;
}

const ARCHITECTURE_SUMMARY = `# wafle architecture (TL;DR)

The wafle commerce platform is a multi-tenant LLM-first e-commerce stack:

- **REST API** at \`https://wafle.click/wp-json/waffle/v1\` — the source of truth for every domain (stores, orders, products, gateways, customers, abandoned carts, analytics, ads connections, exports, system).
- **MCP server** (this package) — wraps the REST API as 64+ conversational tools + 14+ resources for any MCP-compatible client.
- **Dashboard** at \`https://wafle.click/admin\` — Vue 3 SPA, calls the same REST API.
- **Storefronts** — per-store Next.js fronts on per-store domains. Each storefront uses a per-store API key with narrow scopes.

## Multi-tenancy

Every store has a numeric \`tenant_id\` and a \`slug\`. Most REST endpoints are namespaced under \`/stores/{slug}/...\`. A master admin key can access all stores; a per-store key is restricted to one tenant.

## Catalog modes

- \`supabase_sync\` — products mirror an upstream Supabase catalog. Local edits use \`overrides\` so they survive sync.
- \`manual\` — products are created locally via dashboard or \`wafle_products_create_manual\`.
- \`csv\` — products imported from a remote CSV; supports manual / scheduled re-runs.

## Background jobs

Catalog syncs, ad-platform syncs, exports and abandoned-cart blasts run in a Redis-backed queue. Status is queryable via \`/system/queue/*\` and per-job endpoints.

## See also

- \`wafle://docs/api-conventions\` — REST canonical shapes (snake_case, money in major units, ISO timestamps, idempotency keys).
- \`wafle://system/scopes-catalog\` — the 30+ scopes the API key system supports.
`;

const API_CONVENTIONS = `# wafle REST conventions

## Casing

Request and response bodies use **snake_case**. Tool wrappers translate to/from snake_case so that LLM-friendly camelCase fields can also be passed where it improves naturalness, but on the wire it is always snake_case.

## Money

All monetary fields are **major units in the store currency** unless the field name ends in \`_cents\`, in which case minor units (1/100). Total fields like \`total_cents\` are integers; \`unit_price\` is a decimal in major units.

## Timestamps

ISO-8601 UTC strings (\`2026-04-26T03:32:11Z\`) for human-facing fields; **epoch seconds** (\`from_ts\`, \`to_ts\`, \`since_ts\`) for filters.

## Pagination

\`page\` (1-indexed) and \`per_page\` (max 200, default 50). Responses include \`{ page, per_page, total }\`.

## Idempotency

Every \`POST\` accepts an \`Idempotency-Key\` header. The MCP client auto-generates a UUIDv7 if the caller omits one, so retries on transient errors are safe.

## Errors

Non-2xx responses follow:

\`\`\`json
{ "code": "waffle_unauthorized", "message": "...", "data": { "status": 401 } }
\`\`\`

The MCP server classifies these into \`unauthorized | forbidden | not_found | validation | conflict | rate_limited | server | network | timeout | unknown\` and exposes a structured \`{ error, kind, status, code, details }\` to tool callers.

## Auth

\`X-Wafle-Admin-Key: <key>\` on every request. Two flavors of key:
- **master** (\`type=master\`, \`scopes=["*"]\`): unrestricted.
- **store-scoped** (\`type=store\`, \`store_slug=...\`): can only act on that tenant.

## See also

- \`wafle://docs/architecture\` — high-level architecture.
- \`wafle://system/scopes-catalog\` — scope matrix.
`;

export const systemResources: WafleResource[] = [
  {
    uri: "wafle://system/health",
    name: "System health",
    description:
      "Snapshot of the wafle backend: database, redis, cron, queue, releases. Returns latency per check. Cheap first call when something looks off.",
    mimeType: "application/json",
    ttlMs: 30_000,
    scopes: ["system:read"],
    handler: async (_p, ctx) => ctx.client.get<unknown>("/health"),
  },
  {
    uri: "wafle://system/scopes-catalog",
    name: "Scope catalog",
    description:
      "Reference catalog of every wafle API scope: domain, tier (read/write/admin), human label. Sourced from the MCP scope matrix; matches the wafle backend.",
    mimeType: "application/json",
    ttlMs: 60 * 60 * 1000,
    handler: async () => scopesCatalog(),
  },
  {
    uri: "wafle://docs/api-conventions",
    name: "API conventions",
    description:
      "Canonical request/response shapes used by the wafle REST API: snake_case, money units, timestamps, pagination, idempotency, errors.",
    mimeType: "text/markdown",
    ttlMs: 60 * 60 * 1000,
    handler: async () => API_CONVENTIONS,
  },
  {
    uri: "wafle://docs/architecture",
    name: "Architecture overview",
    description:
      "High-level architecture of the wafle platform: REST API, dashboard, storefronts, multi-tenancy, catalog modes, background jobs.",
    mimeType: "text/markdown",
    ttlMs: 60 * 60 * 1000,
    handler: async () => ARCHITECTURE_SUMMARY,
  },
];
