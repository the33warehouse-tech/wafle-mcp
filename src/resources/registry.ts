/**
 * Resource registry.
 *
 * Mirrors the design of `tools/registry.ts` but for MCP Resources. Each
 * resource declares either a static URI (e.g. `wafle://system/health`) or a
 * URI template (e.g. `wafle://stores/{slug}`) plus a handler that returns the
 * resource body.
 *
 * Caching layer
 * - Per-resource TTL in milliseconds.
 * - Cache key = resolved URI.
 * - Concurrent reads of the same URI are coalesced (single in-flight promise).
 * - Manual invalidation by exact URI or substring pattern.
 *
 * Auto-loading
 * - Domain modules export a `defineResources()` array; the index aggregates
 *   them — same shape as tools.
 *
 * Defensive
 * - URIs are validated against the `wafle://` scheme.
 * - Template params are URI-decoded and re-validated by the handler.
 * - Handler errors are caught and surfaced as MCP errors.
 */
import type { WafleClient } from "../client/wafle-client.js";
import type { Scope } from "../auth/scopes.js";
import { type Log } from "../logging.js";

export interface ResourceContext {
  client: WafleClient;
  log: Log;
  /** Scopes the upstream wafle key has. If `null`, all scopes assumed (warn-mode). */
  grantedScopes: Set<Scope> | null;
}

export type ResourceMimeType = "application/json" | "text/markdown" | "text/plain";

/** Body returned by a resource handler — either an object (will be JSON-stringified) or a string. */
export type ResourceBody = unknown;

export interface ResourceParams {
  /** Decoded URI template parameters (e.g. `{ slug: "gamerland" }`). */
  params: Record<string, string>;
  /** Full resolved URI as requested. */
  uri: string;
}

export interface WafleResource {
  /** Static URI (e.g. `wafle://system/health`) OR URI template (e.g. `wafle://stores/{slug}`). */
  uri: string;
  /** Human-readable name shown in MCP clients. */
  name: string;
  /** Markdown description. The LLM reads this. */
  description: string;
  /** MIME type of the response body. */
  mimeType: ResourceMimeType;
  /** TTL in milliseconds. Set to 0 to disable caching. Default 60_000. */
  ttlMs?: number;
  /** Required scopes. Empty array = no scope check. */
  scopes?: Scope[];
  /** Handler producing the body. */
  handler: (params: ResourceParams, ctx: ResourceContext) => Promise<ResourceBody>;
}

export interface ResourceListEntry {
  /** Concrete URI shown in `resources/list`. For templates, this is the template form. */
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  isTemplate: boolean;
}

export interface ResolvedResource {
  resource: WafleResource;
  /** URI parameters decoded from the URI. */
  params: Record<string, string>;
}

interface CacheEntry {
  /** Resolved body (string or object). */
  body: string;
  /** Mime type to return. */
  mimeType: string;
  /** Epoch ms when this entry expires. */
  expiresAt: number;
}

const URI_SCHEME = "wafle://";

function isTemplate(uri: string): boolean {
  return uri.includes("{") && uri.includes("}");
}

/**
 * Convert a URI template to a regex with named groups.
 *
 * `wafle://stores/{slug}/orders/recent` →
 *   /^wafle:\/\/stores\/(?<slug>[^/]+)\/orders\/recent$/
 *
 * Each `{name}` matches any non-slash characters (URI-decoded by us before
 * passing to the handler).
 */
function templateToRegex(template: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, (m) =>
    m === "{" || m === "}" ? m : `\\${m}`,
  );
  const pattern = escaped.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_full, name: string) => {
    paramNames.push(name);
    return `(?<${name}>[^/]+)`;
  });
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

/**
 * Stringify a resource body for transport. Strings pass through; objects are
 * JSON-stringified with indent=2.
 */
function stringifyBody(body: ResourceBody, mime: string): string {
  if (body === null || body === undefined) return "";
  if (typeof body === "string") return body;
  if (mime === "application/json" || typeof body === "object") {
    try {
      return JSON.stringify(body, null, 2);
    } catch {
      return String(body);
    }
  }
  return String(body);
}

export class ResourceRegistry {
  private readonly resources: WafleResource[] = [];
  private readonly templateResources: Array<WafleResource & { regex: RegExp; paramNames: string[] }> = [];
  private readonly staticResources = new Map<string, WafleResource>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<{ body: string; mimeType: string }>>();
  private readonly ctx: ResourceContext;

  constructor(ctx: ResourceContext) {
    this.ctx = ctx;
  }

  register(resource: WafleResource): void {
    if (!resource.uri.startsWith(URI_SCHEME)) {
      throw new Error(`Resource URI must start with '${URI_SCHEME}': ${resource.uri}`);
    }
    if (this.resources.some((r) => r.uri === resource.uri)) {
      throw new Error(`Duplicate resource URI: ${resource.uri}`);
    }
    this.resources.push(resource);
    if (isTemplate(resource.uri)) {
      const { regex, paramNames } = templateToRegex(resource.uri);
      this.templateResources.push({ ...resource, regex, paramNames });
    } else {
      this.staticResources.set(resource.uri, resource);
    }
  }

  /** List entries for `resources/list`. */
  list(): ResourceListEntry[] {
    return this.resources
      .map<ResourceListEntry>((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
        isTemplate: isTemplate(r.uri),
      }))
      .sort((a, b) => a.uri.localeCompare(b.uri));
  }

  size(): number {
    return this.resources.length;
  }

  /**
   * Resolve a concrete URI to a registered resource (and decoded params).
   * Returns `null` if no resource matches.
   */
  resolve(uri: string): ResolvedResource | null {
    const staticHit = this.staticResources.get(uri);
    if (staticHit) return { resource: staticHit, params: {} };
    for (const r of this.templateResources) {
      const m = r.regex.exec(uri);
      if (m && m.groups) {
        const params: Record<string, string> = {};
        for (const name of r.paramNames) {
          const raw = m.groups[name];
          if (raw === undefined) continue;
          try {
            params[name] = decodeURIComponent(raw);
          } catch {
            params[name] = raw;
          }
        }
        return { resource: r, params };
      }
    }
    return null;
  }

  /**
   * Read a resource by URI. Returns body + mime type. Honors cache.
   *
   * Concurrent calls for the same URI share a single in-flight promise.
   */
  async read(uri: string): Promise<{ body: string; mimeType: string }> {
    const resolved = this.resolve(uri);
    if (!resolved) {
      throw new Error(`Unknown resource URI: ${uri}`);
    }

    // Cache hit
    const cached = this.cache.get(uri);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      this.ctx.log.debug({ uri, age_ms: now - (cached.expiresAt - (resolved.resource.ttlMs ?? 60_000)) }, "resource cache hit");
      return { body: cached.body, mimeType: cached.mimeType };
    }

    // Coalesce concurrent reads
    const inflight = this.inflight.get(uri);
    if (inflight) return inflight;

    const promise = (async () => {
      try {
        // Scope check
        if (this.ctx.grantedScopes !== null && resolved.resource.scopes && resolved.resource.scopes.length) {
          for (const s of resolved.resource.scopes) {
            if (!this.ctx.grantedScopes.has(s)) {
              throw new Error(
                `Scope denied: resource ${uri} requires '${s}' which the configured wafle key does not have.`,
              );
            }
          }
        }

        const body = await resolved.resource.handler(
          { params: resolved.params, uri },
          this.ctx,
        );
        const text = stringifyBody(body, resolved.resource.mimeType);
        const ttl = resolved.resource.ttlMs ?? 60_000;
        if (ttl > 0) {
          this.cache.set(uri, {
            body: text,
            mimeType: resolved.resource.mimeType,
            expiresAt: Date.now() + ttl,
          });
        }
        return { body: text, mimeType: resolved.resource.mimeType };
      } finally {
        this.inflight.delete(uri);
      }
    })();
    this.inflight.set(uri, promise);
    return promise;
  }

  /**
   * Invalidate the cache.
   * - No arg → flush everything.
   * - Pattern → invalidate any entry whose URI contains the substring.
   *
   * Returns the number of entries removed.
   */
  invalidate(pattern?: string): number {
    if (!pattern) {
      const count = this.cache.size;
      this.cache.clear();
      return count;
    }
    let count = 0;
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Snapshot of cache stats — for diagnostics. */
  cacheStats(): { size: number; keys: string[] } {
    return { size: this.cache.size, keys: Array.from(this.cache.keys()).sort() };
  }
}
