/**
 * OpenAI Assistant Adapter — sync Smallchat tools to OpenAI Assistant tool definitions
 *
 * Converts a ToolRuntime (or individual ToolIMP) into the JSON format that
 * the OpenAI Assistants API expects in the `tools` array of a create/update
 * request.
 *
 * Supported conversions:
 *  - toOpenAIAssistantTools(runtime)   → AssistantTool[] for /v1/assistants
 *  - toOpenAIFunctionTool(imp)         → Single FunctionTool definition
 *  - handleAssistantToolCall(...)      → Execute a tool_call from a run step
 *  - submitToolOutputs(...)            → Build the submit_tool_outputs request body
 *
 * Usage:
 *
 *   import OpenAI from 'openai';
 *   import { toOpenAIAssistantTools, handleAssistantToolCall } from './assistant-adapter';
 *
 *   const openai = new OpenAI();
 *   const runtime = ...; // your ToolRuntime
 *
 *   // Create/update assistant with Smallchat tools
 *   const assistant = await openai.beta.assistants.create({
 *     name: 'My Agent',
 *     model: 'gpt-4o',
 *     tools: toOpenAIAssistantTools(runtime),
 *   });
 *
 *   // Poll a run and handle required_action
 *   const outputs = await handleAssistantToolCall(runtime, run.required_action.submit_tool_outputs);
 *   await openai.beta.threads.runs.submitToolOutputs(threadId, runId, { tool_outputs: outputs });
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolIMP, ToolResult, JSONSchemaType } from '../../core/types.js';

// ---------------------------------------------------------------------------
// OpenAI type shapes (no hard dependency on openai package)
// ---------------------------------------------------------------------------

export interface OpenAIFunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  strict?: boolean;
}

export interface OpenAIAssistantFunctionTool {
  type: 'function';
  function: OpenAIFunctionDefinition;
}

export type OpenAIAssistantTool =
  | OpenAIAssistantFunctionTool
  | { type: 'code_interpreter' }
  | { type: 'file_search' };

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded string
  };
}

export interface OpenAIToolOutput {
  tool_call_id: string;
  output: string;
}

export interface OpenAISubmitToolOutputs {
  tool_calls: OpenAIToolCall[];
}

// ---------------------------------------------------------------------------
// toOpenAIFunctionTool — convert a single ToolIMP
// ---------------------------------------------------------------------------

export function toOpenAIFunctionTool(imp: ToolIMP): OpenAIAssistantFunctionTool {
  const schema = imp.schema?.inputSchema ?? { type: 'object', properties: {} };
  const description = imp.schema?.description ?? `Execute ${imp.toolName} from ${imp.providerId}`;

  // OpenAI function names must be ≤64 chars, alphanumeric + underscores
  const name = sanitizeToolName(`${imp.providerId}__${imp.toolName}`);

  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: schemaToOpenAIParameters(schema),
      strict: false,
    },
  };
}

// ---------------------------------------------------------------------------
// toOpenAIAssistantTools — convert an entire ToolRuntime
// ---------------------------------------------------------------------------

/**
 * Build the `tools` array for an OpenAI Assistants create/update request.
 *
 * @param runtime  - The populated ToolRuntime
 * @param options  - Optional extras like code_interpreter or file_search
 */
export function toOpenAIAssistantTools(
  runtime: ToolRuntime,
  options: {
    includeCodeInterpreter?: boolean;
    includeFileSearch?: boolean;
    providerId?: string; // Only include tools from this provider
  } = {},
): OpenAIAssistantTool[] {
  const tools: OpenAIAssistantTool[] = [];

  for (const toolClass of runtime.context.getClasses()) {
    if (options.providerId && toolClass.name !== options.providerId) continue;

    for (const [, imp] of toolClass.dispatchTable) {
      tools.push(toOpenAIFunctionTool(imp));
    }
  }

  if (options.includeCodeInterpreter) {
    tools.push({ type: 'code_interpreter' });
  }

  if (options.includeFileSearch) {
    tools.push({ type: 'file_search' });
  }

  return tools;
}

// ---------------------------------------------------------------------------
// toOpenAIToolDefinitions — chat completions API format (not Assistants)
// ---------------------------------------------------------------------------

export interface OpenAIChatTool {
  type: 'function';
  function: OpenAIFunctionDefinition;
}

/**
 * Build the `tools` array for the Chat Completions API.
 * Same structure as Assistants but without code_interpreter / file_search.
 */
export function toOpenAIChatTools(runtime: ToolRuntime): OpenAIChatTool[] {
  const tools: OpenAIChatTool[] = [];
  for (const toolClass of runtime.context.getClasses()) {
    for (const [, imp] of toolClass.dispatchTable) {
      tools.push(toOpenAIFunctionTool(imp) as OpenAIChatTool);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// handleAssistantToolCall — execute tool calls from a required_action step
// ---------------------------------------------------------------------------

/**
 * Execute all tool calls from a run's `required_action.submit_tool_outputs`
 * and return the outputs array ready for submitToolOutputs().
 *
 * Resolves each tool_call by:
 *  1. Matching the function name back to a ToolIMP (exact lookup)
 *  2. Falling back to toolkit_dispatch with the function name as intent
 */
export async function handleAssistantToolCall(
  runtime: ToolRuntime,
  submitToolOutputs: OpenAISubmitToolOutputs,
): Promise<OpenAIToolOutput[]> {
  const outputs: OpenAIToolOutput[] = [];

  // Build a quick name→IMP lookup
  const impByName = buildImpLookup(runtime);

  for (const toolCall of submitToolOutputs.tool_calls) {
    if (toolCall.type !== 'function') continue;

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch {
      // keep empty args
    }

    let result: ToolResult;
    const imp = impByName.get(toolCall.function.name);

    if (imp) {
      result = await imp.execute(args);
    } else {
      // Fallback: use dispatch with the function name as the intent
      result = await runtime.dispatch(toolCall.function.name, args);
    }

    const output = result.isError
      ? JSON.stringify({ error: result.metadata?.error ?? 'Tool execution failed' })
      : typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content);

    outputs.push({
      tool_call_id: toolCall.id,
      output,
    });
  }

  return outputs;
}

// ---------------------------------------------------------------------------
// Sync helpers for Assistants API
// ---------------------------------------------------------------------------

/**
 * Diff the current assistant tool definitions against what the runtime
 * provides and return an update payload if changes are detected.
 *
 * @returns null if no update is needed, otherwise the tools array to send.
 */
export function diffAssistantTools(
  currentTools: OpenAIAssistantTool[],
  runtime: ToolRuntime,
): OpenAIAssistantTool[] | null {
  const desired = toOpenAIAssistantTools(runtime);

  const currentSet = new Set(currentTools.map(t => JSON.stringify(t)));
  const desiredSet = new Set(desired.map(t => JSON.stringify(t)));

  const hasChanges =
    currentSet.size !== desiredSet.size ||
    [...desiredSet].some(t => !currentSet.has(t));

  return hasChanges ? desired : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function schemaToOpenAIParameters(schema: JSONSchemaType): OpenAIFunctionDefinition['parameters'] {
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
  };
}

function buildImpLookup(runtime: ToolRuntime): Map<string, ToolIMP> {
  const map = new Map<string, ToolIMP>();
  for (const toolClass of runtime.context.getClasses()) {
    for (const [, imp] of toolClass.dispatchTable) {
      const key = sanitizeToolName(`${imp.providerId}__${imp.toolName}`);
      map.set(key, imp);
    }
  }
  return map;
}
