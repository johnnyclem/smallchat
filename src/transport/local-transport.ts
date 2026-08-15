/**
 * Local Function Transport — executes JavaScript/TypeScript functions in-process.
 *
 * Implements ITransport for local tool handlers. Supports:
 *   - Direct function execution
 *   - Optional sandboxing via Node.js vm module
 *   - Configurable timeouts and memory limits
 */

import type {
  ITransport,
  TransportInput,
  TransportOutput,
  LocalTransportConfig,
  LocalHandler,
  SandboxConfig,
  TransportKind,
} from './types.js';
import { errorToOutput, SandboxError } from './errors.js';
import { withTimeout } from './timeout.js';

let localTransportCounter = 0;
let hasWarnedAboutSandboxScope = false;

export class LocalTransport implements ITransport {
  readonly id: string;
  readonly type: TransportKind = 'local';

  private handlers: Map<string, LocalHandler>;
  private sandboxConfig: SandboxConfig | null;

  constructor(config?: LocalTransportConfig) {
    this.id = `local-${++localTransportCounter}`;
    this.handlers = config?.handlers ? new Map(config.handlers) : new Map();
    this.sandboxConfig = config?.sandbox ?? null;
  }

  /** Register a local handler for a tool name */
  registerHandler(toolName: string, handler: LocalHandler): void {
    this.handlers.set(toolName, handler);
  }

  /** Remove a handler */
  unregisterHandler(toolName: string): boolean {
    return this.handlers.delete(toolName);
  }

  /** Check if a handler is registered */
  hasHandler(toolName: string): boolean {
    return this.handlers.has(toolName);
  }

  async execute(input: TransportInput): Promise<TransportOutput> {
    const startTime = Date.now();

    try {
      const handler = this.handlers.get(input.toolName);
      if (!handler) {
        return {
          content: null,
          isError: true,
          metadata: {
            error: `No local handler registered for "${input.toolName}"`,
            code: 'HANDLER_NOT_FOUND',
          },
        };
      }

      const timeoutMs = input.timeoutMs ?? this.sandboxConfig?.timeoutMs ?? 30_000;

      let result: TransportOutput;

      if (this.sandboxConfig?.enabled) {
        result = await this.executeSandboxed(handler, input.args, timeoutMs);
      } else {
        const toolResult = await withTimeout(
          () => handler(input.args),
          timeoutMs,
          input.signal,
        );
        result = {
          content: toolResult.content,
          isError: toolResult.isError ?? false,
          metadata: toolResult.metadata,
        };
      }

      result.metadata = {
        ...result.metadata,
        durationMs: Date.now() - startTime,
      };
      return result;
    } catch (err) {
      const output = errorToOutput(err);
      output.metadata = {
        ...output.metadata,
        durationMs: Date.now() - startTime,
      };
      return output;
    }
  }

  async dispose(): Promise<void> {
    this.handlers.clear();
  }

  // ---------------------------------------------------------------------------
  // Sandbox execution
  // ---------------------------------------------------------------------------

  /**
   * Run a handler through a `node:vm` context with an enforced timeout.
   *
   * IMPORTANT — this does NOT isolate the handler's own code. `handler` is
   * a plain JS function reference registered via `registerHandler()`; it
   * keeps the full closure/module scope (require, process, fs, network,
   * etc.) it was defined with regardless of which vm context later calls
   * it. `vm.createContext` only sandboxes code compiled fresh inside that
   * context (the tiny wrapper script below) — it cannot retroactively
   * strip capabilities from a function object that already closed over
   * the outer scope. So `sandbox.enabled` gives you:
   *   - Execution timeout enforcement (via `vm.Script`'s `timeout` option)
   *   - Error isolation (a throwing handler can't crash the caller)
   * ...and nothing more. It is NOT a security boundary for handlers you
   * don't trust — do not register untrusted code as a `LocalHandler` and
   * rely on this to contain it. For untrusted code, use a separate
   * process/worker_threads with OS-level isolation, or isolated-vm.
   */
  private async executeSandboxed(
    handler: LocalHandler,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<TransportOutput> {
    if (!hasWarnedAboutSandboxScope) {
      hasWarnedAboutSandboxScope = true;
      console.warn(
        '[smallchat] LocalTransport sandbox.enabled only enforces an execution ' +
        'timeout and isolates errors — it does NOT restrict the capabilities of ' +
        'the registered handler function itself (require/process/fs remain ' +
        'reachable via its closure). Do not treat this as a security boundary ' +
        'for untrusted handler code.',
      );
    }

    try {
      // Use dynamic import so vm is only loaded when sandboxing is enabled
      const vm = await import('node:vm');

      // Create a restricted context
      const allowedModules = new Set(this.sandboxConfig?.allowedModules ?? []);

      const sandbox: Record<string, unknown> = {
        // Provide a limited console
        console: {
          log: () => {},
          warn: () => {},
          error: () => {},
        },
        // Provide setTimeout/setInterval for async operations
        setTimeout,
        clearTimeout,
        // Provide JSON
        JSON,
        // Provide the handler and args
        __handler__: handler,
        __args__: args,
        __result__: undefined as unknown,
        // Limited require for allowed modules only
        require: allowedModules.size > 0
          ? (moduleName: string) => {
              if (!allowedModules.has(moduleName)) {
                throw new SandboxError(`Module "${moduleName}" is not allowed in sandbox`);
              }
              // Dynamic require for allowed modules
              return import(moduleName);
            }
          : undefined,
      };

      const context = vm.createContext(sandbox);

      // Execute the handler within the sandbox
      const script = new vm.Script(`
        (async () => {
          __result__ = await __handler__(__args__);
        })();
      `);

      const promise = script.runInContext(context, {
        timeout: timeoutMs,
      }) as Promise<void>;

      // vm's own `timeout` option only bounds *synchronous* execution
      // inside the script; the wrapper below returns its promise almost
      // immediately (the synchronous part is just kicking off the async
      // IIFE), so a handler that awaits something that never resolves
      // would otherwise hang past timeoutMs undetected. Race it too, the
      // same way the non-sandboxed path does via withTimeout().
      let timer: ReturnType<typeof setTimeout>;
      const timeoutGuard = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        await Promise.race([promise, timeoutGuard]);
      } finally {
        clearTimeout(timer!);
      }

      const result = sandbox.__result__ as { content: unknown; isError?: boolean; metadata?: Record<string, unknown> } | undefined;

      return {
        content: result?.content ?? null,
        isError: result?.isError ?? false,
        metadata: result?.metadata,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('Script execution timed out')) {
        throw new SandboxError(`Sandbox execution timed out after ${timeoutMs}ms`, { cause: err });
      }
      throw new SandboxError(
        `Sandbox execution failed: ${(err as Error).message}`,
        { cause: err as Error },
      );
    }
  }
}
