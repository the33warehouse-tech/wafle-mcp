import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRegistry, type ToolContext, type WafleTool } from "../src/tools/registry.js";
import { WafleApiError } from "../src/client/errors.js";
import { makeClient, makeFetchMock, silentLogger } from "./helpers.js";
import { expandGranted } from "../src/auth/scopes.js";

function ctx(grantedScopes: ToolContext["grantedScopes"] = expandGranted(["orders:read"])): ToolContext {
  return {
    client: makeClient(),
    log: silentLogger() as never,
    grantedScopes,
  };
}

const ok: WafleTool = {
  name: "wafle_test_ok",
  description: "ok",
  inputSchema: z.object({ x: z.number() }),
  scopes: ["orders:read"],
  handler: async (input) => ({ doubled: input.x * 2 }),
};

const failingScopes: WafleTool = {
  name: "wafle_test_no_scope",
  description: "needs admin",
  inputSchema: z.object({}),
  scopes: ["system:admin"],
  handler: async () => ({ ok: true }),
};

const upstream: WafleTool = {
  name: "wafle_test_upstream",
  description: "calls upstream",
  inputSchema: z.object({}),
  scopes: ["orders:read"],
  handler: async (_i, c) => c.client.get("/x"),
};

describe("ToolRegistry", () => {
  it("rejects names without wafle_ prefix", () => {
    const r = new ToolRegistry(ctx());
    expect(() => r.register({ ...ok, name: "bad" })).toThrow(/wafle_/);
  });

  it("rejects duplicate names", () => {
    const r = new ToolRegistry(ctx());
    r.register(ok);
    expect(() => r.register(ok)).toThrow(/duplicate/);
  });

  it("validates input via Zod and surfaces errors", async () => {
    const r = new ToolRegistry(ctx());
    r.register(ok);
    const t = r.get("wafle_test_ok")!;
    const res = await t.run({ x: "not a number" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Input validation failed/);
  });

  it("runs handler and returns structured + text content", async () => {
    const r = new ToolRegistry(ctx());
    r.register(ok);
    const t = r.get("wafle_test_ok")!;
    const res = await t.run({ x: 5 });
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toEqual({ doubled: 10 });
    expect((res.content[0] as { text: string }).text).toContain('"doubled": 10');
  });

  it("denies tools whose scope is not in granted set", async () => {
    const r = new ToolRegistry(ctx(expandGranted(["orders:read"])));
    r.register(failingScopes);
    const res = await r.get("wafle_test_no_scope")!.run({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Scope denied/);
  });

  it("warn-mode (granted=null) skips scope checks", async () => {
    const r = new ToolRegistry({ ...ctx(), grantedScopes: null });
    r.register(failingScopes);
    const res = await r.get("wafle_test_no_scope")!.run({});
    expect(res.isError).toBe(false);
  });

  it("converts WafleApiError to structured isError content", async () => {
    const m = makeFetchMock();
    m.push({ status: 404, body: { code: "not_found", message: "missing" } });
    const c = makeClient({ fetchImpl: m.fetch });
    const r = new ToolRegistry({ ...ctx(), client: c, grantedScopes: expandGranted(["orders:read"]) });
    r.register(upstream);
    const res = await r.get("wafle_test_upstream")!.run({});
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ kind: "not_found", status: 404 });
  });

  it("converts unexpected errors to graceful isError responses", async () => {
    const r = new ToolRegistry(ctx());
    r.register({
      ...ok,
      name: "wafle_test_boom",
      handler: async () => {
        throw new Error("kaboom");
      },
    });
    const res = await r.get("wafle_test_boom")!.run({ x: 1 });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/Unexpected error/);
  });

  // Sanity: WafleApiError is exported and `instanceof` works inside tests.
  it("WafleApiError is constructible", () => {
    const e = new WafleApiError({ kind: "unknown", message: "x" });
    expect(e).toBeInstanceOf(WafleApiError);
  });
});
