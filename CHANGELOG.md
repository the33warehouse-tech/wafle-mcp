# Changelog

All notable changes to `@wafle/mcp` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-26

### Added

- **MCP Resources** (14 total) — read-only context the LLM consumes without spending a tool call. URIs include `wafle://system/health`, `wafle://system/scopes-catalog`, `wafle://docs/api-conventions`, `wafle://docs/architecture`, `wafle://stores`, `wafle://stores/{slug}` (full snapshot built from 4 parallel REST calls), `wafle://stores/{slug}/orders/recent`, `wafle://stores/{slug}/abandoned`, `wafle://stores/{slug}/analytics/7d`, `wafle://stores/{slug}/analytics/30d`, `wafle://stores/{slug}/products/sample`, `wafle://stores/{slug}/email/segments`, `wafle://stores/{slug}/email/recent-campaigns`, `wafle://stores/{slug}/ads/connections`. In-memory TTL cache (30s–1h per resource), in-flight coalescing, manual invalidation by URI pattern. Static URIs surface via `resources/list`; templated URIs via `resources/templates/list`.
- **MCP Prompts** (5 total) — server-defined parametric workflows: `onboarding_tienda_nueva`, `pedido_enviar`, `segmentar_y_campania`, `conectar_meta_y_sync`, `debug_orden_fallida`. Each renders a fully-formed user message with the inlined args. Snake_case-enforced names + arg names; arg length capped at 4_000 chars; required-arg validation. Available via `prompts/list` + `prompts/get`.
- **Streaming progress notifications** — `pollWithProgress` helper that polls a wafle status endpoint every 2s (configurable) and forwards each update as MCP `notifications/progress`. Used by 3 new long-running tools.
- **5 new tools**:
  - `wafle_resources_invalidate` (master) — drop the resource cache by URI substring or fully.
  - `wafle_prompts_list` — echoes the prompts catalog for clients without the Prompts API.
  - `wafle_products_sync_trigger_and_wait` — triggers + polls a catalog sync, emits progress, auto-invalidates the store cache on success.
  - `wafle_csv_import` — downloads + imports a CSV product feed; long-running with progress.
  - `wafle_ads_sync_full` — runs a full Meta/Google catalog sync, long-running with progress.
- **Documentation**: `docs/RESOURCES.md`, `docs/PROMPTS.md`, README updates with resources + prompts sections.
- **Tests**: 50 new tests across `test/resources.test.ts` (18), `test/prompts.test.ts` (17), `test/progress.test.ts` (8), `test/integration.test.ts` (7). Total 105 passing; coverage 84.97% lines.

### Changed

- `Server` now declares capabilities `{ tools, resources, prompts }` (was tools only).
- `ToolContext` extended with optional `resources` (registry handle) and `extras` (sendNotification + progressToken). Backward-compatible: every existing tool ignores them.
- `RegisteredTool.run` accepts an optional second arg with per-call extras.
- `buildServer` returns `{ server, registry, resources, prompts }` (was `{ server, registry }`). Existing callers continue to work — the new fields are additive.
- Server version bumped to 0.2.0.

### Compatibility

- 100% backward-compatible with existing MCP clients. All 63 v0.1.0 tools are unchanged in name, schema, and behavior.

## [0.1.0] - 2026-04-25

### Added
- Initial release.
- 60+ tools across `auth`, `stores`, `products`, `pricing`, `orders`, `customers`, `gateways`, `shipping`, `coupons`, `abandoned`, `analytics`, `exports`, `pixels`, `system`.
- Two transports: `stdio` (Claude Desktop, Claude Code) and HTTP+SSE (remote agents) on Fastify.
- `WafleClient` HTTP wrapper with retries (5xx/network), `Retry-After` rate-limit handling, automatic `Idempotency-Key` for POSTs, structured pino logging, request timeout.
- Scope matrix in `auth/scopes.ts` — graceful fallback to "all scopes" while wafle's `/auth/me` does not yet return scopes (warning logged once at startup).
- Bearer-token auth on HTTP transport (separate from upstream wafle key).
- Vitest test suite with HTTP-client mocks. Coverage targets: 70% lines / 90% on `client/`, `auth/`, `tools/orders` `tools/gateways`.
- Dockerfile (multi-stage), `docker-compose.yml`, systemd unit, deploy scripts.
- Documentation: `README.md`, `ARCHITECTURE.md`, conversational prompt examples.
