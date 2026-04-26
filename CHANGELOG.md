# Changelog

All notable changes to `@wafle/mcp` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
