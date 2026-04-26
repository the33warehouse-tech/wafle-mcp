# `@wafle/mcp` — Model Context Protocol server for [wafle](https://wafle.click)

> The first MCP server for the wafle commerce platform. Lets Claude Desktop, Claude Code, agents, and any MCP-compatible client drive a wafle tenant — stores, products, orders, pricing, gateways, audiences, system — by talking to it.

[![tests](https://img.shields.io/badge/tests-54%20passing-brightgreen)]() [![coverage](https://img.shields.io/badge/coverage-85%25-brightgreen)]() [![tools](https://img.shields.io/badge/tools-63-blue)]()

---

## What this is

Wafle is the LLM-first multi-tenant commerce platform. Its REST API at `https://wafle.click/wp-json/waffle/v1/` does the work; this MCP server exposes that work as **63 conversational tools** an LLM can pick from. Every wafle feature should land here as a tool first, UI second.

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

## Tool catalogue (63)

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

Every tool has a markdown description with usage guidance, a Zod schema with `.describe()`-annotated fields, scope requirements, and `readOnlyHint`/`destructiveHint`/`idempotentHint` annotations to help the LLM pick wisely.

## Conversational examples

See `examples/prompts/`:

- **abrir-tienda-nueva.md** — onboarding a new client end to end.
- **marcar-pedido-enviado.md** — single-shot logistics action.
- **exportar-audiencia-meta.md** — building a Meta audience from buyers ≥ $50k last month.
- **analytics-comparativo.md** — Lensitive vs Gamerland last 30 days.
- **listar-pedidos-pendientes.md** — quick triage of pending orders.

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
