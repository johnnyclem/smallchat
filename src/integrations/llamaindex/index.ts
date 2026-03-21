/**
 * LlamaIndex Integration — tool adapter for LlamaIndex (TypeScript)
 *
 * Wraps Smallchat tools as LlamaIndex FunctionTool / BaseTool instances so
 * they can be used inside LlamaIndex agents, query engines, and workflows.
 *
 * Supports:
 *  - SmallChatFunctionTool — wraps a single ToolIMP as a LlamaIndex FunctionTool
 *  - SmallChatToolset — builds all tools from a runtime
 *  - SmallChatDispatchFunctionTool — omnibus natural-language dispatch tool
 *  - toLlamaIndexTools() — convenience factory
 *
 * Usage (with llamaindex installed):
 *
 *   import { OpenAIAgent } from 'llamaindex';
 *   import { toLlamaIndexTools } from './integrations/llamaindex';
 *
 *   const tools = toLlamaIndexTools(runtime);
 *   const agent = new OpenAIAgent({ tools });
 *   const response = await agent.chat({ message: 'What is the weather in Berlin?' });
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolIMP, ToolResult, JSONSchemaType } from '../../core/types.js';

// ---------------------------------------------------------------------------
// LlamaIndex interface shims
// ---------------------------------------------------------------------------

export interface LlamaIndexToolMetadata {
  name: string;
  description: string;
  parameters?: LlamaIndexJSONSchema;
  returnDirect?: boolean;
}

export interface LlamaIndexJSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  description?: string;
  title?: string;
}

export interface LlamaIndexToolOutput {
  tool: LlamaIndexBaseTool;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

export interface LlamaIndexBaseTool {
  metadata: LlamaIndexToolMetadata;
  call(input: Record<string, unknown>): Promise<LlamaIndexToolOutput>;
  // LlamaIndex 0.4+ uses `invoke` as well
  invoke?(input: Record<string, unknown>): Promise<LlamaIndexToolOutput>;
}

// ---------------------------------------------------------------------------
// SmallChatFunctionTool — single ToolIMP as LlamaIndex tool
// ---------------------------------------------------------------------------

export class SmallChatFunctionTool implements LlamaIndexBaseTool {
  readonly metadata: LlamaIndexToolMetadata;
  private imp: ToolIMP;

  constructor(imp: ToolIMP) {
    this.imp = imp;
    this.metadata = {
      name: `${imp.providerId}__${imp.toolName}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: imp.schema?.description ?? `Execute ${imp.toolName} from ${imp.providerId}`,
      parameters: toJSONSchema(imp.schema?.inputSchema ?? { type: 'object', properties: {} }),
    };
  }

  async call(input: Record<string, unknown>): Promise<LlamaIndexToolOutput> {
    return this.execute(input);
  }

  async invoke(input: Record<string, unknown>): Promise<LlamaIndexToolOutput> {
    return this.execute(input);
  }

  private async execute(input: Record<string, unknown>): Promise<LlamaIndexToolOutput> {
    const result: ToolResult = await this.imp.execute(input);
    const output = formatOutput(result);

    return {
      tool: this,
      input,
      output,
      isError: result.isError ?? false,
    };
  }
}

// ---------------------------------------------------------------------------
// SmallChatDispatchFunctionTool — natural-language dispatch as a single tool
// ---------------------------------------------------------------------------

export class SmallChatDispatchFunctionTool implements LlamaIndexBaseTool {
  readonly metadata: LlamaIndexToolMetadata = {
    name: 'smallchat_dispatch',
    description:
      'Dispatch any tool intent via Smallchat semantic routing. ' +
      'Describe what you want to do in natural language and optionally provide arguments.',
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'Natural language description of the action' },
        args: { type: 'object', description: 'Optional arguments for the resolved tool' },
      },
      required: ['intent'],
    },
  };

  private runtime: ToolRuntime;

  constructor(runtime: ToolRuntime) {
    this.runtime = runtime;
  }

  async call(input: Record<string, unknown>): Promise<LlamaIndexToolOutput> {
    return this.execute(input);
  }

  async invoke(input: Record<string, unknown>): Promise<LlamaIndexToolOutput> {
    return this.execute(input);
  }

  private async execute(input: Record<string, unknown>): Promise<LlamaIndexToolOutput> {
    const intent = String(input.intent ?? '');
    const args =
      input.args && typeof input.args === 'object'
        ? (input.args as Record<string, unknown>)
        : undefined;

    const result = await this.runtime.dispatch(intent, args);
    const output = formatOutput(result);

    return {
      tool: this,
      input,
      output,
      isError: result.isError ?? false,
    };
  }
}

// ---------------------------------------------------------------------------
// SmallChatToolset — build all tools from a runtime
// ---------------------------------------------------------------------------

export class SmallChatToolset {
  private runtime: ToolRuntime;

  constructor(runtime: ToolRuntime) {
    this.runtime = runtime;
  }

  /** Return all tools as SmallChatFunctionTool instances. */
  getTools(): SmallChatFunctionTool[] {
    const tools: SmallChatFunctionTool[] = [];
    for (const toolClass of this.runtime.context.getClasses()) {
      for (const [, imp] of toolClass.dispatchTable) {
        tools.push(new SmallChatFunctionTool(imp));
      }
    }
    return tools;
  }

  /** Return a single dispatch tool for natural-language routing. */
  getDispatchTool(): SmallChatDispatchFunctionTool {
    return new SmallChatDispatchFunctionTool(this.runtime);
  }
}

// ---------------------------------------------------------------------------
// toLlamaIndexTools — convenience factory
// ---------------------------------------------------------------------------

/**
 * Build a LlamaIndex tool array from a ToolRuntime.
 *
 * @param runtime  - Populated ToolRuntime
 * @param mode     - 'individual' exposes every tool; 'dispatch' uses single omnibus tool
 */
export function toLlamaIndexTools(
  runtime: ToolRuntime,
  mode: 'individual' | 'dispatch' = 'individual',
): LlamaIndexBaseTool[] {
  if (mode === 'dispatch') {
    return [new SmallChatDispatchFunctionTool(runtime)];
  }

  const toolset = new SmallChatToolset(runtime);
  return toolset.getTools();
}

// ---------------------------------------------------------------------------
// Python interop (type stubs for reference documentation)
// ---------------------------------------------------------------------------

/**
 * Python LlamaIndex adapter reference.
 *
 * For the Python version, implement a FunctionTool subclass:
 *
 * ```python
 * # smallchat_llamaindex.py
 * import httpx
 * from llama_index.core.tools import FunctionTool
 *
 * def make_smallchat_tool(name: str, description: str, endpoint: str) -> FunctionTool:
 *     def execute(**kwargs):
 *         resp = httpx.post(f"{endpoint}/dispatch",
 *                           json={"intent": name, "args": kwargs})
 *         return resp.json()
 *
 *     return FunctionTool.from_defaults(
 *         fn=execute,
 *         name=name,
 *         description=description,
 *     )
 *
 * def load_smallchat_tools(endpoint: str) -> list[FunctionTool]:
 *     tools_resp = httpx.get(f"{endpoint}/tools").json()
 *     return [
 *         make_smallchat_tool(t["name"], t["description"], endpoint)
 *         for t in tools_resp["tools"]
 *     ]
 * ```
 */
export const PYTHON_ADAPTER_REFERENCE = `
See the JSDoc above for the Python LlamaIndex adapter pattern.
Use the Smallchat MCP server (/tools/list) to enumerate tools dynamically.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toJSONSchema(schema: JSONSchemaType): LlamaIndexJSONSchema {
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required,
    description: schema.description,
    title: schema.description,
  };
}

function formatOutput(result: ToolResult): string {
  if (result.isError) {
    return `Error: ${result.metadata?.error ?? 'Tool execution failed'}`;
  }
  if (typeof result.content === 'string') return result.content;
  return JSON.stringify(result.content, null, 2);
}
