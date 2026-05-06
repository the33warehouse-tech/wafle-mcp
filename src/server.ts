/**
 * Build the MCP Server, wire up tool / resource / prompt handlers, and
 * return both the SDK `Server` instance and our registries so transports
 * can introspect.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { WafleClient } from "./client/wafle-client.js";
import { createRegistry } from "./tools/index.js";
import { ToolRegistry, type ToolContext } from "./tools/registry.js";
import { createResourceRegistry, ResourceRegistry } from "./resources/index.js";
import { createPromptRegistry, PromptRegistry } from "./prompts/index.js";
import { ALL_SCOPES, expandGranted, type Scope } from "./auth/scopes.js";
import type { TenantAuth } from "./auth/tenant.js";
import { type Log, child } from "./logging.js";

export interface BuildServerOptions {
  client: WafleClient;
  logger: Log;
  /** If null, every scope is granted (warn-mode while wafle/auth/me lacks scopes). */
  grantedScopes: Set<Scope> | null;
  /**
   * MCP-tier auth: tenant binding + scopes. When null, the server runs in
   * stdio/admin mode (single-user) and exposes all tools.
   */
  tenantAuth?: TenantAuth | null;
  serverName?: string;
  serverVersion?: string;
}

export interface BuiltServer {
  server: Server;
  registry: ToolRegistry;
  resources: ResourceRegistry;
  prompts: PromptRegistry;
}

export function buildServer(opts: BuildServerOptions): BuiltServer {
  const log = child({ component: "mcp-server" });
  const tenantAuth = opts.tenantAuth ?? null;
  const sharedCtx: Pick<ToolContext, "client" | "log" | "grantedScopes" | "tenantAuth"> = {
    client: opts.client,
    log: opts.logger,
    grantedScopes: opts.grantedScopes,
    tenantAuth,
  };
  const resources = createResourceRegistry(sharedCtx);
  const prompts = createPromptRegistry();
  const registry = createRegistry({ ...sharedCtx, resources });

  const server = new Server(
    {
      name: opts.serverName ?? "wafle-mcp",
      version: opts.serverVersion ?? "0.2.0",
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
    },
  );

  // -------------- tools --------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Tenant clients never see admin-only tools; they're filtered server-side
    // so the LLM doesn't even know they exist.
    const visible = tenantAuth
      ? registry.listForCaller(tenantAuth.scopes)
      : registry.list();
    const tools: McpTool[] = visible.map((t) => {
      const out: McpTool = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchemaJson as McpTool["inputSchema"],
        annotations: t.annotations as McpTool["annotations"],
      };
      if (t.outputSchemaJson) {
        out.outputSchema = t.outputSchemaJson as McpTool["outputSchema"];
      }
      return out;
    });
    log.debug({ count: tools.length, total: registry.size(), tenantSlug: tenantAuth?.tenantSlug ?? null }, "listTools");
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    const tool = registry.get(name);
    if (!tool) {
      log.warn({ name }, "callTool unknown");
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    // Tenant tokens cannot call admin-only tools, even if they discover
    // the name out-of-band — return the same shape as `unknown tool` so we
    // don't leak the existence of admin tools to non-admin clients.
    if (
      tenantAuth &&
      tool.requiredMcpScope === "mcp:admin" &&
      !tenantAuth.scopes.includes("mcp:admin")
    ) {
      log.warn({ name, tenantSlug: tenantAuth.tenantSlug }, "callTool admin-only denied");
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    log.info({ name, tenantSlug: tenantAuth?.tenantSlug ?? null }, "callTool");
    // Pass `sendNotification` and `_meta` through to long-running tools so
    // they can emit `notifications/progress`. Passed via the runtime extras
    // so simple tools can ignore them.
    const sendNotification = extra && typeof extra === "object" && "sendNotification" in extra
      ? (extra as { sendNotification?: (n: unknown) => Promise<void> }).sendNotification
      : undefined;
    const progressToken = req.params._meta && typeof req.params._meta === "object" && "progressToken" in req.params._meta
      ? (req.params._meta as { progressToken?: string | number }).progressToken
      : undefined;
    const result = await tool.run(args, {
      ...(sendNotification !== undefined ? { sendNotification } : {}),
      ...(progressToken !== undefined ? { progressToken } : {}),
    });
    return {
      isError: result.isError,
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  });

  // -------------- resources --------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const all = resources.list();
    // Static URIs go to `resources`; templates go to `resources/templates`.
    const out = all
      .filter((r) => !r.isTemplate)
      .map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    log.debug({ count: out.length }, "listResources");
    return { resources: out };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const all = resources.list();
    const out = all
      .filter((r) => r.isTemplate)
      .map((r) => ({
        uriTemplate: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    log.debug({ count: out.length }, "listResourceTemplates");
    return { resourceTemplates: out };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    log.info({ uri }, "readResource");
    try {
      const { body, mimeType } = await resources.read(uri);
      return {
        contents: [
          {
            uri,
            mimeType,
            text: body,
          },
        ],
      };
    } catch (err) {
      const e = err as Error;
      log.warn({ uri, err: e.message }, "readResource failed");
      // Return an error contents entry rather than throwing — keeps the
      // protocol layer happy and gives the LLM something to reason about.
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ error: e.message ?? String(err) }, null, 2),
          },
        ],
      };
    }
  });

  // -------------- prompts --------------

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const out = prompts.list();
    log.debug({ count: out.length }, "listPrompts");
    return { prompts: out };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    log.info({ name }, "getPrompt");
    try {
      const result = prompts.get(name, args ?? {});
      // The SDK's response type union includes a Task variant we don't use;
      // our shape matches the non-task `GetPromptResult`. Cast through unknown.
      return result as unknown as { description?: string; messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }> };
    } catch (err) {
      const e = err as Error;
      log.warn({ name, err: e.message }, "getPrompt failed");
      throw err;
    }
  });

  return { server, registry, resources, prompts };
}

export { ALL_SCOPES, expandGranted };
