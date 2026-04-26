/**
 * API-key auth for the HTTP transport. The MCP server's clients (browser
 * agents, the Claude Code remote SSE adapter, etc.) authenticate with a
 * static bearer token configured via `WAFLE_MCP_TOKENS` (comma-separated).
 *
 * The bearer token is *not* the wafle admin key. It guards access to this
 * MCP server, which in turn uses the upstream wafle key.
 */
import { timingSafeEqual } from "node:crypto";

export interface ClientAuthValidator {
  /** Return true if the bearer token is allowed. Constant-time. */
  isValid: (token: string) => boolean;
  /** True if no tokens were configured — refuse all HTTP traffic in that case. */
  enabled: boolean;
}

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function makeValidator(rawTokens: string | undefined): ClientAuthValidator {
  const tokens = (rawTokens ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length >= 16); // min security threshold

  return {
    enabled: tokens.length > 0,
    isValid: (candidate: string): boolean => {
      if (!candidate) return false;
      for (const t of tokens) {
        if (eq(candidate, t)) return true;
      }
      return false;
    },
  };
}
