/**
 * LangChain Integration — SmallChatTool wrapper
 *
 * Wraps a ToolRuntime as a LangChain-compatible structured tool.
 * Each Smallchat tool becomes a BaseTool/StructuredTool that an agent
 * can discover and invoke natively.
 *
 * Usage (with LangChain installed):
 *
 *   import { SmallChatTool, SmallChatToolkit } from '@smallchat/core/integrations/langchain';
 *   import { ToolRuntime } from '@smallchat/core';
 *
 *   const runtime = new ToolRuntime(vectorIndex, embedder);
 *   // ... register classes ...
 *
 *   const toolkit = new SmallChatToolkit(runtime);
 *   const tools = toolkit.getTools(); // Array<SmallChatTool>
 *
 *   // Use with any LangChain agent:
 *   const agent = await createToolCallingAgent({ llm, tools, prompt });
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolIMP, ToolResult, JSONSchemaType } from '../../core/types.js';

// ---------------------------------------------------------------------------
// LangChain interface shims
// These mirror LangChain's BaseTool / StructuredTool without requiring the
// package as a hard dependency. Projects that install langchain get full
// compatibility; those that don't still compile cleanly.
// ---------------------------------------------------------------------------

export interface LangChainToolFields {
  name: string;
  description: string;
  schema?: LangChainSchema;
}

export interface LangChainSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  description?: string;
}

export interface LangChainToolCallResult {
  content: string;
  artifact?: unknown;
}

export type LangChainToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

/**
 * SmallChatTool — a single Smallchat tool wrapped as a LangChain BaseTool.
 *
 * Implements the LangChain tool interface so it can be dropped into any
 * agent executor, LCEL chain, or tool-calling model.
 */
export class SmallChatTool {
  readonly name: string;
  readonly description: string;
  readonly schema: LangChainSchema;

  private imp: ToolIMP;

  constructor(imp: ToolIMP) {
    this.imp = imp;
    this.name = `${imp.providerId}__${imp.toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
    this.description = imp.schema?.description ?? `Execute ${imp.toolName} via ${imp.providerId}`;
    this.schema = toJsonSchema(imp.schema?.inputSchema ?? { type: 'object', properties: {} });
  }

  /**
   * Invoke the tool — compatible with LangChain's tool.invoke() signature.
   */
  async invoke(
    input: string | Record<string, unknown>,
    _config?: Record<string, unknown>,
  ): Promise<LangChainToolCallResult> {
    const args: Record<string, unknown> =
      typeof input === 'string' ? { input } : input;

    const result: ToolResult = await this.imp.execute(args);

    return {
      content: serializeResult(result),
      artifact: result.metadata,
    };
  }

  /**
   * Call the tool — shorthand alias used by older LangChain agent executors.
   */
  async call(
    arg: string | Record<string, unknown>,
    _callbacks?: unknown,
  ): Promise<string> {
    const result = await this.invoke(arg);
    return result.content;
  }

  /**
   * Return a plain object representation for JSON serialization / logging.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      schema: this.schema,
    };
  }
}

/**
 * SmallChatToolkit — builds a LangChain-compatible tool array from a runtime.
 *
 * Iterates over every registered ToolClass and creates one SmallChatTool per IMP.
 * This mirrors LangChain's Toolkit pattern (e.g. GmailToolkit, SlackToolkit).
 */
export class SmallChatToolkit {
  private runtime: ToolRuntime;

  constructor(runtime: ToolRuntime) {
    this.runtime = runtime;
  }

  /** Return all tools as SmallChatTool instances. */
  getTools(): SmallChatTool[] {
    const tools: SmallChatTool[] = [];
    for (const toolClass of this.runtime.context.getClasses()) {
      for (const [, imp] of toolClass.dispatchTable) {
        tools.push(new SmallChatTool(imp));
      }
    }
    return tools;
  }

  /**
   * Return tool descriptions as the LangChain OpenAI-style function spec.
   * Use this to populate the `functions` or `tools` array for ChatOpenAI.
   */
  getOpenAIFunctions(): Array<{
    type: 'function';
    function: { name: string; description: string; parameters: LangChainSchema };
  }> {
    return this.getTools().map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    }));
  }
}

/**
 * SmallChatDispatchTool — a single LangChain tool that routes ANY intent
 * through toolkit_dispatch. Useful when the agent should describe what
 * it needs in natural language and let Smallchat resolve the best tool.
 */
export class SmallChatDispatchTool {
  readonly name = 'smallchat_dispatch';
  readonly description =
    'Dispatch any tool intent via Smallchat semantic routing. ' +
    'Provide a natural-language description of what you want to do, ' +
    'optionally with a JSON args object. ' +
    'Example: { "intent": "search for recent news about TypeScript", "args": { "limit": 5 } }';

  readonly schema: LangChainSchema = {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description: 'Natural language description of the tool action',
      },
      args: {
        type: 'object',
        description: 'Optional arguments to pass to the resolved tool',
      },
    },
    required: ['intent'],
  };

  private runtime: ToolRuntime;

  constructor(runtime: ToolRuntime) {
    this.runtime = runtime;
  }

  async invoke(
    input: { intent: string; args?: Record<string, unknown> } | string,
  ): Promise<LangChainToolCallResult> {
    const { intent, args } =
      typeof input === 'string' ? { intent: input, args: undefined } : input;

    const result = await this.runtime.dispatch(intent, args);
    return {
      content: serializeResult(result),
      artifact: result.metadata,
    };
  }

  async call(arg: string | Record<string, unknown>): Promise<string> {
    const result = await this.invoke(arg as { intent: string; args?: Record<string, unknown> });
    return result.content;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toJsonSchema(inputSchema: JSONSchemaType): LangChainSchema {
  return {
    type: 'object',
    properties: inputSchema.properties ?? {},
    required: inputSchema.required ?? [],
    description: inputSchema.description,
  };
}

function serializeResult(result: ToolResult): string {
  if (result.isError) {
    const errMsg =
      typeof result.metadata?.error === 'string'
        ? result.metadata.error
        : 'Tool execution failed';
    return `Error: ${errMsg}`;
  }
  if (typeof result.content === 'string') return result.content;
  return JSON.stringify(result.content, null, 2);
}
