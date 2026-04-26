/**
 * HTTP transport — Streamable HTTP (per MCP spec 2025-03-26) on Fastify.
 *
 * Endpoints
 * - POST /mcp        → JSON-RPC + SSE responses (per spec)
 * - GET  /mcp        → server-initiated SSE channel (optional)
 * - DELETE /mcp      → terminate session
 * - GET  /healthz    → liveness probe
 *
 * Auth: Bearer token from `WAFLE_MCP_TOKENS` (comma-separated). Refuses
 * traffic if no tokens are configured, to avoid an accidental open relay.
 */
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ClientAuthValidator } from "../auth/api-keys.js";
import type { Log } from "../logging.js";

export interface HttpServerOptions {
  host: string;
  port: number;
  validator: ClientAuthValidator;
  logger: Log;
  buildServer: () => Server; // Factory, so each session gets a fresh Server.
}

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

export async function startHttp(opts: HttpServerOptions): Promise<FastifyInstance> {
  const { host, port, validator, logger, buildServer } = opts;
  const sessions = new Map<string, SessionEntry>();

  const fastify = Fastify({
    logger: false, // we use our own pino root
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  });
  await fastify.register(cors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "Last-Event-ID"],
    exposedHeaders: ["Mcp-Session-Id"],
    credentials: false,
  });

  function authenticate(req: FastifyRequest): { ok: true } | { ok: false; status: number; reason: string } {
    if (!validator.enabled) {
      return { ok: false, status: 503, reason: "MCP server has no bearer tokens configured (WAFLE_MCP_TOKENS empty); refusing traffic." };
    }
    const auth = req.headers["authorization"];
    if (!auth || typeof auth !== "string") {
      return { ok: false, status: 401, reason: "Missing Authorization: Bearer <token>" };
    }
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m || !m[1]) return { ok: false, status: 401, reason: "Malformed Authorization header" };
    if (!validator.isValid(m[1])) return { ok: false, status: 403, reason: "Invalid bearer token" };
    return { ok: true };
  }

  fastify.get("/healthz", async () => ({ ok: true, sessions: sessions.size, ts: Date.now() }));

  fastify.get("/", async () => ({
    name: "wafle-mcp",
    transport: "streamable-http",
    endpoints: { mcp: "/mcp", health: "/healthz" },
  }));

  // Single endpoint per the Streamable HTTP spec: handles POST (RPC) + GET (SSE) + DELETE.
  const handleMcp = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      reply.code(auth.status).send({ jsonrpc: "2.0", error: { code: -32001, message: auth.reason }, id: null });
      return;
    }

    const sessionIdRaw = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdRaw) ? sessionIdRaw[0] : sessionIdRaw;

    let entry: SessionEntry | undefined = sessionId ? sessions.get(sessionId) : undefined;

    // POST /mcp with no session ID and an `initialize` request → create a new session.
    if (!entry) {
      if (req.method !== "POST") {
        reply.code(400).send({ jsonrpc: "2.0", error: { code: -32000, message: "Missing Mcp-Session-Id" }, id: null });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          logger.info({ sid }, "mcp session initialized");
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          logger.info({ sid: transport.sessionId }, "mcp session closed");
        }
      };

      const server = buildServer();
      await server.connect(transport);
      entry = { server, transport };

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
