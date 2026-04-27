/**
 * WafleClient — typed HTTP wrapper for the wafle REST API.
 *
 * Design notes
 * - Uses native `fetch` (Node 20+) so no third-party HTTP lib.
 * - Retries 5xx and network errors with exponential backoff (3 attempts).
 *   Rate-limit responses (429) honor `Retry-After`.
 * - Never retries 4xx (except 429): those are the caller's problem.
 * - Adds `Idempotency-Key` automatically on POSTs unless the caller provides one.
 * - Surfaces structured `WafleApiError` so tools render rich diagnostics.
 * - Logs every request via the supplied logger child.
 */
import { v7 as uuidv7 } from "uuid";
import { type Log, child as childLogger } from "../logging.js";
import { WafleApiError, type WafleErrorBody, classifyHttp } from "./errors.js";

export interface WafleClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  userAgent?: string;
  /** Max retries for 5xx and network errors. Default 3. */
  maxRetries?: number;
  /** Logger to use; falls back to a child of the root logger. */
  logger?: Log;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  /** UUIDv7 string. Auto-generated for POSTs if absent. */
  idempotencyKey?: string;
  /** Override per-request timeout. */
  timeoutMs?: number;
  /** Per-request retry override. */
  maxRetries?: number;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Query params. Values are stringified; arrays repeat the key. */
  query?: Record<string, string | number | boolean | undefined | null | (string | number)[]>;
  /** Signal to abort externally (combined with timeout). */
  signal?: AbortSignal;
}

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
]);

function buildQueryString(query?: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      for (const v of raw) params.append(key, String(v));
    } else {
      params.set(key, String(raw));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function jitter(baseMs: number): number {
  // Full jitter: random in [0, base]
  return Math.floor(Math.random() * baseMs);
}

export class WafleClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly log: Log;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WafleClientOptions) {
    if (!opts.baseUrl) throw new Error("WafleClient: baseUrl is required");
    if (!opts.apiKey) throw new Error("WafleClient: apiKey is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "wafle-mcp/0.2";
    this.maxRetries = opts.maxRetries ?? 3;
    this.log = opts.logger ?? childLogger({ component: "wafle-client" });
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, opts);
  }

  async post<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, body, opts);
  }

  async patch<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PATCH", path, body, opts);
  }

  async put<T>(path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("PUT", path, body, opts);
  }

  async delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("DELETE", path, undefined, opts);
  }

  async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}${buildQueryString(opts.query)}`;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
      "X-Wafle-Admin-Key": this.apiKey,
      ...(opts.headers ?? {}),
    };
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
    }
    if (method === "POST") {
      headers["Idempotency-Key"] = opts.idempotencyKey ?? uuidv7();
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const externalAbort = opts.signal
        ? () => controller.abort(opts.signal!.reason)
        : null;
      if (externalAbort && opts.signal) opts.signal.addEventListener("abort", externalAbort);

      const start = Date.now();
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const ms = Date.now() - start;
        let parsed: unknown;
        const text = await res.text();
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            // The waffle backend currently prepends a stray bash error line
            // ("/etc/bash.bashrc: line 74: syntax error...") before the JSON
            // body. Recover by stripping anything before the first `{` or `[`
            // and retrying. If that still fails, pass through as raw text
            // (genuine non-JSON endpoints, e.g. CSV exports, rely on this).
            const firstBrace = text.indexOf("{");
            const firstBracket = text.indexOf("[");
            const candidates = [firstBrace, firstBracket].filter((i) => i >= 0);
            const start = candidates.length > 0 ? Math.min(...candidates) : -1;
            if (start > 0) {
              try {
                parsed = JSON.parse(text.slice(start));
              } catch {
                parsed = text;
              }
            } else {
              parsed = text;
            }
          }
        }

        if (res.ok) {
          this.log.debug({ method, path, status: res.status, ms, attempt }, "wafle ok");
          return parsed as T;
        }

        const errorBody: WafleErrorBody | undefined =
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as WafleErrorBody)
            : undefined;
        const kind = classifyHttp(res.status);

        // Retry only on 5xx or 429.
        if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
          const retryAfterHeader = res.headers.get("retry-after");
          const retryAfterMs = retryAfterHeader
            ? Math.max(0, Number(retryAfterHeader) * 1000)
            : null;
          const backoff =
            retryAfterMs ?? Math.min(8_000, jitter(500 * Math.pow(2, attempt)));
          this.log.warn(
            { method, path, status: res.status, ms, attempt, backoff },
            "wafle retrying",
          );
          await sleep(backoff);
          continue;
        }

        const err = new WafleApiError({
          kind,
          status: res.status,
          message:
            errorBody?.message ??
            `wafle ${method} ${path} failed with HTTP ${res.status}`,
          body: errorBody,
          path,
          method,
        });
        this.log.warn(
          { method, path, status: res.status, ms, code: errorBody?.code },
          "wafle error",
        );
        throw err;
      } catch (err: unknown) {
        if (err instanceof WafleApiError) throw err;
        const ms = Date.now() - start;
        const e = err as { name?: string; code?: string; message?: string };
        const isAbort = e?.name === "AbortError";
        const isNetwork = e?.code !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(e.code);

        if ((isAbort || isNetwork) && attempt < maxRetries) {
          const backoff = Math.min(8_000, jitter(500 * Math.pow(2, attempt)));
          this.log.warn({ method, path, ms, attempt, backoff, isAbort, code: e?.code }, "wafle retrying network");
          await sleep(backoff);
          lastError = err;
          continue;
        }

        if (isAbort) {
          throw new WafleApiError({
            kind: "timeout",
            message: `wafle ${method} ${path} timed out after ${timeoutMs}ms`,
            path,
            method,
            cause: err,
          });
        }
        throw new WafleApiError({
          kind: "network",
          message: `wafle ${method} ${path} network error: ${e?.message ?? "unknown"}`,
          path,
          method,
          cause: err,
        });
      } finally {
        clearTimeout(timeout);
        if (externalAbort && opts.signal) opts.signal.removeEventListener("abort", externalAbort);
      }
    }

    // Loop shouldn't exit without returning or throwing, but TS needs a fallback.
    throw new WafleApiError({
      kind: "unknown",
      message: `wafle ${method} ${path} exhausted retries`,
      path,
      method,
      cause: lastError,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
