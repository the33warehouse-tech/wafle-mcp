import { describe, it, expect } from "vitest";
import { WafleClient } from "../src/client/wafle-client.js";
import { WafleApiError } from "../src/client/errors.js";
import { makeFetchMock, silentLogger } from "./helpers.js";

function client(fetchImpl: typeof fetch, opts: Partial<ConstructorParameters<typeof WafleClient>[0]> = {}) {
  return new WafleClient({
    baseUrl: "https://x.local/api",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger() as never,
    maxRetries: 0,
    timeoutMs: 1000,
    ...opts,
  });
}

describe("WafleClient", () => {
  it("requires baseUrl and apiKey", () => {
    expect(() => new WafleClient({ baseUrl: "", apiKey: "k" })).toThrow();
    expect(() => new WafleClient({ baseUrl: "https://x", apiKey: "" })).toThrow();
  });

  it("GET parses JSON and sets X-Wafle-Admin-Key", async () => {
    const m = makeFetchMock();
    m.push({ body: { ok: true, type: "master" } });
    const c = client(m.fetch);
    const r = await c.get<{ ok: boolean }>("/auth/me");
    expect(r.ok).toBe(true);
    expect(m.calls[0]!.method).toBe("GET");
    expect(m.calls[0]!.url).toBe("https://x.local/api/auth/me");
    expect(m.calls[0]!.headers["x-wafle-admin-key"]).toBe("k");
  });

  it("encodes query params with arrays repeating", async () => {
    const m = makeFetchMock();
    m.push({ body: {} });
    const c = client(m.fetch);
    await c.get("/orders", { query: { status: ["pending", "paid"], page: 2, skip: undefined } });
    expect(m.calls[0]!.url).toBe("https://x.local/api/orders?status=pending&status=paid&page=2");
  });

  it("POST adds Idempotency-Key automatically", async () => {
    const m = makeFetchMock();
    m.push({ body: { id: 1 } });
    const c = client(m.fetch);
    await c.post("/orders", { foo: 1 });
    const headers = m.calls[0]!.headers;
    expect(headers["idempotency-key"]).toMatch(/[0-9a-f-]{20,}/);
    expect(headers["content-type"]).toBe("application/json");
    expect(m.calls[0]!.body).toBe('{"foo":1}');
  });

  it("POST honors caller-provided Idempotency-Key", async () => {
    const m = makeFetchMock();
    m.push({ body: {} });
    const c = client(m.fetch);
    await c.post("/orders", { x: 1 }, { idempotencyKey: "abc" });
    expect(m.calls[0]!.headers["idempotency-key"]).toBe("abc");
  });

  it("4xx throws WafleApiError without retrying", async () => {
    const m = makeFetchMock();
    m.push({ status: 401, body: { code: "waffle_unauthorized", message: "Missing X-Wafle-Admin-Key", data: { status: 401 } } });
    const c = client(m.fetch, { maxRetries: 3 });
    await expect(c.get("/auth/me")).rejects.toMatchObject({
      name: "WafleApiError",
      kind: "unauthorized",
      status: 401,
    });
    expect(m.calls.length).toBe(1); // no retry on 4xx
  });

  it("5xx retries and then succeeds", async () => {
    const m = makeFetchMock();
    m.push({ status: 503, body: { message: "down" } });
    m.push({ status: 200, body: { ok: true } });
    const c = client(m.fetch, { maxRetries: 2 });
    const r = await c.get<{ ok: boolean }>("/health");
    expect(r.ok).toBe(true);
    expect(m.calls.length).toBe(2);
  });

  it("429 retries and respects Retry-After (seconds)", async () => {
    const m = makeFetchMock();
    m.push({ status: 429, body: { message: "slow down" }, headers: { "retry-after": "0" } });
    m.push({ body: { ok: true } });
    const c = client(m.fetch, { maxRetries: 2 });
    const r = await c.get<{ ok: boolean }>("/x");
    expect(r.ok).toBe(true);
  });

  it("network errors retry up to maxRetries then surface as WafleApiError", async () => {
    const m = makeFetchMock();
    m.pushError({ code: "ECONNRESET", name: "FetchError", message: "reset" });
    m.pushError({ code: "ECONNRESET", name: "FetchError", message: "reset" });
    const c = client(m.fetch, { maxRetries: 1 });
    await expect(c.get("/x")).rejects.toMatchObject({ kind: "network" });
    expect(m.calls.length).toBe(2);
  });

  it("non-retryable errors surface immediately", async () => {
    const m = makeFetchMock();
    m.pushError({ code: "EOTHER", message: "weird" });
    const c = client(m.fetch, { maxRetries: 3 });
    await expect(c.get("/x")).rejects.toBeInstanceOf(WafleApiError);
    expect(m.calls.length).toBe(1);
  });

  it("PATCH/DELETE work and DELETE has no body", async () => {
    const m = makeFetchMock();
    m.push({ body: { ok: true } });
    m.push({ body: { ok: true } });
    const c = client(m.fetch);
    await c.patch("/x", { a: 1 });
    await c.delete("/y");
    expect(m.calls[0]!.method).toBe("PATCH");
    expect(m.calls[1]!.method).toBe("DELETE");
    expect(m.calls[1]!.body).toBeUndefined();
  });
});

describe("WafleApiError.toLLMPayload", () => {
  it("includes code/details", () => {
    const e = new WafleApiError({
      kind: "validation",
      message: "bad",
      status: 422,
      body: { code: "bad", message: "bad", data: { issues: [1] } },
    });
    expect(e.toLLMPayload()).toEqual({
      error: "bad",
      kind: "validation",
      status: 422,
      code: "bad",
      details: { issues: [1] },
    });
  });
});
