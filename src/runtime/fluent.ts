import type { ToolResult, DispatchEvent } from '../core/types.js';
import type { ToolRuntime } from './runtime.js';

/**
 * DispatchBuilder — a fluent API for constructing and executing dispatches.
 *
 * Usage:
 *   const result = await runtime.dispatch('search documents')
 *     .withArgs({ query: 'hello', limit: 10 })
 *     .exec();
 *
 *   // Or with streaming:
 *   for await (const event of runtime.dispatch('search').stream()) { ... }
 *
 *   // Or with typed arguments:
 *   const result = await runtime.dispatch<{ query: string }>('search')
 *     .withArgs({ query: 'hello' })  // fully typed
 *     .exec();
 */
export class DispatchBuilder<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  private readonly runtime: ToolRuntime;
  private readonly intent: string;
  private args: TArgs | undefined;
  private timeoutMs: number | undefined;
  private metadata: Record<string, unknown> | undefined;

  constructor(runtime: ToolRuntime, intent: string) {
    this.runtime = runtime;
    this.intent = intent;
  }

  /**
   * Set the arguments for the dispatch.
   * TypeScript will infer the argument types from the generic parameter.
   */
  withArgs<A extends TArgs>(args: A): DispatchBuilder<A> {
    const builder = this as unknown as DispatchBuilder<A>;
    builder.args = args;
    return builder;
  }

  /**
   * Set a timeout for the dispatch execution.
   */
  withTimeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  /**
   * Attach metadata to the dispatch (passed through to the result).
   */
  withMetadata(meta: Record<string, unknown>): this {
    this.metadata = meta;
    return this;
  }

  /**
   * Execute the dispatch and return the result.
   */
  async exec(): Promise<ToolResult> {
    const dispatchPromise = this.runtime.dispatch(this.intent, this.args as Record<string, unknown>);

    let result: ToolResult;
    if (this.timeoutMs !== undefined) {
      result = await withTimeout(dispatchPromise, this.timeoutMs);
    } else {
      result = await dispatchPromise;
    }

    if (this.metadata) {
      result.metadata = { ...result.metadata, ...this.metadata };
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
   * Stream the dispatch, yielding DispatchEvent objects.
   */
  stream(): AsyncGenerator<DispatchEvent> {
    return this.runtime.dispatchStream(this.intent, this.args as Record<string, unknown>);
  }

  /**
   * Stream only inference tokens (text deltas).
   */
  tokens(): AsyncGenerator<string> {
    return this.runtime.inferenceStream(this.intent, this.args as Record<string, unknown>);
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
