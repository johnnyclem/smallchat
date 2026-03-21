/**
 * Semantic Kernel Integration — SmallChat connector for Microsoft Semantic Kernel
 *
 * Exposes Smallchat tools as Semantic Kernel KernelFunctions so they can be
 * used inside SK planners, pipelines, and agents.
 *
 * Usage (with @microsoft/semantic-kernel installed):
 *
 *   import { SmallChatPlugin, registerSmallChatPlugin } from '@smallchat/core/integrations/semantic-kernel';
 *   import { Kernel } from '@microsoft/semantic-kernel';
 *
 *   const kernel = new Kernel();
 *   const plugin = new SmallChatPlugin(runtime);
 *   registerSmallChatPlugin(kernel, plugin);
 *
 *   // Or use the dispatch plugin for natural-language routing:
 *   const dispatchPlugin = new SmallChatDispatchPlugin(runtime);
 *   registerSmallChatPlugin(kernel, dispatchPlugin);
 */

import type { ToolRuntime } from '../../runtime/runtime.js';
import type { ToolIMP, ToolResult, JSONSchemaType } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Semantic Kernel interface shims
// Mirrors the SK KernelFunction / KernelPlugin contracts without requiring
// @microsoft/semantic-kernel as a hard dependency.
// ---------------------------------------------------------------------------

export interface SKKernelFunctionMetadata {
  name: string;
  description: string;
  pluginName: string;
  parameters: SKParameterMetadata[];
  returnParameter?: SKReturnParameterMetadata;
}

export interface SKParameterMetadata {
  name: string;
  description: string;
  type: string;
  isRequired: boolean;
  defaultValue?: string;
  schema?: Record<string, unknown>;
}

export interface SKReturnParameterMetadata {
  description: string;
  type: string;
  schema?: Record<string, unknown>;
}

export interface SKKernelFunction {
  metadata: SKKernelFunctionMetadata;
  invoke(kernel: unknown, args?: Record<string, unknown>): Promise<SKFunctionResult>;
}

export interface SKFunctionResult {
  value: string;
  metadata: Record<string, unknown>;
}

export interface SKKernelPlugin {
  name: string;
  description: string;
  functions: Map<string, SKKernelFunction>;
  getFunctions(): SKKernelFunction[];
}

export interface SKKernel {
  plugins: {
    addFromObject(plugin: SKKernelPlugin): void;
    getFunction(pluginName: string, functionName: string): SKKernelFunction | undefined;
  };
}

// ---------------------------------------------------------------------------
// SmallChatKernelFunction — single Smallchat tool as an SK KernelFunction
// ---------------------------------------------------------------------------

export class SmallChatKernelFunction implements SKKernelFunction {
  readonly metadata: SKKernelFunctionMetadata;
  private imp: ToolIMP;

  constructor(imp: ToolIMP, pluginName: string) {
    this.imp = imp;
    this.metadata = {
      name: sanitizeName(imp.toolName),
      description: imp.schema?.description ?? `Execute ${imp.toolName} from ${imp.providerId}`,
      pluginName,
      parameters: buildSKParameters(imp.schema?.inputSchema ?? { type: 'object', properties: {} }),
      returnParameter: {
        description: 'JSON-serialized tool result',
        type: 'string',
      },
    };
  }

  async invoke(
    _kernel: unknown,
    args: Record<string, unknown> = {},
  ): Promise<SKFunctionResult> {
    const result: ToolResult = await this.imp.execute(args);

    const value = result.isError
      ? `Error: ${result.metadata?.error ?? 'Tool execution failed'}`
      : typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content, null, 2);

    return {
      value,
      metadata: {
        isError: result.isError ?? false,
        toolName: this.imp.toolName,
        providerId: this.imp.providerId,
        ...result.metadata,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// SmallChatPlugin — exposes all tools in a ToolRuntime as one SK plugin
// ---------------------------------------------------------------------------

export class SmallChatPlugin implements SKKernelPlugin {
  readonly name: string;
  readonly description: string;
  readonly functions: Map<string, SKKernelFunction>;

  constructor(runtime: ToolRuntime, pluginName = 'SmallChat') {
    this.name = pluginName;
    this.description = 'Smallchat semantic tool dispatch — routes intents to the best available tool';
    this.functions = new Map();

    for (const toolClass of runtime.context.getClasses()) {
      for (const [, imp] of toolClass.dispatchTable) {
        const fn = new SmallChatKernelFunction(imp, pluginName);
        this.functions.set(fn.metadata.name, fn);
      }
    }
  }

  getFunctions(): SKKernelFunction[] {
    return Array.from(this.functions.values());
  }
}

// ---------------------------------------------------------------------------
// SmallChatDispatchPlugin — single SK function for natural-language dispatch
// ---------------------------------------------------------------------------

export class SmallChatDispatchPlugin implements SKKernelPlugin {
  readonly name: string;
  readonly description: string;
  readonly functions: Map<string, SKKernelFunction>;

  constructor(runtime: ToolRuntime, pluginName = 'SmallChatDispatch') {
    this.name = pluginName;
    this.description = 'Semantic tool dispatch via natural-language intent';
    this.functions = new Map();

    const dispatchFn: SKKernelFunction = {
      metadata: {
        name: 'dispatch',
        description:
          'Dispatch any tool intent via Smallchat semantic routing. ' +
          'Describe what you want to do in natural language.',
        pluginName,
        parameters: [
          {
            name: 'intent',
            description: 'Natural language description of the action',
            type: 'string',
            isRequired: true,
          },
          {
            name: 'args',
            description: 'JSON string of arguments to pass to the resolved tool',
            type: 'string',
            isRequired: false,
            defaultValue: '{}',
          },
        ],
        returnParameter: {
          description: 'JSON-serialized tool result',
          type: 'string',
        },
      },
      async invoke(_kernel, callArgs = {}): Promise<SKFunctionResult> {
        const intent = String(callArgs.intent ?? '');
        const argsRaw = String(callArgs.args ?? '{}');

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsRaw) as Record<string, unknown>;
        } catch {
          // keep empty args
        }

        const result = await runtime.dispatch(intent, args);
        const value = result.isError
          ? `Error: ${result.metadata?.error ?? 'Dispatch failed'}`
          : typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content, null, 2);

        return { value, metadata: result.metadata ?? {} };
      },
    };

    this.functions.set('dispatch', dispatchFn);
  }

  getFunctions(): SKKernelFunction[] {
    return Array.from(this.functions.values());
  }
}

// ---------------------------------------------------------------------------
// registerSmallChatPlugin — convenience helper that adds a plugin to a kernel
// ---------------------------------------------------------------------------

/**
 * Register a SmallChatPlugin (or SmallChatDispatchPlugin) with an SK kernel.
 *
 * Works with both the shim SKKernel interface defined here and real
 * @microsoft/semantic-kernel Kernel instances, because we call
 * kernel.plugins.addFromObject if available, falling back gracefully.
 */
export function registerSmallChatPlugin(
  kernel: SKKernel | Record<string, unknown>,
  plugin: SKKernelPlugin,
): void {
  const k = kernel as SKKernel;
  if (typeof k.plugins?.addFromObject === 'function') {
    k.plugins.addFromObject(plugin);
  }
  // If kernel doesn't match the shim shape (custom/future SK API),
  // callers can iterate plugin.getFunctions() themselves.
}

/**
 * Convert a SmallChat runtime into a ready-to-use SK plugin map.
 * Returns both an individual-tools plugin and a dispatch plugin.
 */
export function createSemanticKernelPlugins(runtime: ToolRuntime): {
  toolPlugin: SmallChatPlugin;
  dispatchPlugin: SmallChatDispatchPlugin;
} {
  return {
    toolPlugin: new SmallChatPlugin(runtime),
    dispatchPlugin: new SmallChatDispatchPlugin(runtime),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function buildSKParameters(schema: JSONSchemaType): SKParameterMetadata[] {
  const required = new Set(schema.required ?? []);
  const params: SKParameterMetadata[] = [];

  for (const [propName, propSchema] of Object.entries(schema.properties ?? {})) {
    const s = propSchema as JSONSchemaType;
    params.push({
      name: propName,
      description: s.description ?? propName,
      type: s.type ?? 'string',
      isRequired: required.has(propName),
      defaultValue: s.default !== undefined ? String(s.default) : undefined,
      schema: propSchema as unknown as Record<string, unknown>,
    });
  }

  return params;
}
