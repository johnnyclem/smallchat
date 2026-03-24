import type { DispatchEvent, ToolResult } from '../core/types.js';
import { toolkit_dispatch, smallchat_dispatchStream } from './dispatch.js';
import type { DispatchContext } from './dispatch.js';

/**
 * DispatchBuilder — fluent interface for constructing and executing a dispatch.
 *
 * Usage:
 *   const result = await runtime.dispatch("search documents").withArgs({ query: "foo" }).exec();
 *   const stream = runtime.dispatch("summarise").withArgs({ url }).stream();
 *   for await (const token of runtime.dispatch("explain").withArgs({ code }).inferStream()) { ... }
 *
 * TypeScript generics carry the args shape through the chain so `.exec()` and
 * `.stream()` always know the concrete argument types.
 */
export class DispatchBuilder<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  private readonly _context: DispatchContext;
  private readonly _intent: string;
  private _args: TArgs;
  private _timeoutMs: number | undefined;
  private _metadata: Record<string, unknown> | undefined;

  constructor(context: DispatchContext, intent: string, args: TArgs = {} as TArgs) {
    this._context = context;
    this._intent = intent;
    this._args = args;
  }

  /**
   * Attach typed arguments to the dispatch.
   *
   * Returns a new builder with the args shape narrowed to T, enabling
   * full TypeScript inference downstream.
   *
   * @example
   *   runtime.dispatch("fetch url").withArgs({ url: "https://example.com" }).exec()
   */
  withArgs<T extends Record<string, unknown>>(args: T): DispatchBuilder<T> {
    return new DispatchBuilder<T>(this._context, this._intent, args);
  }

  /**
   * Set a timeout for the dispatch execution.
   */
  withTimeout(ms: number): this {
    this._timeoutMs = ms;
    return this;
  }

  /**
   * Attach metadata to the dispatch (passed through to the result).
   */
  withMetadata(meta: Record<string, unknown>): this {
    this._metadata = meta;
    return this;
  }

  /**
   * Execute the dispatch and return a single ToolResult.
   *
   * Equivalent to the legacy `runtime.dispatch(intent, args)`.
   */
  async exec(): Promise<ToolResult> {
    const dispatchPromise = toolkit_dispatch(this._context, this._intent, this._args);

    let result: ToolResult;
    if (this._timeoutMs !== undefined) {
      result = await withTimeout(dispatchPromise, this._timeoutMs);
    } else {
      result = await dispatchPromise;
    }

    if (this._metadata) {
      result.metadata = { ...result.metadata, ...this._metadata };
    }

    return result;
  }

  /**
   * Execute and return only the content field of the result.
   */
  async execContent<T = unknown>(): Promise<T> {
    const result = await this.exec();
    return result.content as T;
  }

  /**
   * Execute as a streaming dispatch, yielding DispatchEvent objects.
   *
   * Event flow: resolving → tool-start → chunk* / inference-delta* → done | error
   */
  stream(): AsyncGenerator<DispatchEvent> {
    return smallchat_dispatchStream(this._context, this._intent, this._args);
  }

  /**
   * Convenience generator that yields only token text from inference deltas.
   *
   * Falls back to yielding full chunk content if the resolved IMP does not
   * support progressive inference.
   *
   * @example
   *   for await (const token of runtime.dispatch("summarise").withArgs({ url }).inferStream()) {
   *     process.stdout.write(token);
   *   }
   */
  async *inferStream(): AsyncGenerator<string> {
    let sawDelta = false;
    for await (const event of this.stream()) {
      if (event.type === 'inference-delta') {
        sawDelta = true;
        yield event.delta.text;
      } else if (event.type === 'chunk' && !sawDelta) {
        const text =
          typeof event.content === 'string'
            ? event.content
            : JSON.stringify(event.content);
        yield text;
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    }
  }

  /**
   * Stream only inference tokens (text deltas).
   * Alias for inferStream() for API compatibility.
   */
  tokens(): AsyncGenerator<string> {
    return this.inferStream();
  }

  /**
   * Execute the dispatch and collect all streamed chunks into an array.
   */
  async collect(): Promise<unknown[]> {
    const chunks: unknown[] = [];
    for await (const event of this.stream()) {
      if (event.type === 'chunk') {
        chunks.push(event.content);
      }
    }
    return chunks;
  }
}

/**
 * Helper to wrap a promise with a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Dispatch timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
