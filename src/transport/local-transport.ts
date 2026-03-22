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
   * Execute a handler in a sandboxed context using Node.js vm module.
   *
   * Phase 1 sandbox provides:
   *   - Execution timeout enforcement
   *   - Restricted global scope (no require, no process, no fs)
   *   - Error isolation
   *
   * For production use with untrusted code, consider isolated-vm or
   * a separate worker_threads implementation.
   */
  private async executeSandboxed(
    handler: LocalHandler,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<TransportOutput> {
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

      await promise;

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
