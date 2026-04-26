/**
 * Build the MCP Server, wire up tool handlers, and return both the SDK
 * `Server` instance and our `ToolRegistry` so transports can introspect.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { WafleClient } from "./client/wafle-client.js";
import { createRegistry } from "./tools/index.js";
import { ToolRegistry } from "./tools/registry.js";
import { ALL_SCOPES, expandGranted, type Scope } from "./auth/scopes.js";
import { type Log, child } from "./logging.js";

export interface BuildServerOptions {
  client: WafleClient;
  logger: Log;
  /** If null, every scope is granted (warn-mode while wafle/auth/me lacks scopes). */
  grantedScopes: Set<Scope> | null;
  serverName?: string;
  serverVersion?: string;
}

export interface BuiltServer {
  server: Server;
  registry: ToolRegistry;
}

export function buildServer(opts: BuildServerOptions): BuiltServer {
  const log = child({ component: "mcp-server" });
  const registry = createRegistry({
    client: opts.client,
    log: opts.logger,
    grantedScopes: opts.grantedScopes,
  });

  const server = new Server(
    {
      name: opts.serverName ?? "wafle-mcp",
      version: opts.serverVersion ?? "0.1.0",
    },
    {
      capabilities: {
        tools: { listChanged: false },
        // Future: resources for store snapshots, prompts for common workflows.
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: McpTool[] = registry.list().map((t) => {
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
    log.debug({ count: tools.length }, "listTools");
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = registry.get(name);
    if (!tool) {
      log.warn({ name }, "callTool unknown");
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    log.info({ name }, "callTool");
    const result = await tool.run(args);
    return {
      isError: result.isError,
      content: result.content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
  });

  return { server, registry };
}

export { ALL_SCOPES, expandGranted };
