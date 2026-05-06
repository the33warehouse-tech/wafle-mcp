/**
 * Tool registry.
 *
 * Each domain module exports a `defineTools(ctx)` function returning an array
 * of `WafleTool`. The registry collects them, validates uniqueness, exposes
 * MCP-shaped lists, and runs the implementations with Zod input validation
 * + structured error wrapping.
 */
import type { ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { WafleClient } from "../client/wafle-client.js";
import { WafleApiError } from "../client/errors.js";
import type { Scope } from "../auth/scopes.js";
import { expandGranted } from "../auth/scopes.js";
import type { TenantAuth } from "../auth/tenant.js";
import { hasMcpScope } from "../auth/jwt.js";
import type { ResourceRegistry } from "../resources/registry.js";
import { type Log, child } from "../logging.js";

/** Per-call extras: progress emission, etc. Optional — most tools ignore. */
export interface ToolRunExtras {
  /** Send a `notifications/progress` for the current request. */
  sendNotification?: (notification: unknown) => Promise<void>;
  /** The progress token attached to the request, if any. */
  progressToken?: string | number;
}

export interface ToolContext {
  client: WafleClient;
  log: Log;
  /** Scopes the upstream wafle key has. If `null`, all scopes assumed (warn-mode). */
  grantedScopes: Set<Scope> | null;
  /**
   * MCP-tier auth: who is calling, which tenant, which scopes. When `null`
   * the server is running in stdio/admin mode (single-user) and tools default
   * to admin-tier. HTTP transport always sets this.
   */
  tenantAuth?: TenantAuth | null;
  /** Optional resource registry — long-running tools may invalidate cache after mutations. */
  resources?: ResourceRegistry;
  /** Per-call extras. Filled in by the registry at run time. Use it to emit progress. */
  extras?: ToolRunExtras;
}

export interface WafleToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface WafleTool<I extends ZodTypeAny = ZodTypeAny, O = unknown> {
  name: string;
  /** Human-readable markdown description. The LLM reads this to pick the tool. */
  description: string;
  inputSchema: I;
  /** Optional output schema; advisory. */
  outputSchema?: ZodTypeAny;
  scopes: Scope[];
  /**
   * MCP-tier scope required to even *see* this tool in `tools/list` and to
   * call it. Two values:
   *   - "mcp:tools" (default) → any authenticated client (tenant or admin).
   *   - "mcp:admin"           → only admin-tier callers (master MCP keys
   *                              or JWTs that explicitly include "mcp:admin").
   * Tools that operate cross-tenant (master/system/audit, cross-tenant
   * stores listing, etc.) MUST set this to "mcp:admin".
   */
  requiredMcpScope?: "mcp:tools" | "mcp:admin";
  annotations?: WafleToolAnnotations;
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<O>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchemaJson: ReturnType<typeof zodToJsonSchema>;
  outputSchemaJson?: ReturnType<typeof zodToJsonSchema>;
  scopes: Scope[];
  requiredMcpScope: "mcp:tools" | "mcp:admin";
  annotations: WafleToolAnnotations;
  run: (
    rawInput: unknown,
    extras?: ToolRunExtras,
  ) => Promise<{ content: ToolContent[]; isError: boolean; structuredContent?: unknown }>;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } };

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  register<I extends ZodTypeAny, O>(tool: WafleTool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    if (!tool.name.startsWith("wafle_")) {
      throw new Error(`tool name must start with 'wafle_': ${tool.name}`);
    }

    const inputSchemaJson = zodToJsonSchema(tool.inputSchema, {
      $refStrategy: "none",
      target: "openApi3",
    });
    const outputSchemaJson = tool.outputSchema
      ? zodToJsonSchema(tool.outputSchema, { $refStrategy: "none", target: "openApi3" })
      : undefined;

    const log = (this.ctx.log?.child?.({ tool: tool.name }) ?? child({ tool: tool.name })) as Log;
    const ctx: ToolContext = { ...this.ctx, log };

    const requiredMcpScope: "mcp:tools" | "mcp:admin" = tool.requiredMcpScope ?? "mcp:tools";

    const registered: RegisteredTool = {
      name: tool.name,
      description: tool.description,
      inputSchemaJson,
      ...(outputSchemaJson ? { outputSchemaJson } : {}),
      scopes: tool.scopes,
      requiredMcpScope,
      annotations: tool.annotations ?? {},
      run: async (rawInput: unknown, extras?: ToolRunExtras) => {
        // Validate input.
        const parsed = tool.inputSchema.safeParse(rawInput ?? {});
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Input validation failed for ${tool.name}:\n${formatZodIssues(parsed.error)}`,
              },
            ],
          };
        }

        // MCP-tier scope check (admin-only tools require "mcp:admin"). When
        // tenantAuth is absent (stdio mode / tests) we treat the caller as
        // admin-tier so single-user CLI workflows keep working.
        if (ctx.tenantAuth) {
          if (!hasMcpScope(ctx.tenantAuth.scopes, requiredMcpScope)) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Tool ${tool.name} requires MCP scope '${requiredMcpScope}'. Your token has [${ctx.tenantAuth.scopes.join(", ")}]. Use a token issued with mcp:admin scope, or pick a tenant-scoped tool.`,
                },
              ],
            };
          }
        }

        // Wafle-key scope check.
        if (ctx.grantedScopes !== null) {
          for (const s of tool.scopes) {
            if (!ctx.grantedScopes.has(s)) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Scope denied: tool ${tool.name} requires '${s}' which the configured wafle key does not have. Grant it via the wafle keys admin or use a different key.`,
                  },
                ],
              };
            }
          }
        }

        try {
          const callCtx: ToolContext = extras ? { ...ctx, extras } : ctx;
          const out = await tool.handler(parsed.data, callCtx);
          // MCP spec: `structuredContent` MUST be a JSON object (record).
          // Wrap arrays / primitives so we never violate the schema and the
          // SDK doesn't reject the whole call. Plain text always lives in
          // `content[0].text` — agents and humans can read it from there.
          const structured =
            out !== null && typeof out === "object" && !Array.isArray(out)
              ? (out as Record<string, unknown>)
              : { value: out };
          return {
            isError: false,
            content: [{ type: "text", text: stringifyForLLM(out) }],
            structuredContent: structured,
          };
        } catch (err) {
          if (err instanceof WafleApiError) {
            ctx.log.warn({ kind: err.kind, status: err.status }, "tool error");
            return {
              isError: true,
              content: [
                { type: "text", text: stringifyForLLM(err.toLLMPayload()) },
              ],
              structuredContent: err.toLLMPayload(),
            };
          }
          const e = err as Error;
          ctx.log.error({ err: e?.message }, "tool unexpected error");
          return {
            isError: true,
            content: [{ type: "text", text: `Unexpected error in ${tool.name}: ${e?.message ?? String(err)}` }],
          };
        }
      },
    };

    this.tools.set(tool.name, registered);
  }

  list(): RegisteredTool[] {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * List tools visible to a caller with the given MCP-tier scopes. Tools
   * marked `requiredMcpScope:"mcp:admin"` are filtered out for non-admin
   * callers, so a tenant client never even sees them in `tools/list`.
   *
   * Pass `null` for stdio/admin mode (sees everything).
   */
  listForCaller(callerScopes: string[] | null): RegisteredTool[] {
    if (callerScopes === null) return this.list();
    return this.list().filter((t) => hasMcpScope(callerScopes, t.requiredMcpScope));
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  size(): number {
    return this.tools.size;
  }

  /** Return the union of scopes required by every registered tool. */
  requiredScopes(): Set<Scope> {
    const out = new Set<Scope>();
    for (const t of this.tools.values()) {
      for (const s of t.scopes) out.add(s);
    }
    return expandGranted(Array.from(out));
  }
}

function formatZodIssues(err: import("zod").ZodError): string {
  return err.issues
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("\n");
}

export function stringifyForLLM(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
