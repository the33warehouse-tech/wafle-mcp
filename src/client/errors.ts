/**
 * Errors raised by the wafle HTTP client. These map cleanly onto
 * MCP error responses: tools surface a single `WafleApiError` and
 * the registry converts it to a structured `isError: true` content
 * block with diagnostics that an LLM can read and reason over.
 */

export type WafleErrorKind =
  | "network"
  | "timeout"
  | "http_4xx"
  | "http_5xx"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation"
  | "unknown";

export interface WafleErrorBody {
  /** wafle's `code` field, e.g. `waffle_unauthorized`. */
  code?: string;
  /** wafle's `message` field. */
  message?: string;
  /** Original `data` blob from wafle (often `{ status: 401 }`). */
  data?: unknown;
}

export class WafleApiError extends Error {
  readonly kind: WafleErrorKind;
  readonly status?: number;
  readonly body?: WafleErrorBody;
  readonly path?: string;
  readonly method?: string;
  readonly retryAfterMs?: number;

  constructor(opts: {
    kind: WafleErrorKind;
    message: string;
    status?: number;
    body?: WafleErrorBody;
    path?: string;
    method?: string;
    retryAfterMs?: number;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = "WafleApiError";
    this.kind = opts.kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.body !== undefined) this.body = opts.body;
    if (opts.path !== undefined) this.path = opts.path;
    if (opts.method !== undefined) this.method = opts.method;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }

  toLLMPayload(): { error: string; kind: WafleErrorKind; status?: number; code?: string; details?: unknown } {
    const payload: { error: string; kind: WafleErrorKind; status?: number; code?: string; details?: unknown } = {
      error: this.message,
      kind: this.kind,
    };
    if (this.status !== undefined) payload.status = this.status;
    if (this.body?.code !== undefined) payload.code = this.body.code;
    if (this.body?.data !== undefined) payload.details = this.body.data;
    return payload;
  }
}

export function classifyHttp(status: number): WafleErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "unknown";
}
