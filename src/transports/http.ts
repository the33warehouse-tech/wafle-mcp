/**
 * HTTP transport — Streamable HTTP (per MCP spec 2025-03-26) on Fastify.
 *
 * Endpoints
 * - POST /mcp        → JSON-RPC + SSE responses (per spec)
 * - GET  /mcp        → server-initiated SSE channel (optional)
 * - DELETE /mcp      → terminate session
 * - GET  /healthz    → liveness probe
 *
 * Auth: per-tenant JWTs (HS256, signed by the wafle backend with the shared
 * `WAFLE_MCP_JWT_SECRET`) plus an admin-tier static bearer fallback (legacy
 * `WAFLE_MCP_TOKENS`). The auth context is bound to the session at
 * `initialize` time and re-validated on every subsequent request — if a
 * token is rotated or revoked, in-flight sessions are dropped on the next
 * call.
 */
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ClientAuthValidator } from "../auth/api-keys.js";
import { authenticateRequest, type TenantAuth } from "../auth/tenant.js";
import type { Log } from "../logging.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  validator: ClientAuthValidator;
  /** Shared secret for HS256 JWT verification. Empty disables the JWT path. */
  jwtSecret: string;
  /** When true, refuse the legacy bearer fallback (recommended in prod). */
  requireJwt: boolean;
  logger: Log;
  /** Factory, so each session gets a fresh Server with its own auth context. */
  buildServer: (auth: TenantAuth) => Server;
}

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
  auth: TenantAuth;
}

export async function startHttp(opts: HttpServerOptions): Promise<FastifyInstance> {
  const { host, port, validator, jwtSecret, requireJwt, logger, buildServer } = opts;
  const sessions = new Map<string, SessionEntry>();

  const fastify = Fastify({
    logger: false, // we use our own pino root
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  });
  const allowedOrigins = (process.env.WAFLE_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  await fastify.register(cors, {
    origin: allowedOrigins.length > 0
      ? allowedOrigins
      : false, // refuse cross-origin entirely if not configured
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "Last-Event-ID"],
    exposedHeaders: ["Mcp-Session-Id"],
    maxAge: 600,
  });

  function authenticate(
    req: FastifyRequest,
  ): { ok: true; auth: TenantAuth } | { ok: false; status: number; reason: string } {
    const authHeader = req.headers["authorization"];
    const result = authenticateRequest({
      authorization: typeof authHeader === "string" ? authHeader : undefined,
      jwtSecret,
      legacyValidator: validator,
      requireJwt,
    });
    if (result.ok) return { ok: true, auth: result.auth };
    return { ok: false, status: result.failure.status, reason: result.failure.reason };
  }

  fastify.get("/healthz", async () => ({ ok: true, sessions: sessions.size, ts: Date.now() }));

  fastify.get("/", async () => ({
    name: "wafle-mcp",
    transport: "streamable-http",
    endpoints: { mcp: "/mcp", health: "/healthz" },
  }));

  // Single endpoint per the Streamable HTTP spec: handles POST (RPC) + GET (SSE) + DELETE.
  const handleMcp = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authResult = authenticate(req);
    if (!authResult.ok) {
      reply.code(authResult.status).send({
        jsonrpc: "2.0",
        error: { code: -32001, message: authResult.reason },
        id: null,
      });
      return;
    }
    const auth = authResult.auth;

    const sessionIdRaw = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;

    let entry: SessionEntry | undefined = sessionId ? sessions.get(sessionId) : undefined;

    // Re-bind: the bearer presented on subsequent requests MUST match the
    // tenant the session was opened with. This stops a session-id leak from
    // being used by a different tenant's token.
    if (entry) {
      if (entry.auth.kind !== auth.kind || entry.auth.tenantSlug !== auth.tenantSlug) {
        logger.warn(
          {
            sid: sessionId,
            sessionTenant: entry.auth.tenantSlug,
            requestTenant: auth.tenantSlug,
          },
          "mcp session token/tenant mismatch — closing session",
        );
        entry.transport.close().catch(() => undefined);
        sessions.delete(sessionId!);
        reply
          .code(401)
          .send({ jsonrpc: "2.0", error: { code: -32001, message: "Session tenant mismatch — re-initialize" }, id: null });
        return;
      }
    }

    // POST /mcp with no session ID and an `initialize` request → create a new session.
    if (!entry) {
      if (req.method !== "POST") {
        reply.code(400).send({ jsonrpc: "2.0", error: { code: -32000, message: "Missing Mcp-Session-Id" }, id: null });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          logger.info(
            { sid, kind: auth.kind, tenantSlug: auth.tenantSlug, jti: auth.jti },
            "mcp session initialized",
          );
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.info({ sid: transport.sessionId }, "mcp session closed");
        }
      };

      const server = buildServer(auth);
      await server.connect(transport);
      entry = { server, transport, auth };

      // Pipe the request into the transport. When transport assigns a session id
      // (after `initialize`), persist into the map.
      await entry.transport.handleRequest(req.raw, reply.raw, req.body);
      if (entry.transport.sessionId) {
        sessions.set(entry.transport.sessionId, entry);
      }
      return;
    }

    await entry.transport.handleRequest(req.raw, reply.raw, req.body);
  };

  fastify.post("/mcp", handleMcp);
  fastify.get("/mcp", handleMcp);
  fastify.delete("/mcp", handleMcp);

  // Legacy SSE compatibility (MCP 2024-11-05). Wafle MCP recommends Streamable HTTP, but
  // we keep an alias so older clients can probe.
  fastify.get("/mcp/sse", async (_req, reply) => {
    reply.code(410).send({ error: "Legacy /mcp/sse transport not supported; use POST /mcp with the Streamable HTTP transport." });
  });

  await fastify.listen({ host, port });
  logger.info({ host, port, url: `http://${host}:${port}` }, "wafle-mcp HTTP listening");
  return fastify;
}
