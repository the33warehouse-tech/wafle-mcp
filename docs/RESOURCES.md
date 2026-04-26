# Wafle MCP — Resources

> _MCP Resources let an LLM "read" structured context without spending tool calls. The wafle MCP server exposes 14 resources covering global health, scope catalog, store snapshots, and reference docs._

In Claude Desktop you reference a resource with `@<uri>` in chat (the client auto-fetches). In Claude Code, mention the URI in the conversation and Claude calls `resources/read` automatically.

---

## Why resources, not tools

A **tool** is a verb (do something). A **resource** is a noun (read context). Use resources for:

- Read-only snapshots that don't take parameters beyond identity (`{slug}`).
- Cached reference data (scope catalog, architecture overview).
- Pre-aggregated views the LLM consumes once and reasons over.

Use tools for mutations, parameterized queries, and anything that should be auditable.

---

## Catalogue (14)

| URI | Name | Mime | TTL | Scope |
|---|---|---|---|---|
| `wafle://system/health` | System health | json | 30s | `system:read` |
| `wafle://system/scopes-catalog` | Scope catalog | json | 1h | — |
| `wafle://docs/api-conventions` | REST conventions | markdown | 1h | — |
| `wafle://docs/architecture` | Architecture overview | markdown | 1h | — |
| `wafle://stores` | Stores list (lean) | json | 60s | `stores:read` |
| `wafle://stores/{slug}` | Store snapshot | json | 60s | `stores:read` |
| `wafle://stores/{slug}/orders/recent` | Last 20 orders | json | 30s | `orders:read` |
| `wafle://stores/{slug}/abandoned` | Top 20 abandoned carts | json | 60s | `abandoned:read` |
| `wafle://stores/{slug}/analytics/7d` | 7-day analytics summary | json | 5min | `analytics:read` |
| `wafle://stores/{slug}/analytics/30d` | 30-day analytics summary | json | 5min | `analytics:read` |
| `wafle://stores/{slug}/products/sample` | Top 20 products | json | 2min | `products:read` |
| `wafle://stores/{slug}/email/segments` | Customer segments | json | 60s | `customers:read` |
| `wafle://stores/{slug}/email/recent-campaigns` | Last 10 campaigns | json | 60s | `analytics:read` |
| `wafle://stores/{slug}/ads/connections` | Meta/Google/TikTok connections | json | 5min | `analytics:read` |

---

## Examples

### Read a store snapshot in Claude Desktop

```
@wafle://stores/gamerland

How is gamerland doing this week?
```

The client fetches the resource, Claude sees:

```json
{
  "slug": "gamerland",
  "store": {
    "id": 10,
    "slug": "gamerland",
    "name": "Gamerland",
    "domain": "gamerland.atacado.me",
    "status": "publish",
    "catalog_mode": "supabase_sync",
    "payment_methods": ["mp", "transfer"],
    "shipping_methods": ["andreani", "oca", "retiro", "gratis"]
  },
  "kpis_7d": {
    "orders": 36,
    "revenue": 6025100,
    "conversion": { "views": 20, "adds": 12, "checkouts": 3, "submitted": 1 }
  },
  "abandoned_count": 0,
  "top_products": [
    { "sku": "gl-011", "units": 4 },
    { "sku": "gl-012", "units": 3 }
  ],
  "last_order": { "id": 97, "status": "pending", "total": "1000.00", "created": "2026-04-26T03:26:57+00:00" },
  "generated_at": "2026-04-26T17:30:00.000Z"
}
```

…and answers immediately, no tool calls needed.

### Reference the conventions in a long-running session

```
@wafle://docs/api-conventions

Build a script to import 1000 products via wafle_products_create_manual.
```

Claude reads the conventions, knows about idempotency keys, snake_case, money in major units, and writes the script correctly.

### Combine with tools

```
@wafle://stores/lensitive/orders/recent

Cualquier pedido en `payment_failed`? Si hay, hacé `wafle_orders_get` de cada uno y dame el reason.
```

Claude reads the recent orders, filters in-context, and only spends tool calls on the failed ones.

---

## Caching semantics

Each resource declares a TTL. Within the TTL window, repeat reads of the same URI are served from an in-memory `Map`. Concurrent reads of the same URI are coalesced into a single in-flight upstream call.

After a destructive write that affects a store (e.g. `wafle_orders_ship`), the cached resources for that store are still valid for whatever remains of their TTL — meaning the next `resources/read` may show a slightly stale snapshot. Two ways to force a refresh:

1. **Wait it out** — most TTLs are 30s–5min. For dashboards that's fine.
2. **Invalidate manually** with the `wafle_resources_invalidate` tool (master scope):

```json
{
  "name": "wafle_resources_invalidate",
  "arguments": { "uri_pattern": "gamerland" }
}
```

Drops every cached entry whose URI contains `gamerland`. Omit `uri_pattern` to flush the entire cache.

The long-running tools `wafle_products_sync_trigger_and_wait`, `wafle_csv_import` invalidate the affected store automatically on success.

---

## URI templates

URIs containing `{name}` are templates. Clients see them via `resources/templates/list`. The server resolves a concrete URI like `wafle://stores/calista` against the template `wafle://stores/{slug}` and routes it to the same handler with `params.slug = "calista"`.

Validation:
- `{slug}` must match `^[a-z0-9_-]{2,64}$/i` — invalid slugs return a JSON error in the `contents` payload, not a protocol-level failure.
- Other params are URL-decoded once.

---

## Adding new resources

1. Pick a URI: `wafle://<domain>/<thing>` or `wafle://<domain>/{param}/<thing>`.
2. Add a `WafleResource` to `src/resources/<domain>.ts` with `uri`, `name`, `description`, `mimeType`, `ttlMs`, `scopes` (optional), and `handler`.
3. Export it from `src/resources/index.ts`.
4. Add a row to the table above + a test in `test/resources.test.ts`.

The handler receives `{ params, uri }` and a `ResourceContext` containing the wafle `client`, a `log`, and the granted scopes. Throw to surface an error; return a string or object body.

---

## Future work

- `resources/subscribe` for live-updating dashboards (deferred — needs SSE wiring per session).
- Resource templates for dynamic queries (`wafle://stores/{slug}/orders/recent?status={s}` — requires URI-template params with query semantics).
- Server-driven `notifications/resources/list_changed` after schema-level changes (e.g. new store created).
