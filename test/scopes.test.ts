import { describe, it, expect } from "vitest";
import { ALL_SCOPES, expandGranted, hasScope } from "../src/auth/scopes.js";

describe("scopes", () => {
  it("expandGranted resolves implications transitively", () => {
    const granted = expandGranted(["stores:admin"]);
    expect(granted.has("stores:admin")).toBe(true);
    expect(granted.has("stores:write")).toBe(true);
    expect(granted.has("stores:read")).toBe(true);
  });

  it("orders:refund implies orders:write and orders:read", () => {
    const g = expandGranted(["orders:refund"]);
    expect(hasScope(g, "orders:write")).toBe(true);
    expect(hasScope(g, "orders:read")).toBe(true);
  });

  it("ALL_SCOPES roundtrips with no panic", () => {
    const g = expandGranted(ALL_SCOPES);
    expect(g.size).toBeGreaterThanOrEqual(ALL_SCOPES.length);
  });

  it("does not leak unrelated scopes", () => {
    const g = expandGranted(["pixels:write"]);
    expect(g.has("pixels:write")).toBe(true);
    expect(g.has("pixels:read")).toBe(true);
    expect(g.has("orders:write")).toBe(false);
    expect(g.has("system:admin")).toBe(false);
  });
});
