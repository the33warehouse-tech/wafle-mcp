import { describe, it, expect } from "vitest";
import { makeValidator } from "../src/auth/api-keys.js";

describe("api-keys validator", () => {
  it("disabled when no tokens", () => {
    expect(makeValidator(undefined).enabled).toBe(false);
    expect(makeValidator("").enabled).toBe(false);
  });

  it("rejects too-short tokens", () => {
    const v = makeValidator("short");
    expect(v.enabled).toBe(false);
  });

  it("accepts a valid token, rejects others", () => {
    const v = makeValidator("0123456789abcdef0123456789abcdef");
    expect(v.enabled).toBe(true);
    expect(v.isValid("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(v.isValid("nope")).toBe(false);
    expect(v.isValid("")).toBe(false);
  });

  it("supports multiple tokens", () => {
    const v = makeValidator("0123456789abcdef0123456789abcdef,1111111111111111aaaaaaaaaaaaaaaa");
    expect(v.isValid("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(v.isValid("1111111111111111aaaaaaaaaaaaaaaa")).toBe(true);
    expect(v.isValid("0000000000000000aaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("constant-time compare does not crash on different lengths", () => {
    const v = makeValidator("0123456789abcdef0123456789abcdef");
    expect(v.isValid("a")).toBe(false);
    expect(v.isValid("0123456789abcdef0123456789abcdef0123456789")).toBe(false);
  });
});
