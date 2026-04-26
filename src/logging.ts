/**
 * Structured logging via pino.
 *
 * IMPORTANT for stdio transport: pino MUST write to stderr, never stdout.
 * stdout on stdio is reserved for the JSON-RPC framing — any extra bytes
 * there will corrupt the protocol and break Claude Desktop.
 */
import pino, { type Logger } from "pino";

export type Log = Logger;

let rootLogger: Log | null = null;

export function getLogger(): Log {
  if (rootLogger) return rootLogger;

  const level = process.env.LOG_LEVEL ?? "info";
  const isProd = process.env.NODE_ENV === "production";

  // Always write to stderr (fd 2). Never stdout in stdio transport.
  const dest = pino.destination({ dest: 2, sync: false });

  rootLogger = pino(
    {
      level,
      base: { name: "wafle-mcp" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "headers.authorization",
          'headers["x-wafle-admin-key"]',
          "*.apiKey",
          "*.api_key",
          "*.access_token",
          "*.accessToken",
          "*.secret",
          "*.password",
          "creds.access_token",
          "creds.client_secret",
        ],
        censor: "[redacted]",
      },
      ...(isProd
        ? {}
        : {
            transport: undefined, // pretty handled by pino-pretty CLI in dev if desired
          }),
    },
    dest,
  );

  return rootLogger;
}

export function child(bindings: Record<string, unknown>): Log {
  return getLogger().child(bindings);
}
