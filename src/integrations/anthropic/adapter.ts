/**
 * Anthropic Claude Adapter — tool definitions in Anthropic's tool use format
 *
 * Converts Smallchat ToolIMP / ToolRuntime into the JSON schemas that
 * Anthropic's Messages API expects in the `tools` parameter.
 *
 * Anthropic tool use format:
 *
 *   {
 *     name: "get_weather",
 *     description: "Get current weather...",
 *     input_schema: {
 *       type: "object",
 *       properties: { city: { type: "string" } },
 *       required: ["city"]
 *     }
 *   }
 *
 * Usage:
 *
 *   import Anthropic from '@anthropic-ai/sdk';
 *   import { toAnthropicTools, handleAnthropicToolUse } from './adapter';
 *
 *   const client = new Anthropic();
 *   const runtime = ...; // your ToolRuntime
 *
 *   const response = await client.messages.create({
 *     model: 'claude-opus-4-6',
 *     max_tokens: 4096,
 *     tools: toAnthropicTools(runtime),
 *     messages: [{ role: 'user', content: 'What is the weather in London?' }],
 *   });
 *
 *   if (response.stop_reason === 'tool_use') {
 *     const toolResults = await handleAnthropicToolUse(runtime, response.content);
 *     // Append to messages and continue the conversation
 *   }
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolIMP, ToolResult, JSONSchemaType } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Anthropic type shapes (no hard dependency on @anthropic-ai/sdk)
// ---------------------------------------------------------------------------

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: AnthropicInputSchema;
}

export interface AnthropicInputSchema {
  type: 'object';
  properties: Record<string, AnthropicPropertySchema>;
  required?: string[];
}

export interface AnthropicPropertySchema {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: AnthropicPropertySchema;
  properties?: Record<string, AnthropicPropertySchema>;
  required?: string[];
  default?: unknown;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock;

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
}

// ---------------------------------------------------------------------------
// toAnthropicTool — convert a single ToolIMP
// ---------------------------------------------------------------------------

export function toAnthropicTool(imp: ToolIMP): AnthropicTool {
  const schema = imp.schema?.inputSchema ?? { type: 'object', properties: {} };
  const description = imp.schema?.description ?? `Execute ${imp.toolName} from ${imp.providerId}`;

  // Anthropic tool names: max 64 chars, alphanumeric + underscores + hyphens
  const name = sanitizeToolName(imp.toolName);

  return {
    name,
    description,
    input_schema: jsonSchemaToAnthropicInputSchema(schema),
  };
}

// ---------------------------------------------------------------------------
// toAnthropicTools — convert an entire ToolRuntime
// ---------------------------------------------------------------------------

export function toAnthropicTools(
  runtime: ToolRuntime,
  options: { providerId?: string } = {},
): AnthropicTool[] {
  const tools: AnthropicTool[] = [];

  for (const toolClass of runtime.context.getClasses()) {
    if (options.providerId && toolClass.name !== options.providerId) continue;

    for (const [, imp] of toolClass.dispatchTable) {
      tools.push(toAnthropicTool(imp));
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// handleAnthropicToolUse — execute tool_use blocks from a response
// ---------------------------------------------------------------------------

/**
 * Process the `content` array from an Anthropic response that stopped with
 * stop_reason === 'tool_use'. Executes each tool_use block and returns
 * tool_result blocks ready to append as a user message.
 */
export async function handleAnthropicToolUse(
  runtime: ToolRuntime,
  content: AnthropicContentBlock[],
): Promise<AnthropicToolResultBlock[]> {
  const toolUseBlocks = content.filter(
    (block): block is AnthropicToolUseBlock => block.type === 'tool_use',
  );

  const impByName = buildImpLookup(runtime);
  const results: AnthropicToolResultBlock[] = [];

  for (const block of toolUseBlocks) {
    let result: ToolResult;
    const imp = impByName.get(block.name);

    if (imp) {
      result = await imp.execute(block.input);
    } else {
      // Fallback: dispatch with the tool name as intent
      result = await runtime.dispatch(block.name, block.input);
    }

    const output = result.isError
      ? `Error: ${result.metadata?.error ?? 'Tool execution failed'}`
      : typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content, null, 2);

    results.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: output,
      is_error: result.isError ?? false,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// buildAnthropicToolResultMessage — build the user message with results
// ---------------------------------------------------------------------------

/**
 * Wrap tool results as the user message to send back to Claude.
 * This is the standard pattern for multi-turn tool use.
 */
export function buildAnthropicToolResultMessage(
  toolResults: AnthropicToolResultBlock[],
): AnthropicMessage {
  return {
    role: 'user',
    content: toolResults,
  };
}

// ---------------------------------------------------------------------------
// Streaming SSE adapter for Anthropic format
// ---------------------------------------------------------------------------

export interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Convert Smallchat DispatchEvent stream to Anthropic-compatible SSE events.
 * Yields `event: ...\ndata: ...\n\n` formatted strings.
 */
export async function* dispatchToAnthropicStream(
  runtime: ToolRuntime,
  intent: string,
  args?: Record<string, unknown>,
): AsyncGenerator<string> {
  const messageId = `msg_sc${Date.now()}`;

  // message_start
  yield formatAnthropicSSE('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'smallchat',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  // content_block_start
  yield formatAnthropicSSE('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  yield formatAnthropicSSE('ping', { type: 'ping' });

  let outputTokens = 0;

  for await (const event of runtime.dispatchStream(intent, args)) {
    switch (event.type) {
      case 'inference-delta': {
        yield formatAnthropicSSE('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: event.delta.text },
        });
        outputTokens += event.delta.text.length;
        break;
      }

      case 'chunk': {
        const text =
          typeof event.content === 'string'
            ? event.content
            : JSON.stringify(event.content, null, 2);
        yield formatAnthropicSSE('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        });
        outputTokens += text.length;
        break;
      }

      case 'error': {
        yield formatAnthropicSSE('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `\nError: ${event.error}` },
        });
        break;
      }

      case 'done':
      case 'tool-start':
      case 'resolving':
        break;
    }

    if (event.type === 'done' || event.type === 'error') break;
  }

  yield formatAnthropicSSE('content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  });

  yield formatAnthropicSSE('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });

  yield formatAnthropicSSE('message_stop', { type: 'message_stop' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function jsonSchemaToAnthropicInputSchema(schema: JSONSchemaType): AnthropicInputSchema {
  const properties: Record<string, AnthropicPropertySchema> = {};

  for (const [key, val] of Object.entries(schema.properties ?? {})) {
    properties[key] = val as AnthropicPropertySchema;
  }

  return {
    type: 'object',
    properties,
    required: schema.required,
  };
}

function formatAnthropicSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function buildImpLookup(runtime: ToolRuntime): Map<string, ToolIMP> {
  const map = new Map<string, ToolIMP>();
  for (const toolClass of runtime.context.getClasses()) {
    for (const [, imp] of toolClass.dispatchTable) {
      map.set(sanitizeToolName(imp.toolName), imp);
    }
  }
  return map;
}
