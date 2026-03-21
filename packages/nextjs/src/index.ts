import type { ToolRuntime, ToolResult, DispatchEvent } from 'smallchat';

// ---------------------------------------------------------------------------
// Runtime singleton management
// ---------------------------------------------------------------------------

let globalRuntime: ToolRuntime | null = null;

/**
 * Initialize the smallchat runtime for use in API routes.
 * Call this once in your application startup (e.g., instrumentation.ts).
 */
export function initSmallchat(runtime: ToolRuntime): void {
  globalRuntime = runtime;
}

/**
 * Get the initialized runtime. Throws if not yet initialized.
 */
export function getRuntime(): ToolRuntime {
  if (!globalRuntime) {
    throw new Error(
      'smallchat runtime not initialized. Call initSmallchat(runtime) first.\n' +
      'Hint: Initialize in your instrumentation.ts or a server-side module.',
    );
  }
  return globalRuntime;
}

// ---------------------------------------------------------------------------
// Route handler helpers (App Router)
// ---------------------------------------------------------------------------

export interface DispatchRequestBody {
  intent: string;
  args?: Record<string, unknown>;
}

/**
 * Create a Next.js App Router route handler for tool dispatch.
 *
 * Usage in app/api/dispatch/route.ts:
 *   import { createDispatchHandler } from '@smallchat/nextjs';
 *   export const POST = createDispatchHandler();
 */
export function createDispatchHandler(options?: { runtime?: ToolRuntime }) {
  return async function POST(request: Request): Promise<Response> {
    const runtime = options?.runtime ?? getRuntime();

    let body: DispatchRequestBody;
    try {
      body = await request.json() as DispatchRequestBody;
    } catch {
      return Response.json(
        { error: 'Invalid JSON body. Expected: { "intent": "...", "args": {} }' },
        { status: 400 },
      );
    }

    if (!body.intent || typeof body.intent !== 'string') {
      return Response.json(
        { error: 'Missing or invalid "intent" field. Must be a non-empty string.' },
        { status: 400 },
      );
    }

    try {
      const result = await runtime.dispatch(body.intent, body.args);
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: message, isError: true },
        { status: 500 },
      );
    }
  };
}

/**
 * Create a streaming dispatch handler using Server-Sent Events.
 *
 * Usage in app/api/dispatch/stream/route.ts:
 *   import { createStreamHandler } from '@smallchat/nextjs';
 *   export const POST = createStreamHandler();
 */
export function createStreamHandler(options?: { runtime?: ToolRuntime }) {
  return async function POST(request: Request): Promise<Response> {
    const runtime = options?.runtime ?? getRuntime();

    let body: DispatchRequestBody;
    try {
      body = await request.json() as DispatchRequestBody;
    } catch {
      return Response.json(
        { error: 'Invalid JSON body. Expected: { "intent": "...", "args": {} }' },
        { status: 400 },
      );
    }

    if (!body.intent || typeof body.intent !== 'string') {
      return Response.json(
        { error: 'Missing or invalid "intent" field. Must be a non-empty string.' },
        { status: 400 },
      );
    }

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          for await (const event of runtime.dispatchStream(body.intent, body.args)) {
            const data = JSON.stringify(event);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorEvent = JSON.stringify({ type: 'error', error: message });
          controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  };
}

/**
 * Create a handler that lists all available tools (for discovery UIs).
 *
 * Usage in app/api/tools/route.ts:
 *   import { createToolListHandler } from '@smallchat/nextjs';
 *   export const GET = createToolListHandler();
 */
export function createToolListHandler(options?: { runtime?: ToolRuntime }) {
  return async function GET(): Promise<Response> {
    const runtime = options?.runtime ?? getRuntime();
    const header = runtime.generateHeader();
    return Response.json({ tools: header });
  };
}
