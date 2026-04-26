# `@wafle/mcp` — Model Context Protocol server for [wafle](https://wafle.click)

> The first MCP server for the wafle commerce platform. Lets Claude Desktop, Claude Code, agents, and any MCP-compatible client drive a wafle tenant — stores, products, orders, pricing, gateways, audiences, system — by talking to it.

[![tests](https://img.shields.io/badge/tests-105%20passing-brightgreen)]() [![coverage](https://img.shields.io/badge/coverage-85%25-brightgreen)]() [![tools](https://img.shields.io/badge/tools-68-blue)]() [![resources](https://img.shields.io/badge/resources-14-blue)]() [![prompts](https://img.shields.io/badge/prompts-5-blue)]()

---

## What this is

Wafle is the LLM-first multi-tenant commerce platform. Its REST API at `https://wafle.click/wp-json/waffle/v1/` does the work; this MCP server exposes that work as **68 tools, 14 resources, and 5 server-defined prompts** an LLM can pick from. Every wafle feature should land here as a tool first, UI second.

This is a thin, well-typed wrapper. No business logic lives in this package — bugs in pricing or order flow belong to the wafle backend.

## Install

```bash
git clone <repo>
cd wafle-mcp
npm install
npm run build
```

## Configure

Set environment variables (or copy `.env.example` to `.env`):

```bash
WAFLE_API_URL=https://wafle.click/wp-json/waffle/v1   # default
WAFLE_API_KEY=<your wafle admin key>                   # required
WAFLE_TIMEOUT_MS=30000                                 # optional

# Only used by --transport=http:
WAFLE_MCP_HTTP_HOST=0.0.0.0
WAFLE_MCP_HTTP_PORT=7100
WAFLE_MCP_TOKENS=<comma-separated bearer tokens>       # required for HTTP

LOG_LEVEL=info
```

The `WAFLE_API_KEY` is sent as `X-Wafle-Admin-Key` to wafle. Use a master key for full access, or a per-store key for scoped tools.

## Run

### stdio (Claude Desktop, Claude Code local)

```bash
node dist/index.js --transport=stdio
```

Logs go to **stderr**. Stdout is reserved for the JSON-RPC framing — never `console.log` from a tool handler.

### HTTP / Streamable HTTP (remote agents, web)

```bash
node dist/index.js --transport=http
```

Listens on `WAFLE_MCP_HTTP_PORT` (default `7100`). Single endpoint at `POST /mcp` per the [MCP Streamable HTTP spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http). `GET /healthz` for liveness.

Bearer auth on every request: `Authorization: Bearer <token>` where `<token>` is one of the values in `WAFLE_MCP_TOKENS`. The MCP server refuses all traffic if no tokens are configured.

## Connect Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "wafle": {
      "command": "node",
      "args": ["/absolute/path/to/wafle-mcp/dist/index.js", "--transport=stdio"],
      "env": {
        "WAFLE_API_KEY": "your-wafle-admin-key",
        "WAFLE_API_URL": "https://wafle.click/wp-json/waffle/v1",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

Restart Claude Desktop. You should see "wafle" with 63 tools in the `/mcp` panel.

There is also an example at `examples/claude-desktop-config.json`.

## Connect Claude Code

Project-scoped: drop a file at `<repo>/.mcp.json`:

```json
{
  "mcpServers": {
    "wafle": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/wafle-mcp/dist/index.js", "--transport=stdio"],
      "env": { "WAFLE_API_KEY": "your-key" }
    }
  }
}
```

User-scoped: append to `~/.claude/.mcp.json` (same shape).

For the deployed HTTP transport at `mcp.wafle.click`:

```json
{
  "mcpServers": {
    "wafle": {
      "type": "http",
      "url": "https://mcp.wafle.click/mcp",
      "headers": { "Authorization": "Bearer <bearer token>" }
    }
  }
}
```

## Tool catalogue (68)

| Domain     | Tools |
|------------|------|
| auth       | `wafle_auth_me`, `wafle_auth_keys_list`, `wafle_auth_keys_create` |
| stores     | `wafle_stores_list`, `_get`, `_create`, `_update`, `_settings_get`, `_settings_update` |
| products   | `wafle_products_list`, `_search`, `_get`, `_create_manual`, `_update`, `_override`, `_sync_trigger`, `_sync_status` |
| pricing    | `wafle_pricing_rules_list`, `_create`, `_update`, `_delete`, `wafle_pricing_compute_preview` |
| orders     | `wafle_orders_list`, `_get`, `_create`, `_ship`, `_cancel`, `_refund`, `_add_note`, `_timeline` |
| customers  | `wafle_customers_list`, `_get`, `_orders`, `_segments_list` |
| gateways   | `wafle_gateways_list`, `_create`, `_update`, `_test`, `_delete` |
| shipping   | `wafle_shipping_rates_quote`, `_carriers_status` |
| coupons    | `wafle_coupons_list`, `_create`, `_update`, `_delete` |
| abandoned  | `wafle_abandoned_list`, `_send_recovery` |
| analytics  | `wafle_analytics_summary`, `_by_period` |
| exports    | `wafle_exports_customers`, `_meta_audience`, `_google_ads` |
| pixels     | `wafle_pixels_get`, `_set` |
| system     | `wafle_system_health`, `_stores_health`, `_versions_list`, `_release_deploy`, `_release_rollback`, `_audit_query`, `_queue_stats`, `_queue_failed`, `_queue_retry` |
| meta       | `wafle_resources_invalidate`, `wafle_prompts_list`, `wafle_products_sync_trigger_and_wait`, `wafle_csv_import`, `wafle_ads_sync_full` |

Every tool has a markdown description with usage guidance, a Zod schema with `.describe()`-annotated fields, scope requirements, and `readOnlyHint`/`destructiveHint`/`idempotentHint` annotations to help the LLM pick wisely.

The long-running tools (`_sync_trigger_and_wait`, `_csv_import`, `_ads_sync_full`) emit `notifications/progress` while polling — clients that support progress (Claude Desktop) show a live progress bar.

## Resources (14)

MCP Resources expose read-only context the LLM can pull in **without spending a tool call**. Reference them with `@<uri>` in Claude Desktop or by URI in any client.

| URI | TTL | Purpose |
|---|---|---|
| `wafle://system/health` | 30s | Backend health snapshot. |
| `wafle://system/scopes-catalog` | 1h | Catalog of every API scope (domain, tier, label). |
| `wafle://docs/api-conventions` | 1h | REST canonical shapes. |
| `wafle://docs/architecture` | 1h | Architecture overview. |
| `wafle://stores` | 60s | Lean list of every store. |
| `wafle://stores/{slug}` | 60s | Full store snapshot (settings + 7d KPIs + abandoned + last order). |
| `wafle://stores/{slug}/orders/recent` | 30s | Last 20 orders with summary fields. |
| `wafle://stores/{slug}/abandoned` | 60s | Top 20 abandoned carts. |
| `wafle://stores/{slug}/analytics/7d` | 5min | 7-day analytics. |
| `wafle://stores/{slug}/analytics/30d` | 5min | 30-day analytics. |
| `wafle://stores/{slug}/products/sample` | 2min | Top 20 products. |
| `wafle://stores/{slug}/email/segments` | 60s | Customer segments. |
| `wafle://stores/{slug}/email/recent-campaigns` | 60s | Last 10 campaigns. |
| `wafle://stores/{slug}/ads/connections` | 5min | Meta/Google/TikTok connection status. |

Cache is in-memory per session, with TTL per resource. Manual invalidation: `wafle_resources_invalidate { uri_pattern }`. Long-running tools auto-invalidate the affected store.

See [`docs/RESOURCES.md`](docs/RESOURCES.md) for full details and examples.

## Prompts (5)

Server-defined parametric workflows for the most common BATTO operations. The client surfaces a picker; pick → fill args → conversation starts with a fully-rendered plan.

| Name | Use case |
|---|---|
| `onboarding_tienda_nueva` | End-to-end onboarding (store + MP + catalog + frontend API key). |
| `pedido_enviar` | Mark order shipped with tracking + customer email. |
| `segmentar_y_campania` | Build segment + create email campaign (immediate or scheduled). |
| `conectar_meta_y_sync` | Connect Meta to a store + sync catalog to Commerce Manager. |
| `debug_orden_fallida` | Diagnose failed payment + optionally retry via secondary gateway. |

See [`docs/PROMPTS.md`](docs/PROMPTS.md) for argument schemas and example invocations.

## Conversational examples

See `examples/prompts/`:

- **01-onboarding-tienda-nueva.md** — onboarding a new client end to end.
- **02-pedido-enviar.md** — single-shot logistics action.
- **03-segmentar-y-campania.md** — segment + campaign.
- **04-conectar-meta-y-sync.md** — connect Meta + catalog sync.
- **05-debug-orden-fallida.md** — payment failure diagnosis.

The 5 prompts above are converted to server-defined MCP prompts in `src/prompts/`.

## Scopes

Each tool declares a scope (e.g. `orders:write`, `gateways:admin`). At startup the server calls `wafle_auth_me` to retrieve the granted scopes; if wafle's `/auth/me` returns `type=master` we grant `ALL_SCOPES`. If it returns neither scopes nor a known type, the server runs in **warn-mode** — scope checks are skipped and a startup warning is logged.

The full matrix lives in [`src/auth/scopes.ts`](src/auth/scopes.ts).

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md). TL;DR: thin TypeScript wrapper over wafle REST, Fastify for HTTP, the official `@modelcontextprotocol/sdk`, Zod for validation, pino for logs (stderr only — required for stdio).

## Deploy

```bash
docker compose up -d
```

or with the systemd unit at `deploy/systemd/wafle-mcp.service`. The repo includes `Dockerfile` (multistage, alpine runtime) and a sample nginx config for `mcp.wafle.click`.

## Troubleshooting

- **`401 waffle_unauthorized`**: `WAFLE_API_KEY` is missing or wrong. Get the master key from the waffle container at `/root/.waffle-creds.txt`.
- **Claude Desktop says no tools**: confirm the path in `claude_desktop_config.json` is absolute and `dist/index.js` exists. Run `node dist/index.js --transport=stdio` in a terminal — if it doesn't start, fix the env first.
- **Stdout corruption**: don't `console.log` anywhere. All logs must go via `getLogger()` (which writes to stderr).
- **HTTP transport refuses traffic**: set `WAFLE_MCP_TOKENS` and pass `Authorization: Bearer <token>`.
- **Wafle says `forbidden, invalid master key`**: some endpoints (e.g. `/system/versions`) check a different key. Verify with `curl -H "X-Wafle-Admin-Key: $KEY" https://wafle.click/wp-json/waffle/v1/auth/me` first.

## Development

```bash
npm run dev          # tsx-watch, stdio
npm run dev:http     # tsx-watch, http
npm test             # vitest
npm run test:coverage
npm run lint
npm run typecheck
```

## License

MIT — see [`LICENSE`](LICENSE).
