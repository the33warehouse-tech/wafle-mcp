#!/usr/bin/env node
/**
 * wafle-mcp entrypoint.
 *
 * Usage:
 *   wafle-mcp --transport=stdio   (Claude Desktop / Claude Code)
 *   wafle-mcp --transport=http    (Fastify on $WAFLE_MCP_HTTP_PORT, default 7100)
 *
 * Environment
 *   WAFLE_API_URL          REST base, default https://wafle.click/wp-json/waffle/v1
 *   WAFLE_API_KEY          REQUIRED. Sent as X-Wafle-Admin-Key.
 *   WAFLE_TIMEOUT_MS       upstream timeout, default 30000
 *   WAFLE_MCP_HTTP_HOST    bind host for http transport, default 0.0.0.0
 *   WAFLE_MCP_HTTP_PORT    bind port for http transport, default 7100
 *   WAFLE_MCP_TOKENS       comma-separated bearer tokens for http clients
 *   LOG_LEVEL              pino level, default info
 */
import process from "node:process";
import { WafleClient } from "./client/wafle-client.js";
import { buildServer } from "./server.js";
import { startStdio } from "./transports/stdio.js";
import { startHttp } from "./transports/http.js";
import { getLogger } from "./logging.js";
import { makeValidator } from "./auth/api-keys.js";
import { ALL_SCOPES, expandGranted, type Scope } from "./auth/scopes.js";

interface CliArgs {
  transport: "stdio" | "http";
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let transport: CliArgs["transport"] = "stdio";
  let help = false;
  let version = false;
  for (const a of argv.slice(2)) {
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-v") version = true;
    else if (a.startsWith("--transport=")) {
      const v = a.slice("--transport=".length);
      if (v !== "stdio" && v !== "http") {
        throw new Error(`Unknown transport: ${v}`);
      }
      transport = v;
    } else if (a === "--stdio") transport = "stdio";
    else if (a === "--http") transport = "http";
  }
  return { transport, help, version };
}

function printHelp(): void {
  process.stderr.write(
    `wafle-mcp — MCP server for the wafle commerce platform.

Usage:
  wafle-mcp [--transport=stdio|http]

Environment:
  WAFLE_API_URL, WAFLE_API_KEY (required), WAFLE_TIMEOUT_MS,
  WAFLE_MCP_HTTP_HOST, WAFLE_MCP_HTTP_PORT, WAFLE_MCP_TOKENS,
  LOG_LEVEL.
`,
  );
}

async function detectScopes(client: WafleClient, log: ReturnType<typeof getLogger>): Promise<Set<Scope> | null> {
  try {
    const me = (await client.get<{
      ok?: boolean;
      type?: string;
      is_master?: boolean;
      scopes?: string[];
    }>("/auth/me")) ?? {};
    const isMaster = me.is_master === true || me.type === "master";
    const hasWildcard = Array.isArray(me.scopes) && me.scopes.includes("*");
    if (isMaster || hasWildcard) {
      log.info({ master: isMaster, wildcard: hasWildcard }, "master/wildcard key detected — granting all scopes");
      return expandGranted(ALL_SCOPES);
    }
    if (Array.isArray(me.scopes) && me.scopes.length) {
      // Filter out unknown scopes (forward-compat: wafle may add new scopes faster than us).
      const known: Scope[] = [];
      const unknown: string[] = [];
      const allSet = new Set<string>(ALL_SCOPES);
      for (const s of me.scopes) {
        if (allSet.has(s)) known.push(s as Scope);
        else unknown.push(s);
      }
      if (unknown.length) {
        log.warn({ unknown }, "wafle /auth/me returned unknown scope names — ignoring them");
      }
      const granted = expandGranted(known);
      log.info({ count: granted.size }, "scopes detected from /auth/me");
      return granted;
    }
    log.warn({ me }, "wafle /auth/me did not return scopes; running in warn-mode (no scope checks)");
    return null;
  } catch (err) {
    log.error({ err: (err as Error).message }, "wafle /auth/me failed during scope detection — warn-mode");
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    process.stderr.write(`wafle-mcp 0.1.0\n`);
    return;
  }

  const log = getLogger();
  const apiKey = process.env["WAFLE_API_KEY"];
  const apiUrl = process.env["WAFLE_API_URL"] ?? "https://wafle.click/wp-json/waffle/v1";
  if (!apiKey) {
    log.fatal("WAFLE_API_KEY is required");
    process.exit(2);
  }
  const timeoutMs = Number(process.env["WAFLE_TIMEOUT_MS"] ?? 30_000);

  const client = new WafleClient({
    baseUrl: apiUrl,
    apiKey,
    timeoutMs,
    logger: log.child({ component: "wafle-client" }),
  });

  const grantedScopes = await detectScopes(client, log);

  if (args.transport === "stdio") {
    const { server } = buildServer({ client, logger: log, grantedScopes });
    await startStdio(server, log);
  } else {
    const host = process.env["WAFLE_MCP_HTTP_HOST"] ?? "0.0.0.0";
    const port = Number(process.env["WAFLE_MCP_HTTP_PORT"] ?? 7100);
    const validator = makeValidator(process.env["WAFLE_MCP_TOKENS"]);
    if (!validator.enabled) {
      log.warn(
        "WAFLE_MCP_TOKENS is empty — HTTP transport will refuse all traffic. Set tokens before exposing.",
      );
    }
    await startHttp({
      host,
      port,
      validator,
      logger: log,
      buildServer: () => buildServer({ client, logger: log, grantedScopes }).server,
    });
  }
}

main().catch((err) => {
  // Use stderr directly: logger may not be ready.
  process.stderr.write(`wafle-mcp fatal: ${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
