import type { ToolRuntime, ToolResult, DispatchEvent } from '@smallchat/core';

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

/** What a handler is about to do, passed to `authorize`. */
export type HandlerCall =
  | { kind: 'dispatch' | 'stream'; intent: string; args: Record<string, unknown> }
  | { kind: 'list' };

/**
 * Decides whether a request may proceed: return `true` to allow, `false` to
 * refuse with 403, or a `Response` (e.g. a 401) to send as-is. Runs before
 * the runtime does any work.
 */
export type Authorize = (request: Request, call: HandlerCall) => boolean | Response | Promise<boolean | Response>;

export interface HandlerOptions {
  /** Runtime to use (default: the one passed to initSmallchat). */
  runtime?: ToolRuntime;
  /**
   * Authorization hook. Required: a dispatch route resolves an intent and
   * runs the matching tool, so an unauthenticated route lets anyone run
   * your tools. Pass `unsafePublic: true` instead to serve it to everyone.
   */
  authorize?: Authorize;
  /** Serve without authorization. Must be literally `true`. */
  unsafePublic?: true;
  /** Largest accepted request body in bytes (default 64 KiB); larger is 413. */
  maxBodyBytes?: number;
  /**
   * Web handlers refuse a runtime built with
   * `requireLLMForSubHighDispatch: false` (one that runs below-HIGH matches
   * without an LLM verifier): such intents must come back as
   * needs-disambiguation for the user to refine. Set this to serve one
   * anyway.
   */
  allowSubHighDispatch?: boolean;
  /**
   * Receives errors thrown while dispatching. The response carries only a
   * generic message. Default: console.error.
   */
  onError?: (error: unknown) => void;
}

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function requireAuthorization(name: string, options?: HandlerOptions): void {
  if (!options?.authorize && options?.unsafePublic !== true) {
    throw new Error(
      `${name}: pass authorize(request, call) to decide who may use this route, ` +
      'or unsafePublic: true to serve it to everyone. The route runs tools for whoever calls it.',
    );
  }
}

/** Runs authorize; returns the Response to send when the request is refused. */
async function checkAuthorization(options: HandlerOptions, request: Request, call: HandlerCall): Promise<Response | null> {
  if (!options.authorize) return null; // unsafePublic: true
  const verdict = await options.authorize(request, call);
  if (verdict instanceof Response) return verdict;
  return verdict === true ? null : Response.json({ error: 'Forbidden' }, { status: 403 });
}

function subHighRefusal(options: HandlerOptions, runtime: ToolRuntime): Response | null {
  if (options.allowSubHighDispatch || runtime.context.requireLLMForSubHighDispatch !== false) return null;
  return Response.json(
    {
      error: 'This runtime runs below-HIGH matches without an LLM verifier (requireLLMForSubHighDispatch: false). ' +
        'Web handlers refuse it; build the runtime with the default, or pass allowSubHighDispatch: true.',
      isError: true,
    },
    { status: 500 },
  );
}

/** Reads and validates `{ intent, args }`, refusing bodies over the limit. */
async function readBody(request: Request, maxBytes: number): Promise<DispatchRequestBody | Response> {
  const declared = Number(request.headers.get('content-length'));
  const tooLarge = () => Response.json({ error: `Request body exceeds ${maxBytes} bytes.` }, { status: 413 });
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  const chunks: Uint8Array[] = [];
  let received = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  }

  let body: DispatchRequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(concat(chunks, received))) as DispatchRequestBody;
  } catch {
    return Response.json(
      { error: 'Invalid JSON body. Expected: { "intent": "...", "args": {} }' },
      { status: 400 },
    );
  }

  if (!body || !body.intent || typeof body.intent !== 'string') {
    return Response.json(
      { error: 'Missing or invalid "intent" field. Must be a non-empty string.' },
      { status: 400 },
    );
  }
  if (body.args !== undefined && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) {
    return Response.json({ error: '"args" must be an object.' }, { status: 400 });
  }
  return body;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function reportError(options: HandlerOptions, err: unknown): void {
  (options.onError ?? ((e: unknown) => console.error('@smallchat/nextjs: dispatch failed', e)))(err);
}

/**
 * Create a Next.js App Router route handler for tool dispatch.
 *
 * Usage in app/api/dispatch/route.ts:
 *   import { createDispatchHandler } from '@smallchat/nextjs';
 *   export const POST = createDispatchHandler({
 *     authorize: async (request) => (await getSession(request))?.user != null,
 *   });
 *
 * The runtime's dispatch policy still applies: below HIGH confidence a tool
 * runs only with an LLM verifier's approval (otherwise the result is
 * needs-disambiguation), and destructive tools run only by exact id, a
 * pinned phrase or EXACT similarity.
 */
export function createDispatchHandler(options?: HandlerOptions) {
  requireAuthorization('createDispatchHandler', options);
  const opts = options!;
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function POST(request: Request): Promise<Response> {
    const runtime = opts.runtime ?? getRuntime();

    const body = await readBody(request, maxBytes);
    if (body instanceof Response) return body;
    const args = body.args ?? {};

    const refused = await checkAuthorization(opts, request, { kind: 'dispatch', intent: body.intent, args });
    if (refused) return refused;
    const misconfigured = subHighRefusal(opts, runtime);
    if (misconfigured) return misconfigured;

    try {
      const result = await runtime.dispatch(body.intent, args, { signal: request.signal });
      return Response.json(result);
    } catch (err) {
      reportError(opts, err);
      return Response.json({ error: 'Dispatch failed.', isError: true }, { status: 500 });
    }
  };
}

/**
 * Create a streaming dispatch handler using Server-Sent Events. Same
 * options and checks as createDispatchHandler.
 *
 * Usage in app/api/dispatch/stream/route.ts:
 *   import { createStreamHandler } from '@smallchat/nextjs';
 *   export const POST = createStreamHandler({ authorize });
 */
export function createStreamHandler(options?: HandlerOptions) {
  requireAuthorization('createStreamHandler', options);
  const opts = options!;
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async function POST(request: Request): Promise<Response> {
    const runtime = opts.runtime ?? getRuntime();

    const body = await readBody(request, maxBytes);
    if (body instanceof Response) return body;
    const args = body.args ?? {};

    const refused = await checkAuthorization(opts, request, { kind: 'stream', intent: body.intent, args });
    if (refused) return refused;
    const misconfigured = subHighRefusal(opts, runtime);
    if (misconfigured) return misconfigured;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        try {
          for await (const event of runtime.dispatchStream(body.intent, args, { signal: request.signal })) {
            const data = JSON.stringify(event);
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (err) {
          reportError(opts, err);
          const errorEvent = JSON.stringify({ type: 'error', error: 'Dispatch failed.' });
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
 * Requires `authorize` (called with `{ kind: 'list' }`) or `unsafePublic`.
 *
 * Usage in app/api/tools/route.ts:
 *   import { createToolListHandler } from '@smallchat/nextjs';
 *   export const GET = createToolListHandler({ authorize });
 */
export function createToolListHandler(options?: Pick<HandlerOptions, 'runtime' | 'authorize' | 'unsafePublic'>) {
  requireAuthorization('createToolListHandler', options);
  const opts = options!;

  return async function GET(request: Request): Promise<Response> {
    const refused = await checkAuthorization(opts, request, { kind: 'list' });
    if (refused) return refused;
    const runtime = opts.runtime ?? getRuntime();
    const header = runtime.generateHeader();
    return Response.json({ tools: header });
  };
}
