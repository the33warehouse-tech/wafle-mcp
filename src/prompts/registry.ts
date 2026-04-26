/**
 * Prompt registry.
 *
 * Wafle exposes server-defined prompts (parametric workflows the LLM can
 * be asked to execute). Each prompt lives in its own module and exports a
 * `WaflePrompt` definition + render handler.
 *
 * The protocol calls are:
 *   prompts/list   → returns the catalog
 *   prompts/get    → returns rendered messages for a specific prompt + args
 *
 * Defensive
 * - Required arguments are checked before rendering.
 * - All values are coerced to strings, trimmed, and length-capped to avoid
 *   prompt injection / runaway interpolation.
 */

const MAX_ARG_LEN = 4_000;

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptListEntry {
  name: string;
  description: string;
  arguments: PromptArgument[];
}

export interface RenderedPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface RenderedPrompt {
  description?: string;
  messages: RenderedPromptMessage[];
}

export interface WaflePrompt {
  name: string;
  description: string;
  arguments: PromptArgument[];
  /** Renders the prompt with the validated args. Args is an object of strings. */
  handler: (args: Record<string, string>) => RenderedPrompt;
}

export class PromptRegistry {
  private readonly prompts = new Map<string, WaflePrompt>();

  register(prompt: WaflePrompt): void {
    if (this.prompts.has(prompt.name)) {
      throw new Error(`Duplicate prompt name: ${prompt.name}`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(prompt.name)) {
      throw new Error(`Prompt name must be snake_case: ${prompt.name}`);
    }
    // Sanity-check argument names.
    const seen = new Set<string>();
    for (const a of prompt.arguments) {
      if (seen.has(a.name)) throw new Error(`Duplicate argument '${a.name}' in prompt '${prompt.name}'`);
      seen.add(a.name);
      if (!/^[a-z][a-z0-9_]*$/.test(a.name)) {
        throw new Error(`Argument name must be snake_case: ${a.name}`);
      }
    }
    this.prompts.set(prompt.name, prompt);
  }

  list(): PromptListEntry[] {
    return Array.from(this.prompts.values())
      .map<PromptListEntry>((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  size(): number {
    return this.prompts.size;
  }

  has(name: string): boolean {
    return this.prompts.has(name);
  }

  /**
   * Validate args + render the prompt. Throws if the prompt is unknown or
   * if a required argument is missing.
   */
  get(name: string, rawArgs: Record<string, unknown>): RenderedPrompt {
    const prompt = this.prompts.get(name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`);
    }

    const sanitized: Record<string, string> = {};
    for (const arg of prompt.arguments) {
      const raw = rawArgs[arg.name];
      if (raw === undefined || raw === null || raw === "") {
        if (arg.required) {
          throw new Error(`Prompt '${name}' missing required argument '${arg.name}': ${arg.description}`);
        }
        continue;
      }
      const str = String(raw).trim();
      if (str.length > MAX_ARG_LEN) {
        throw new Error(`Prompt '${name}' argument '${arg.name}' exceeds ${MAX_ARG_LEN} chars`);
      }
      sanitized[arg.name] = str;
    }

    return prompt.handler(sanitized);
  }
}
