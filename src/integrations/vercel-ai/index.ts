/**
 * Vercel AI SDK Provider — Smallchat as a Vercel AI SDK provider
 *
 * Integrates the Smallchat ToolRuntime with the Vercel AI SDK (ai package),
 * exposing tools and a custom language model provider.
 *
 * Two integration modes:
 *
 *  Mode A — Tool definitions (useTools / generateText)
 *    Convert Smallchat tools into the Vercel AI SDK `tool()` format.
 *
 *  Mode B — Language model provider
 *    Wrap the entire dispatch runtime as a LanguageModelV1 so it can be
 *    passed directly to generateText / streamText as the `model` param.
 *
 * Usage:
 *
 *   // Mode A — individual tools
 *   import { toVercelAITools } from './integrations/vercel-ai';
 *   const tools = toVercelAITools(runtime);
 *   const { text } = await generateText({ model: openai('gpt-4o'), tools, ... });
 *
 *   // Mode B — SmallChat as the model
 *   import { createSmallChatProvider } from './integrations/vercel-ai';
 *   const smallchat = createSmallChatProvider(runtime);
 *   const { text } = await generateText({ model: smallchat('dispatch'), prompt: ... });
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolIMP, ToolResult, JSONSchemaType } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Vercel AI SDK interface shims
// Mirrors the public API from the 'ai' package without requiring it as a
// hard dependency.
// ---------------------------------------------------------------------------

export interface VercelAITool<TParams = Record<string, unknown>, TResult = unknown> {
  description: string;
  parameters: VercelAISchema<TParams>;
  execute: (args: TParams) => Promise<TResult>;
}

export interface VercelAISchema<T = unknown> {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  description?: string;
  // Vercel AI expects a Zod-like schema; we emit the raw JSON Schema shape
  // and callers can wrap with z.object() / jsonSchema() as needed.
  _brand?: T; // phantom type for TypeScript inference
}

export type VercelAITools = Record<string, VercelAITool>;

// ---------------------------------------------------------------------------
// LanguageModelV1 shim (Vercel AI SDK core)
// ---------------------------------------------------------------------------

export interface LanguageModelV1Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export interface LanguageModelV1CallOptions {
  messages: LanguageModelV1Message[];
  prompt?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: VercelAITools;
  toolChoice?: string;
  abortSignal?: unknown;
}

export interface LanguageModelV1StreamPart {
  type: 'text-delta' | 'tool-call' | 'finish' | 'error';
  textDelta?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  finishReason?: string;
  error?: Error;
}

export interface LanguageModelV1 {
  readonly specificationVersion: 'v1';
  readonly provider: string;
  readonly modelId: string;
  doGenerate(options: LanguageModelV1CallOptions): Promise<{
    text: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
    finishReason: string;
    usage: { promptTokens: number; completionTokens: number };
  }>;
  doStream(options: LanguageModelV1CallOptions): Promise<{
    stream: AsyncIterable<LanguageModelV1StreamPart>;
    rawCall: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// toVercelAITools — convert runtime to Vercel AI SDK tool map
// ---------------------------------------------------------------------------

/**
 * Build a Vercel AI SDK tools object from a Smallchat runtime.
 *
 * Returns a plain object where each key is the tool name and each value
 * implements the VercelAITool interface.
 */
export function toVercelAITools(
  runtime: ToolRuntime,
  options: { providerId?: string } = {},
): VercelAITools {
  const tools: VercelAITools = {};

  for (const toolClass of runtime.context.getClasses()) {
    if (options.providerId && toolClass.name !== options.providerId) continue;

    for (const [, imp] of toolClass.dispatchTable) {
      const toolName = `${imp.providerId}__${imp.toolName}`.replace(/[^a-zA-Z0-9_]/g, '_');
      tools[toolName] = impToVercelAITool(imp);
    }
  }

  return tools;
}

export function impToVercelAITool(imp: ToolIMP): VercelAITool<Record<string, unknown>, unknown> {
  const schema = imp.schema?.inputSchema ?? { type: 'object', properties: {} };
  return {
    description: imp.schema?.description ?? `Execute ${imp.toolName} from ${imp.providerId}`,
    parameters: jsonSchemaToVercelSchema(schema) as VercelAISchema<Record<string, unknown>>,
    async execute(args: Record<string, unknown>): Promise<unknown> {
      const result: ToolResult = await imp.execute(args);
      if (result.isError) {
        throw new Error(String(result.metadata?.error ?? 'Tool execution failed'));
      }
      return result.content;
    },
  };
}

// ---------------------------------------------------------------------------
// createSmallChatProvider — LanguageModelV1 implementation
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI SDK LanguageModelV1 provider backed by Smallchat dispatch.
 *
 * The model ID is used as the intent — pass a descriptive string.
 *
 * Usage:
 *   const smallchat = createSmallChatProvider(runtime);
 *   const { text } = await generateText({
 *     model: smallchat('summarize a web page'),
 *     prompt: 'https://example.com',
 *   });
 */
export function createSmallChatProvider(
  runtime: ToolRuntime,
): (modelId: string) => LanguageModelV1 {
  return function createModel(modelId: string): LanguageModelV1 {
    return {
      specificationVersion: 'v1',
      provider: 'smallchat',
      modelId,

      async doGenerate(options: LanguageModelV1CallOptions) {
        const intent = extractIntent(options, modelId);
        const args = extractArgs(options);

        const result = await runtime.dispatch(intent, args);
        const text =
          result.isError
            ? `Error: ${result.metadata?.error ?? 'Dispatch failed'}`
            : typeof result.content === 'string'
              ? result.content
              : JSON.stringify(result.content, null, 2);

        return {
          text,
          finishReason: 'stop',
          usage: { promptTokens: 0, completionTokens: text.length },
        };
      },

      async doStream(options: LanguageModelV1CallOptions) {
        const intent = extractIntent(options, modelId);
        const args = extractArgs(options);

        const streamGenerator = runtime.dispatchStream(intent, args);

        async function* makeStream(): AsyncIterable<LanguageModelV1StreamPart> {
          for await (const event of streamGenerator) {
            switch (event.type) {
              case 'inference-delta':
                yield { type: 'text-delta', textDelta: event.delta.text };
                break;
              case 'chunk': {
                const text =
                  typeof event.content === 'string'
                    ? event.content
                    : JSON.stringify(event.content);
                yield { type: 'text-delta', textDelta: text };
                break;
              }
              case 'done':
                yield { type: 'finish', finishReason: 'stop' };
                break;
              case 'error':
                yield { type: 'error', error: new Error(event.error) };
                break;
            }
          }
        }

        return { stream: makeStream(), rawCall: { intent, args } };
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonSchemaToVercelSchema(schema: JSONSchemaType): VercelAISchema {
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required,
    description: schema.description,
  };
}

function extractIntent(options: LanguageModelV1CallOptions, modelId: string): string {
  // Use the last user message as the intent, falling back to the model ID
  if (options.prompt) return options.prompt;

  const userMessages = options.messages
    .filter(m => m.role === 'user')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

  return userMessages.at(-1) ?? modelId;
}

function extractArgs(options: LanguageModelV1CallOptions): Record<string, unknown> | undefined {
  // If there's a system message, pass it as context
  const systemMsg = options.messages.find(m => m.role === 'system');
  if (!systemMsg) return undefined;

  try {
    return typeof systemMsg.content === 'string'
      ? (JSON.parse(systemMsg.content) as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
