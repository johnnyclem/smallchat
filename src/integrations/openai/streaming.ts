/**
 * OpenAI Streaming — SSE response formatting compatible with OpenAI's
 * chat completions API (/v1/chat/completions with stream: true)
 *
 * Translates Smallchat DispatchEvent streams into the exact SSE wire format
 * that OpenAI clients (openai-node, openai-python, ChatGPT plugins, etc.)
 * expect. This allows any OpenAI-compatible client to consume Smallchat
 * dispatch results without modification.
 *
 * Wire format per OpenAI spec:
 *
 *   data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234,
 *           "model":"smallchat","choices":[{"index":0,"delta":{"content":"..."},
 *           "finish_reason":null}]}\n\n
 *   ...
 *   data: {"id":"chatcmpl-...","choices":[{"index":0,"delta":{},
 *           "finish_reason":"stop"}]}\n\n
 *   data: [DONE]\n\n
 *
 * Usage (with a plain HTTP server):
 *
 *   import { dispatchToOpenAIStream } from './streaming';
 *
 *   app.post('/v1/chat/completions', async (req, res) => {
 *     const { messages, stream } = req.body;
 *     const intent = extractLastUserMessage(messages);
 *
 *     res.setHeader('Content-Type', 'text/event-stream');
 *     res.setHeader('Cache-Control', 'no-cache');
 *
 *     for await (const chunk of dispatchToOpenAIStream(runtime, intent)) {
 *       res.write(chunk);
 *     }
 *     res.end();
 *   });
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { DispatchEvent, ToolResult } from '../../core/types.js';

// ---------------------------------------------------------------------------
// OpenAI SSE chunk types
// ---------------------------------------------------------------------------

export interface OpenAIChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChoiceDelta[];
  system_fingerprint?: string;
  usage?: OpenAIUsage | null;
}

export interface OpenAIChoiceDelta {
  index: number;
  delta: OpenAIDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  logprobs?: null;
}

export interface OpenAIDelta {
  role?: 'assistant';
  content?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: OpenAIUsage;
}

// ---------------------------------------------------------------------------
// OpenAI chat request types (for compatibility checks)
// ---------------------------------------------------------------------------

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: string | Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// dispatchToOpenAIStream — main entry point
// ---------------------------------------------------------------------------

/**
 * Execute a Smallchat dispatch and yield OpenAI-formatted SSE chunks.
 *
 * Each yielded string is a complete `data: ...\n\n` line (or `data: [DONE]\n\n`).
 * Pipe these directly into an HTTP response.
 */
export async function* dispatchToOpenAIStream(
  runtime: ToolRuntime,
  intent: string,
  args?: Record<string, unknown>,
  options: OpenAIStreamOptions = {},
): AsyncGenerator<string> {
  const completionId = options.completionId ?? generateCompletionId();
  const model = options.model ?? 'smallchat';
  const created = Math.floor(Date.now() / 1000);

  // Emit role delta first (mirrors OpenAI behaviour)
  yield formatSSEChunk({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null,
      },
    ],
  });

  let tokenCount = 0;

  for await (const event of runtime.dispatchStream(intent, args)) {
    const chunks = dispatchEventToOpenAIChunks(event, completionId, model, created);
    for (const chunk of chunks) {
      yield formatSSEChunk(chunk);
      if (chunk.choices[0]?.delta.content) {
        tokenCount += chunk.choices[0].delta.content.length;
      }
    }

    // Stop streaming after done/error
    if (event.type === 'done' || event.type === 'error') break;
  }

  // Final done chunk with usage
  yield formatSSEChunk({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: tokenCount,
      total_tokens: tokenCount,
    },
  });

  // OpenAI terminator
  yield 'data: [DONE]\n\n';
}

// ---------------------------------------------------------------------------
// dispatchToOpenAICompletion — non-streaming variant
// ---------------------------------------------------------------------------

/**
 * Execute a dispatch and return a complete OpenAI chat completion object.
 * Use this for non-streaming requests (stream: false).
 */
export async function dispatchToOpenAICompletion(
  runtime: ToolRuntime,
  intent: string,
  args?: Record<string, unknown>,
  options: OpenAIStreamOptions = {},
): Promise<OpenAIChatCompletion> {
  const completionId = options.completionId ?? generateCompletionId();
  const model = options.model ?? 'smallchat';
  const created = Math.floor(Date.now() / 1000);

  const result: ToolResult = await runtime.dispatch(intent, args);
  const content = result.isError
    ? `Error: ${result.metadata?.error ?? 'Dispatch failed'}`
    : typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content, null, 2);

  return {
    id: completionId,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: content.length,
      total_tokens: content.length,
    },
  };
}

// ---------------------------------------------------------------------------
// chatRequestToDispatch — extract dispatch intent from an OpenAI chat request
// ---------------------------------------------------------------------------

/**
 * Extract the dispatch intent from an OpenAI-format chat request.
 * Uses the last user message as the intent.
 */
export function chatRequestToDispatch(request: OpenAIChatRequest): {
  intent: string;
  args?: Record<string, unknown>;
} {
  const userMessages = request.messages
    .filter(m => m.role === 'user' && m.content)
    .map(m => m.content as string);

  const intent = userMessages.at(-1) ?? '';

  return { intent };
}

// ---------------------------------------------------------------------------
// HTTP handler helper
// ---------------------------------------------------------------------------

export interface OpenAIStreamOptions {
  completionId?: string;
  model?: string;
}

/**
 * Build a complete OpenAI-compatible HTTP response handler.
 *
 * Returns a function that takes a Node.js request body (parsed JSON) and
 * a write/end callback pair, routing streaming or non-streaming as needed.
 *
 * Usage with Express:
 *
 *   const handler = createOpenAIHandler(runtime);
 *   app.post('/v1/chat/completions', async (req, res) => {
 *     await handler(req.body, {
 *       setHeader: (k, v) => res.setHeader(k, v),
 *       write: (chunk) => res.write(chunk),
 *       end: () => res.end(),
 *       json: (data) => res.json(data),
 *     });
 *   });
 */
export function createOpenAIHandler(runtime: ToolRuntime) {
  return async function handleOpenAIRequest(
    body: OpenAIChatRequest,
    responder: {
      setHeader(name: string, value: string): void;
      write(chunk: string): void;
      end(): void;
      json(data: unknown): void;
    },
  ): Promise<void> {
    const { intent, args } = chatRequestToDispatch(body);

    if (body.stream) {
      responder.setHeader('Content-Type', 'text/event-stream');
      responder.setHeader('Cache-Control', 'no-cache');
      responder.setHeader('Connection', 'keep-alive');

      for await (const chunk of dispatchToOpenAIStream(runtime, intent, args, { model: body.model })) {
        responder.write(chunk);
      }
      responder.end();
    } else {
      const completion = await dispatchToOpenAICompletion(runtime, intent, args, { model: body.model });
      responder.json(completion);
    }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function dispatchEventToOpenAIChunks(
  event: DispatchEvent,
  id: string,
  model: string,
  created: number,
): OpenAIChatCompletionChunk[] {
  switch (event.type) {
    case 'resolving':
      // Emit a zero-width content token so the client knows work has started
      return [];

    case 'tool-start':
      return [
        makeTextChunk(
          id, model, created,
          `[Executing ${event.toolName} (confidence: ${(event.confidence * 100).toFixed(0)}%)]`,
        ),
      ];

    case 'inference-delta':
      return [makeTextChunk(id, model, created, event.delta.text)];

    case 'chunk': {
      const text =
        typeof event.content === 'string'
          ? event.content
          : JSON.stringify(event.content);
      return [makeTextChunk(id, model, created, text)];
    }

    case 'done': {
      // If done carries a non-null result not seen in chunks, include it
      const result = event.result;
      if (!result.isError && result.content !== null) {
        const text =
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content, null, 2);
        // Only emit if the content is small enough to be a delta
        if (text.length < 2048) {
          return [makeTextChunk(id, model, created, text)];
        }
      }
      return [];
    }

    case 'error':
      return [makeTextChunk(id, model, created, `\n[Error: ${event.error}]`)];

    default:
      return [];
  }
}

function makeTextChunk(
  id: string,
  model: string,
  created: number,
  content: string,
): OpenAIChatCompletionChunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
}

function formatSSEChunk(chunk: OpenAIChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

let chunkCounter = 0;
function generateCompletionId(): string {
  return `chatcmpl-sc${Date.now()}${(++chunkCounter).toString(36)}`;
}
