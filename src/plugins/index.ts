/**
 * CLI Plugin System — plugin interface for community-added transports
 *
 * Defines the SmallChat plugin API so community members can publish
 * npm packages that extend Smallchat with new transports, tool providers,
 * embedders, or CLI commands.
 *
 * Plugin contract:
 *  - Export a default export that is a SmallChatPlugin instance
 *  - Package name must match /^(smallchat-plugin-|@.+\/smallchat-plugin-)/
 *  - The CLI discovers plugins by scanning node_modules for matching names
 *
 * Plugin types:
 *  1. TransportPlugin   — adds new TransportType handlers
 *  2. ProviderPlugin    — adds pre-configured tool providers
 *  3. EmbedderPlugin    — adds alternative embedding backends
 *  4. CommandPlugin     — adds new CLI commands
 *  5. MiddlewarePlugin  — intercepts dispatch (logging, auth, tracing)
 *
 * Usage (for plugin authors):
 *
 *   // my-transport/index.ts
 *   import { defineTransportPlugin } from 'smallchat/plugins';
 *
 *   export default defineTransportPlugin({
 *     name: 'my-transport',
 *     transportType: 'my-transport',
 *     execute: async (toolName, args, options) => { ... },
 *   });
 *
 * Usage (for Smallchat):
 *
 *   import { PluginRegistry } from 'smallchat/plugins';
 *
 *   const registry = new PluginRegistry(runtime);
 *   await registry.loadFromNodeModules();
 *   await registry.activate();
 */

import type { ToolRuntime } from '../runtime/runtime.js';
import type { ToolIMP, ToolResult, Embedder, VectorIndex } from '../core/types.js';
import type { ToolClass } from '../core/tool-class.js';

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

export interface PluginMetadata {
  /** Plugin name (should match npm package name without "smallchat-plugin-" prefix) */
  name: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** Plugin author */
  author?: string;
  /** Min Smallchat version required */
  minSmallchatVersion?: string;
  /** Plugin homepage or repository */
  homepage?: string;
}

// ---------------------------------------------------------------------------
// Plugin API context — passed to plugin.activate()
// ---------------------------------------------------------------------------

export interface PluginContext {
  runtime: ToolRuntime;
  /** Register a new ToolClass (provider) */
  registerToolClass(toolClass: ToolClass): void;
  /** Register a new transport handler */
  registerTransport(type: string, handler: TransportHandler): void;
  /** Replace the embedder */
  setEmbedder(embedder: Embedder): void;
  /** Replace the vector index */
  setVectorIndex(vectorIndex: VectorIndex): void;
  /** Register a dispatch middleware */
  addMiddleware(middleware: DispatchMiddleware): void;
  /** Emit a log message */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

// ---------------------------------------------------------------------------
// Transport handler interface
// ---------------------------------------------------------------------------

export interface TransportHandler {
  execute(toolName: string, args: Record<string, unknown>, options: TransportExecuteOptions): Promise<ToolResult>;
  executeStream?(toolName: string, args: Record<string, unknown>, options: TransportExecuteOptions): AsyncGenerator<ToolResult>;
}

export interface TransportExecuteOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Dispatch middleware
// ---------------------------------------------------------------------------

export type DispatchMiddleware = (
  intent: string,
  args: Record<string, unknown> | undefined,
  next: (intent: string, args?: Record<string, unknown>) => Promise<ToolResult>,
) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Base plugin class
// ---------------------------------------------------------------------------

export abstract class SmallChatPlugin {
  abstract readonly metadata: PluginMetadata;

  /** Called when the plugin is activated. Register all capabilities here. */
  abstract activate(context: PluginContext): Promise<void> | void;

  /** Optional cleanup when plugin is deactivated. */
  deactivate?(): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Transport plugin
// ---------------------------------------------------------------------------

export interface TransportPluginDef {
  name: string;
  version?: string;
  description?: string;
  transportType: string;
  handler: TransportHandler;
}

export function defineTransportPlugin(def: TransportPluginDef): SmallChatPlugin {
  return new (class extends SmallChatPlugin {
    readonly metadata: PluginMetadata = {
      name: def.name,
      version: def.version ?? '1.0.0',
      description: def.description ?? `Transport plugin: ${def.transportType}`,
    };

    activate(context: PluginContext): void {
      context.registerTransport(def.transportType, def.handler);
      context.log('info', `Transport plugin activated: ${def.transportType}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Provider plugin
// ---------------------------------------------------------------------------

export interface ProviderPluginDef {
  name: string;
  version?: string;
  description?: string;
  /** Factory to create ToolClass instances (called with the runtime context) */
  createProviders(context: PluginContext): ToolClass[] | Promise<ToolClass[]>;
}

export function defineProviderPlugin(def: ProviderPluginDef): SmallChatPlugin {
  return new (class extends SmallChatPlugin {
    readonly metadata: PluginMetadata = {
      name: def.name,
      version: def.version ?? '1.0.0',
      description: def.description ?? `Provider plugin: ${def.name}`,
    };

    async activate(context: PluginContext): Promise<void> {
      const providers = await def.createProviders(context);
      for (const provider of providers) {
        context.registerToolClass(provider);
        context.log('info', `Provider registered: ${provider.name}`);
      }
    }
  })();
}

// ---------------------------------------------------------------------------
// Embedder plugin
// ---------------------------------------------------------------------------

export interface EmbedderPluginDef {
  name: string;
  version?: string;
  description?: string;
  createEmbedder(): Embedder | Promise<Embedder>;
}

export function defineEmbedderPlugin(def: EmbedderPluginDef): SmallChatPlugin {
  return new (class extends SmallChatPlugin {
    readonly metadata: PluginMetadata = {
      name: def.name,
      version: def.version ?? '1.0.0',
      description: def.description ?? `Embedder plugin: ${def.name}`,
    };

    async activate(context: PluginContext): Promise<void> {
      const embedder = await def.createEmbedder();
      context.setEmbedder(embedder);
      context.log('info', `Embedder activated: ${def.name} (${embedder.dimensions}d)`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Middleware plugin
// ---------------------------------------------------------------------------

export interface MiddlewarePluginDef {
  name: string;
  version?: string;
  description?: string;
  middleware: DispatchMiddleware;
}

export function defineMiddlewarePlugin(def: MiddlewarePluginDef): SmallChatPlugin {
  return new (class extends SmallChatPlugin {
    readonly metadata: PluginMetadata = {
      name: def.name,
      version: def.version ?? '1.0.0',
      description: def.description ?? `Middleware plugin: ${def.name}`,
    };

    activate(context: PluginContext): void {
      context.addMiddleware(def.middleware);
      context.log('info', `Middleware registered: ${def.name}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// PluginRegistry — discovery, loading, and activation
// ---------------------------------------------------------------------------

export class PluginRegistry {
  private runtime: ToolRuntime;
  private plugins: Map<string, SmallChatPlugin> = new Map();
  private activePlugins: Set<string> = new Set();
  private transportHandlers: Map<string, TransportHandler> = new Map();
  private middlewares: DispatchMiddleware[] = [];
  private logs: PluginLogEntry[] = [];

  constructor(runtime: ToolRuntime) {
    this.runtime = runtime;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register(plugin: SmallChatPlugin): void {
    this.plugins.set(plugin.metadata.name, plugin);
  }

  // ---------------------------------------------------------------------------
  // Auto-discovery from node_modules
  // ---------------------------------------------------------------------------

  async loadFromNodeModules(nodeModulesPath?: string): Promise<string[]> {
    const path = await import('path');
    const fs = await import('fs/promises');

    const nmPath = nodeModulesPath ?? path.join(process.cwd(), 'node_modules');
    const loaded: string[] = [];

    let entries: string[] = [];
    try {
      entries = await fs.readdir(nmPath);
    } catch {
      return loaded;
    }

    for (const entry of entries) {
      // Scoped packages (@scope/smallchat-plugin-*)
      if (entry.startsWith('@')) {
        try {
          const scopeEntries = await fs.readdir(path.join(nmPath, entry));
          for (const pkg of scopeEntries) {
            if (pkg.startsWith('smallchat-plugin-')) {
              loaded.push(...await this.tryLoadPlugin(path.join(nmPath, entry, pkg)));
            }
          }
        } catch { /* skip */ }
        continue;
      }

      // Unscoped packages (smallchat-plugin-*)
      if (entry.startsWith('smallchat-plugin-')) {
        loaded.push(...await this.tryLoadPlugin(path.join(nmPath, entry)));
      }
    }

    return loaded;
  }

  private async tryLoadPlugin(pkgPath: string): Promise<string[]> {
    try {
      const mod = await import(pkgPath) as { default?: SmallChatPlugin };
      const plugin = mod.default;

      if (plugin instanceof SmallChatPlugin) {
        this.register(plugin);
        return [plugin.metadata.name];
      }
    } catch (err) {
      this.log('warn', `Failed to load plugin from ${pkgPath}: ${(err as Error).message}`);
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Activation
  // ---------------------------------------------------------------------------

  async activate(pluginName?: string): Promise<void> {
    const toActivate = pluginName
      ? [this.plugins.get(pluginName)].filter(Boolean) as SmallChatPlugin[]
      : Array.from(this.plugins.values());

    const context = this.buildContext();

    for (const plugin of toActivate) {
      if (this.activePlugins.has(plugin.metadata.name)) continue;

      try {
        await plugin.activate(context);
        this.activePlugins.add(plugin.metadata.name);
        this.log('info', `Plugin activated: ${plugin.metadata.name} v${plugin.metadata.version}`);
      } catch (err) {
        this.log('error', `Plugin activation failed: ${plugin.metadata.name}`, err);
      }
    }
  }

  async deactivate(pluginName?: string): Promise<void> {
    const toDeactivate = pluginName
      ? [this.plugins.get(pluginName)].filter(Boolean) as SmallChatPlugin[]
      : Array.from(this.plugins.values());

    for (const plugin of toDeactivate) {
      if (!this.activePlugins.has(plugin.metadata.name)) continue;

      try {
        await plugin.deactivate?.();
        this.activePlugins.delete(plugin.metadata.name);
      } catch (err) {
        this.log('warn', `Plugin deactivation error: ${plugin.metadata.name}`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Middleware chain
  // ---------------------------------------------------------------------------

  wrapDispatch(
    baseDispatch: (intent: string, args?: Record<string, unknown>) => Promise<ToolResult>,
  ): (intent: string, args?: Record<string, unknown>) => Promise<ToolResult> {
    if (this.middlewares.length === 0) return baseDispatch;

    const chain = [...this.middlewares].reverse();

    return (intent: string, args?: Record<string, unknown>): Promise<ToolResult> => {
      let index = 0;
      const run = (i: string, a?: Record<string, unknown>): Promise<ToolResult> => {
        if (index >= chain.length) return baseDispatch(i, a);
        const mw = chain[index++];
        return mw(i, a, run);
      };
      return run(intent, args);
    };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  list(): Array<{ name: string; version: string; active: boolean }> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.metadata.name,
      version: p.metadata.version,
      active: this.activePlugins.has(p.metadata.name),
    }));
  }

  getTransportHandler(type: string): TransportHandler | undefined {
    return this.transportHandlers.get(type);
  }

  getLogs(): PluginLogEntry[] {
    return [...this.logs];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildContext(): PluginContext {
    const registry = this;
    return {
      runtime: this.runtime,
      registerToolClass: (toolClass: ToolClass) => {
        this.runtime.registerClass(toolClass);
      },
      registerTransport: (type: string, handler: TransportHandler) => {
        registry.transportHandlers.set(type, handler);
      },
      setEmbedder: (_embedder: Embedder) => {
        // Hot-swap the embedder — would require runtime.setEmbedder() in a future version
        registry.log('warn', 'Embedder hot-swap not yet supported in this runtime version');
      },
      setVectorIndex: (_vectorIndex: VectorIndex) => {
        registry.log('warn', 'VectorIndex hot-swap not yet supported in this runtime version');
      },
      addMiddleware: (middleware: DispatchMiddleware) => {
        registry.middlewares.push(middleware);
      },
      log: (level, message, data?) => {
        registry.log(level, message, data);
      },
    };
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void {
    this.logs.push({ level, message, data, timestamp: Date.now() });
    if (this.logs.length > 10000) this.logs.shift();
  }
}

export interface PluginLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
  timestamp: number;
}

