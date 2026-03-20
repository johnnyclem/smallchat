/**
 * MCP Prompts — list, get, and render prompt templates.
 *
 * Prompts are reusable templates that can be parameterized and
 * rendered into messages for LLM consumption. They support
 * variable substitution and multi-message composition.
 */

// ---------------------------------------------------------------------------
// Prompt types
// ---------------------------------------------------------------------------

export interface MCPPrompt {
  /** Unique prompt name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Input arguments the prompt accepts */
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptArgument {
  /** Argument name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Whether this argument is required */
  required?: boolean;
}

export interface MCPPromptMessage {
  /** Message role */
  role: 'user' | 'assistant' | 'system';
  /** Message content */
  content: MCPPromptContent;
}

export type MCPPromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; mimeType?: string } };

// ---------------------------------------------------------------------------
// Prompt handler interface
// ---------------------------------------------------------------------------

export interface PromptHandler {
  /** Provider ID */
  providerId: string;
  /** List available prompts */
  list(): Promise<MCPPrompt[]>;
  /** Get and render a specific prompt with arguments */
  get(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]>;
}

// ---------------------------------------------------------------------------
// Prompt registry
// ---------------------------------------------------------------------------

export class PromptRegistry {
  private handlers: Map<string, PromptHandler> = new Map();
  private staticPrompts: Map<string, StaticPrompt> = new Map();

  /** Register a prompt handler for a provider */
  registerHandler(handler: PromptHandler): void {
    this.handlers.set(handler.providerId, handler);
  }

  /** Remove a prompt handler */
  unregisterHandler(providerId: string): void {
    this.handlers.delete(providerId);
  }

  /** Register a static prompt (defined inline, not from a provider) */
  registerPrompt(prompt: StaticPrompt): void {
    this.staticPrompts.set(prompt.name, prompt);
  }

  // ---------------------------------------------------------------------------
  // MCP prompts/list
  // ---------------------------------------------------------------------------

  async list(cursor?: string): Promise<{ prompts: MCPPrompt[]; nextCursor?: string }> {
    const allPrompts: MCPPrompt[] = [];

    // Collect from handlers
    for (const handler of this.handlers.values()) {
      try {
        const prompts = await handler.list();
        allPrompts.push(...prompts);
      } catch {
        // Skip failing handlers
      }
    }

    // Add static prompts
    for (const sp of this.staticPrompts.values()) {
      allPrompts.push({
        name: sp.name,
        description: sp.description,
        arguments: sp.arguments,
      });
    }

    return { prompts: allPrompts };
  }

  // ---------------------------------------------------------------------------
  // MCP prompts/get — render a prompt with arguments
  // ---------------------------------------------------------------------------

  async get(
    name: string,
    args?: Record<string, string>,
  ): Promise<{ description?: string; messages: MCPPromptMessage[] }> {
    // Check static prompts first
    const staticPrompt = this.staticPrompts.get(name);
    if (staticPrompt) {
      const messages = renderStaticPrompt(staticPrompt, args);
      return { description: staticPrompt.description, messages };
    }

    // Try each handler
    for (const handler of this.handlers.values()) {
      try {
        const prompts = await handler.list();
        if (prompts.some(p => p.name === name)) {
          const messages = await handler.get(name, args);
          return { messages };
        }
      } catch {
        // Try next handler
      }
    }

    throw new PromptNotFoundError(name);
  }
}

// ---------------------------------------------------------------------------
// Static prompts
// ---------------------------------------------------------------------------

export interface StaticPrompt extends MCPPrompt {
  /** Template strings with {{variable}} placeholders */
  template: MCPPromptMessage[];
}

/** Render a static prompt by substituting template variables */
function renderStaticPrompt(
  prompt: StaticPrompt,
  args?: Record<string, string>,
): MCPPromptMessage[] {
  return prompt.template.map(msg => ({
    role: msg.role,
    content: substituteContent(msg.content, args ?? {}),
  }));
}

/** Substitute {{variable}} placeholders in content */
function substituteContent(
  content: MCPPromptContent,
  args: Record<string, string>,
): MCPPromptContent {
  if (content.type === 'text') {
    let text = content.text;
    for (const [key, value] of Object.entries(args)) {
      text = text.replaceAll(`{{${key}}}`, value);
    }
    return { type: 'text', text };
  }
  return content;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PromptNotFoundError extends Error {
  promptName: string;

  constructor(name: string) {
    super(`Prompt not found: ${name}`);
    this.name = 'PromptNotFoundError';
    this.promptName = name;
  }
}
