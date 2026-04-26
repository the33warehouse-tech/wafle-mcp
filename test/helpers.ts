import { vi, expect } from "vitest";
import { WafleClient } from "../src/client/wafle-client.js";
import { ToolRegistry, type ToolContext, type WafleTool } from "../src/tools/registry.js";
import { expandGranted, ALL_SCOPES } from "../src/auth/scopes.js";
import pino from "pino";

/** A pino logger that swallows everything (silent in tests). */
export function silentLogger() {
  return pino({ level: "silent" });
}

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockFetch {
  fetch: typeof fetch;
  /** Records of every call: { method, url, body, headers }. */
  calls: Array<{ method: string; url: string; body: string | undefined; headers: Record<string, string> }>;
  /** Push a response for the next request. */
  push: (res: MockResponse) => void;
  /** Push an error to be thrown for the next request. */
  pushError: (err: { code?: string; name?: string; message?: string }) => void;
}

export function makeFetchMock(): MockFetch {
  const queue: Array<MockResponse | { error: { code?: string; name?: string; message?: string } }> = [];
  const calls: MockFetch["calls"] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body as string | undefined;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    }
    calls.push({ method, url, body, headers });
    const next = queue.shift();
    if (!next) throw new Error(`mock fetch: no response queued for ${method} ${url}`);
    if ("error" in next) {
      const e = new Error(next.error.message ?? "mock network error");
      Object.assign(e, next.error);
      throw e;
    }
    const status = next.status ?? 200;
    const responseBody =
      typeof next.body === "string"
        ? next.body
        : next.body === undefined
          ? ""
          : JSON.stringify(next.body);
    return new Response(responseBody, {
      status,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  });
  return {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    push: (res) => queue.push(res),
    pushError: (err) => queue.push({ error: err }),
  };
}

export function makeClient(opts?: { fetchImpl?: typeof fetch; maxRetries?: number; timeoutMs?: number }) {
  const fetchImpl = opts?.fetchImpl ?? makeFetchMock().fetch;
  return new WafleClient({
    baseUrl: "https://test.local/api",
    apiKey: "test-key",
    fetchImpl,
    logger: silentLogger() as unknown as ReturnType<typeof pino>,
    maxRetries: opts?.maxRetries ?? 0,
    timeoutMs: opts?.timeoutMs ?? 5000,
  });
}

export function makeRegistry(tools: WafleTool[], client: WafleClient) {
  const ctx: ToolContext = {
    client,
    log: silentLogger() as unknown as ToolContext["log"],
    grantedScopes: expandGranted(ALL_SCOPES),
  };
  const r = new ToolRegistry(ctx);
  for (const t of tools) r.register(t);
  return r;
}

export { expect };
