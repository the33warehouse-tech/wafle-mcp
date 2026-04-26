# Architecture

This document explains the design decisions behind `@wafle/mcp`. It is short on purpose — the codebase is small, and clarity matters more than depth.

## Why TypeScript when the rest of wafle is JS

Tools have inputs that the LLM constructs. Bugs in the schema layer show up as cryptic 422s halfway through a conversation, with no stack trace the user can act on. Strict TypeScript + Zod catches them at build time and at runtime, before the upstream call. The MCP boundary is precisely the place where the cost of `any` is highest.

The compiled output is plain JS — wafle's other packages can consume it without TS toolchain work.

## Why Fastify

We need an HTTP transport for remote agents. Fastify is small (no Express middleware sprawl), fast, has good TypeScript types, and integrates cleanly with `pino`. The single `POST /mcp` endpoint that the MCP Streamable HTTP transport requires is trivial to express. CORS via `@fastify/cors`, no other server middleware needed.

We do **not** use Express despite the SDK shipping an `express.ts` helper. Fastify gives us better defaults and we already use pino.

## Why a custom `WafleClient` instead of `axios`/`got`/`undici` directly

Three things we always want and that no off-the-shelf wrapper gives us together:

1. **Idempotency-Key** auto-set on every POST (UUIDv7).
2. **Retry semantics tied to the contract**: 5xx and network errors retry; 4xx never retries; 429 honors `Retry-After`. This is wafle's spec, not a generic HTTP rule.
3. **Structured `WafleApiError`** that maps directly into the MCP `isError: true` content payload — the LLM sees `{kind, status, code, details}` not a string blob.

Native `fetch` is enough; a 200-line wrapper is the right shape.

## Why scopes, even before wafle returns them

Two reasons:

1. The matrix is forward-compatible: when wafle's `/auth/me` starts returning `scopes: [...]` we flip a switch and zero-trust kicks in. No tool changes required.
2. Authoring discipline: every tool author has to declare its scope. That's a forcing function for thinking about blast radius. `system_release_deploy` is `system:admin` not `orders:write`, and the matrix in `src/auth/scopes.ts` is the single source of truth.

While wafle hasn't shipped scope reporting we run in **warn-mode** (`grantedScopes = null` skips checks) with a one-line startup warning.

## Why no SWR / caching layer here

Caching belongs upstream of the MCP server (CDN / wafle response cache) or downstream (the LLM client's own context). Adding a cache here would create staleness bugs at the boundary where the LLM expects the most recent state. Tools default to read-through with retries and that is enough.

## Why pino → stderr (not stdout)

The stdio transport multiplexes JSON-RPC over stdout. Any extra byte on stdout corrupts the wire. pino with `pino.destination({ dest: 2 })` writes to stderr, which is invisible to the protocol but still captured by Claude Desktop's logs and any process supervisor. **No `console.log` anywhere in the codebase.**

## Why one `Server` per session in HTTP transport

The MCP SDK's `Server` is stateful per session (capabilities, subscriptions, requests in flight). Sharing one across sessions creates cross-session bleed when one client cancels. Wafle's HTTP transport spawns a fresh `Server` for each `initialize` request and keeps it alive until the session terminates.

## Why Zod schemas with `.describe()` instead of plain JSON Schema

The LLM reads the description on every field. `.describe()` keeps schema and prose in the same place; `zod-to-json-schema` emits the JSON Schema the SDK needs at registration time. Single source of truth.

## How to add a new tool

1. Pick a domain file in `src/tools/<domain>.ts` (or create a new one and add it to `src/tools/index.ts`).
2. Append to the `domainTools: WafleTool[]` array:
   ```ts
   {
     name: "wafle_<domain>_<verb>",
     description: "<markdown: what it does, when to use, when NOT to>",
     inputSchema: z.object({ ... }),
     scopes: ["<scope>"],
     annotations: { readOnlyHint?: true, destructiveHint?: true, idempotentHint?: true },
     handler: async (input, ctx) => ctx.client.<method>("/path"),
   }
   ```
3. Add a happy-path test in `test/tools.test.ts` (and an error path if non-trivial).
4. `npm run build && npm test`.
5. `git commit` per the project's "commit per change" rule.

If wafle's REST doesn't yet support what you need, **stop**. File it as a wafle backend ticket. Do not invent business logic in this package.

## File tree (essentials)

```
src/
  index.ts               entrypoint, argv parsing, scope detection
  server.ts              factory: Server + ToolRegistry wiring
  logging.ts             pino → stderr, redaction
  client/
    wafle-client.ts      retries, idempotency-key, error mapping
    errors.ts            WafleApiError + classifyHttp
  auth/
    scopes.ts            scope matrix + transitive expansion
    api-keys.ts          bearer-token validator (HTTP transport)
  tools/
    registry.ts          ToolRegistry: input validation, scope check, error wrap
    index.ts             aggregate every domain
    <domain>.ts          one file per domain, exports WafleTool[]
  schemas/
    common.ts            shared Zod fragments
  transports/
    stdio.ts             one-liner over StdioServerTransport
    http.ts              Fastify + StreamableHTTPServerTransport
test/                    vitest suite (54 tests)
deploy/                  Dockerfile, compose, systemd
examples/                claude-desktop-config.json + conversational prompts
```

## What is intentionally NOT here (yet)

- **Resources**: MCP supports server-published resources (e.g. a JSON snapshot of a store). Future work.
- **Prompts**: MCP also supports server-defined prompt templates. The most common workflows in `examples/prompts/` should graduate to first-class MCP prompts later.
- **Webhook receivers**: wafle webhooks are MP/Stripe inbound; they don't belong on an MCP control plane.
- **Streaming progress**: long-running tools (catalog sync) currently return job ids and the LLM polls. Once the SDK's progress notifications stabilize we can stream.
- **Per-tenant rate limiting**: relying on wafle's upstream limits for now.
