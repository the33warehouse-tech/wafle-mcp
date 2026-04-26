/**
 * Stdio transport — used by Claude Desktop and Claude Code's local launcher.
 * stdout is reserved for JSON-RPC; logs go to stderr (handled in logging.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Log } from "../logging.js";

export async function startStdio(server: Server, log: Log): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("stdio transport connected");
}
