/**
 * Scope matrix.
 *
 * Each tool declares the scopes it requires; the server validates that the
 * configured wafle admin key is allowed to call them. Wafle's `/auth/me`
 * endpoint is being extended (in parallel) to return scopes — until it does,
 * we fall back to "all scopes" with a one-time warning at startup.
 */
export type Scope =
  | "auth:read"
  | "stores:read"
  | "stores:write"
  | "stores:admin"
  | "products:read"
  | "products:write"
  | "products:admin"
  | "pricing:read"
  | "pricing:write"
  | "orders:read"
  | "orders:write"
  | "orders:refund"
  | "customers:read"
  | "customers:write"
  | "customers:export"
  | "gateways:read"
  | "gateways:write"
  | "gateways:admin"
  | "shipping:read"
  | "shipping:quote"
  | "coupons:read"
  | "coupons:write"
  | "abandoned:read"
  | "abandoned:send"
  | "analytics:read"
  | "exports:read"
  | "pixels:read"
  | "pixels:write"
  | "system:read"
  | "system:write"
  | "system:admin";

export const ALL_SCOPES: Scope[] = [
  "auth:read",
  "stores:read",
  "stores:write",
  "stores:admin",
  "products:read",
  "products:write",
  "products:admin",
  "pricing:read",
  "pricing:write",
  "orders:read",
  "orders:write",
  "orders:refund",
  "customers:read",
  "customers:write",
  "customers:export",
  "gateways:read",
  "gateways:write",
  "gateways:admin",
  "shipping:read",
  "shipping:quote",
  "coupons:read",
  "coupons:write",
  "abandoned:read",
  "abandoned:send",
  "analytics:read",
  "exports:read",
  "pixels:read",
  "pixels:write",
  "system:read",
  "system:write",
  "system:admin",
];

/**
 * Hierarchical implication. `stores:admin` grants `stores:write` and `stores:read`,
 * etc. Used when checking authorization.
 */
const IMPLICATIONS: Record<string, Scope[]> = {
  "stores:admin": ["stores:write", "stores:read"],
  "stores:write": ["stores:read"],
  "products:admin": ["products:write", "products:read"],
  "products:write": ["products:read"],
  "pricing:write": ["pricing:read"],
  "orders:write": ["orders:read"],
  "orders:refund": ["orders:write", "orders:read"],
  "customers:write": ["customers:read"],
  "customers:export": ["customers:read"],
  "gateways:admin": ["gateways:write", "gateways:read"],
  "gateways:write": ["gateways:read"],
  "shipping:quote": ["shipping:read"],
  "coupons:write": ["coupons:read"],
  "abandoned:send": ["abandoned:read"],
  "pixels:write": ["pixels:read"],
  "system:admin": ["system:write", "system:read"],
  "system:write": ["system:read"],
};

export function expandGranted(granted: Scope[]): Set<Scope> {
  const out = new Set<Scope>();
  for (const s of granted) {
    out.add(s);
    const stack = [...(IMPLICATIONS[s] ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (!out.has(next)) {
        out.add(next);
        stack.push(...(IMPLICATIONS[next] ?? []));
      }
    }
  }
  return out;
}

export function hasScope(granted: Set<Scope>, required: Scope): boolean {
  return granted.has(required);
}
