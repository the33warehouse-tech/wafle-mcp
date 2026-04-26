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
import { type Log, child } from "../logging.js";

export interface ToolContext {
  client: WafleClient;
  log: Log;
  /** Scopes the upstream wafle key has. If `null`, all scopes assumed (warn-mode). */
  grantedScopes: Set<Scope> | null;
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
  annotations?: WafleToolAnnotations;
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<O>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchemaJson: ReturnType<typeof zodToJsonSchema>;
  outputSchemaJson?: ReturnType<typeof zodToJsonSchema>;
  scopes: Scope[];
  annotations: WafleToolAnnotations;
  run: (rawInput: unknown) => Promise<{ content: ToolContent[]; isError: boolean; structuredContent?: unknown }>;
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

    const log = child({ tool: tool.name });
    const ctx: ToolContext = { ...this.ctx, log };

    const registered: RegisteredTool = {
      name: tool.name,
      description: tool.description,
      inputSchemaJson,
      ...(outputSchemaJson ? { outputSchemaJson } : {}),
      scopes: tool.scopes,
      annotations: tool.annotations ?? {},
      run: async (rawInput: unknown) => {
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

        // Scope check.
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
          const out = await tool.handler(parsed.data, ctx);
          return {
            isError: false,
            content: [{ type: "text", text: stringifyForLLM(out) }],
            structuredContent: out as unknown,
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
