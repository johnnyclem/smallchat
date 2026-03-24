import type { Embedder, ToolCategory, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex, OverloadTableData, InvalidationHook, CacheVersionContext, DispatchEvent, InferenceDelta } from '../core/types.js';
import { ResolutionCache, computeSchemaFingerprint } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { OverloadTable } from '../core/overload-table.js';
import { DispatchContext, toolkit_dispatch, smallchat_dispatchStream } from './dispatch.js';
import type { SCMethodSignature } from '../core/sc-types.js';
import { DispatchBuilder } from './dispatch-builder.js';
import { SelectorNamespace } from '../core/selector-namespace.js';

/**
 * ToolRuntime — the top-level runtime that manages everything.
 *
 * Owns the selector table, dispatch context, tool classes, and provides
 * the main dispatch entry point. Also supports method swizzling for
 * contextual tool replacement.
 */
export class ToolRuntime {
  readonly selectorTable: SelectorTable;
  readonly cache: ResolutionCache;
  readonly context: DispatchContext;
  readonly selectorNamespace: SelectorNamespace;

  private vectorIndex: VectorIndex;
  private embedder: Embedder;

  constructor(vectorIndex: VectorIndex, embedder: Embedder, options?: RuntimeOptions) {
    this.vectorIndex = vectorIndex;
    this.embedder = embedder;

    this.selectorTable = new SelectorTable(
      vectorIndex,
      embedder,
      options?.selectorThreshold ?? 0.95,
    );

    const versionContext: CacheVersionContext = {
      providerVersions: new Map(),
      modelVersion: options?.modelVersion ?? '',
      schemaFingerprints: new Map(),
    };

    this.cache = new ResolutionCache(
      options?.cacheSize ?? 1024,
      options?.minConfidence ?? 0.85,
      versionContext,
    );

    this.selectorNamespace = options?.selectorNamespace ?? new SelectorNamespace();

    this.context = new DispatchContext(
      this.selectorTable,
      this.cache,
      vectorIndex,
      embedder,
      this.selectorNamespace,
    );
  }

  /**
   * Register a tool class (provider).
   *
   * Throws SelectorShadowingError if the class contains selectors that
   * would shadow protected core selectors.
   */
  registerClass(toolClass: ToolClass): void {
    this.context.registerClass(toolClass);
  }

  /**
   * Register a tool class as a core system provider.
   *
   * All of its current selectors are marked as core (protected by default).
   * Future ToolClasses cannot shadow these selectors unless they are
   * explicitly marked as swizzlable.
   */
  registerCoreClass(toolClass: ToolClass, options?: { swizzlable?: boolean }): void {
    this.context.registerClass(toolClass);

    const swizzlable = options?.swizzlable ?? false;
    const selectors = Array.from(toolClass.dispatchTable.keys()).map(canonical => ({
      canonical,
      swizzlable,
    }));
    this.selectorNamespace.registerCoreSelectors(toolClass.name, selectors);
  }

  /** Register a protocol */
  registerProtocol(protocol: ToolProtocol): void {
    this.context.registerProtocol(protocol);
  }

  /**
   * Load a category — bolts methods onto all providers conforming
   * to the specified protocol.
   *
   * Like +load on an Obj-C category: the runtime adds the new methods
   * to all conforming classes and flushes the cache.
   */
  loadCategory(category: ToolCategory): void {
    // Guard: check that category methods don't shadow protected core selectors
    const categorySelectors = category.methods.map(m => m.selector.canonical);

    for (const toolClass of this.context.getClasses()) {
      const conforming = toolClass.protocols.some(
        p => p.name === category.extendsProtocol,
      );
      if (!conforming) continue;

      // Only check shadowing for selectors being added to this class
      this.selectorNamespace.assertNoShadowing(toolClass.name, categorySelectors);

      for (const method of category.methods) {
        toolClass.addMethod(method.selector, method.imp);
      }
    }

    // Flush cache — new methods may shadow cached resolutions
    this.cache.flush();
  }

  /**
   * Register an overloaded method on a tool class.
   */
  addOverload(
    toolClass: ToolClass,
    selector: ToolSelector,
    signature: SCMethodSignature,
    imp: ToolIMP,
    options?: { originalToolName?: string; isSemanticOverload?: boolean },
  ): void {
    // Guard: check that the overload doesn't shadow a protected core selector
    this.selectorNamespace.assertNoShadowing(toolClass.name, [selector.canonical]);

    toolClass.addOverload(selector, signature, imp, options);
    // Flush cache — overloads change resolution behavior
    this.cache.flush();
  }

  /**
   * Swizzle: replace the IMP for a selector in a specific provider.
   * Returns the original IMP.
   *
   * Use cases: testing/mocking, environment-specific routing,
   * capability upgrades mid-session.
   */
  swizzle(
    toolClass: ToolClass,
    selector: ToolSelector,
    newImp: ToolIMP,
  ): ToolIMP | null {
    // Guard: core selectors can only be swizzled if marked swizzlable.
    // The owning class is always allowed to swizzle its own selectors.
    this.selectorNamespace.assertNoShadowing(toolClass.name, [selector.canonical]);

    const original = toolClass.dispatchTable.get(selector.canonical) ?? null;
    toolClass.dispatchTable.set(selector.canonical, newImp);

    // Flush cache entries for this selector — critical!
    this.cache.flushSelector(selector);

    return original;
  }

  /**
   * Fluent dispatch — returns a DispatchBuilder for chaining .withArgs().exec()/.stream().
   *
   * @example
   *   // Fluent (new):
   *   const result = await runtime.dispatch("fetch url").withArgs({ url }).exec();
   *   // for await (const tok of runtime.dispatch("summarise").withArgs({ url }).inferStream()) ...
   *
   *   // Direct (legacy):
   *   const result = await runtime.dispatch("fetch url", { url });
   */
  dispatch(intent: string): DispatchBuilder;
  dispatch(intent: string, args: Record<string, unknown>): Promise<ToolResult>;
  dispatch(
    intent: string,
    args?: Record<string, unknown>,
  ): DispatchBuilder | Promise<ToolResult> {
    if (args !== undefined) {
      return toolkit_dispatch(this.context, intent, args);
    }
    return new DispatchBuilder(this.context, intent);
  }

  /**
   * Fluent dispatch builder — chainable API for constructing dispatches.
   *
   * Usage:
   *   const result = await runtime.intent('search documents')
   *     .withArgs({ query: 'hello', limit: 10 })
   *     .exec();
   *
   *   // With full TypeScript inference:
   *   const result = await runtime.intent<{ query: string; limit?: number }>('search')
   *     .withArgs({ query: 'hello' })
   *     .exec();
   *
   *   // Streaming:
   *   for await (const event of runtime.intent('search').stream()) { ... }
   *
   *   // Token-level streaming:
   *   for await (const token of runtime.intent('summarise').tokens()) { ... }
   */
  intent<TArgs extends Record<string, unknown> = Record<string, unknown>>(
    intentStr: string,
  ): DispatchBuilder<TArgs> {
    return new DispatchBuilder<TArgs>(this.context, intentStr);
  }

  // ---------------------------------------------------------------------------
  // Version management — provider + model version tagging
  // ---------------------------------------------------------------------------

  /**
   * Set a provider's version. Cached entries for this provider auto-expire
   * on next lookup if the version has changed.
   */
  setProviderVersion(providerId: string, version: string): void {
    this.cache.setProviderVersion(providerId, version);
  }

  /**
   * Set the model/embedder version. All cached entries become stale
   * if they were tagged with a different model version.
   */
  setModelVersion(version: string): void {
    this.cache.setModelVersion(version);
  }

  /**
   * Recompute and update a provider's schema fingerprint.
   * Call this after a provider hot-reloads or changes its tool schemas.
   * Stale cache entries auto-expire on next lookup.
   */
  updateSchemaFingerprint(toolClass: ToolClass): void {
    const schemas: Array<{ name: string; inputSchema: unknown }> = [];
    for (const [, imp] of toolClass.dispatchTable) {
      if (imp.schema) {
        schemas.push({ name: imp.schema.name, inputSchema: imp.schema.inputSchema });
      }
    }
    const fingerprint = computeSchemaFingerprint(schemas);
    this.cache.setSchemaFingerprint(toolClass.name, fingerprint);
  }

  /**
   * Register a hook that fires on cache invalidation events.
   * Returns an unsubscribe function.
   *
   * Use for hot-reload coordination: downstream consumers (UI, LLM context)
   * react to invalidation without polling.
   */
  invalidateOn(hook: InvalidationHook): () => void {
    return this.cache.invalidateOn(hook);
  }

  /**
   * Streaming dispatch — yields DispatchEvent objects for real-time UI feedback.
   *
   * Events flow: resolving → tool-start → chunk* → done (or error at any point).
   * When the resolved IMP supports progressive inference, the flow becomes:
   *   resolving → tool-start → inference-delta* → chunk → done
   */
  dispatchStream(intent: string, args?: Record<string, unknown>): AsyncGenerator<DispatchEvent> {
    return smallchat_dispatchStream(this.context, intent, args);
  }

  /**
   * Progressive inference stream — convenience async generator that yields
   * only the token text from inference deltas, filtering out dispatch
   * lifecycle events. Perfect for piping straight into a UI append loop:
   *
   *   for await (const token of runtime.inferenceStream('summarise', { url })) {
   *     process.stdout.write(token);
   *   }
   *
   * Falls back gracefully: if the resolved IMP doesn't support
   * executeInference, the final assembled chunk content is yielded as
   * a single string.
   */
  async *inferenceStream(
    intent: string,
    args?: Record<string, unknown>,
  ): AsyncGenerator<string> {
    let sawDelta = false;
    for await (const event of this.dispatchStream(intent, args)) {
      if (event.type === 'inference-delta') {
        sawDelta = true;
        yield event.delta.text;
      } else if (event.type === 'chunk' && !sawDelta) {
        // Fallback: IMP didn't support inference, yield chunk content as string
        const text = typeof event.content === 'string'
          ? event.content
          : JSON.stringify(event.content);
        yield text;
      } else if (event.type === 'error') {
        throw new Error(event.error);
      }
    }
  }

  /**
   * Generate the LLM-readable "header file" — a minimal capability summary.
   */
  generateHeader(): string {
    const classes = this.context.getClasses();
    const lines: string[] = ['Available capabilities:'];

    // Group by protocol
    const protocolProviders: Map<string, string[]> = new Map();
    for (const cls of classes) {
      for (const protocol of cls.protocols) {
        const providers = protocolProviders.get(protocol.name) ?? [];
        providers.push(cls.name);
        protocolProviders.set(protocol.name, providers);
      }
    }

    for (const [protocolName, providers] of protocolProviders) {
      lines.push(`- ${protocolName}: ${providers.join(', ')}`);
    }

    // List standalone providers without protocols
    for (const cls of classes) {
      if (cls.protocols.length === 0) {
        const selectors = cls.allSelectors();
        const overloadCount = cls.overloadTables.size;
        const overloadSuffix = overloadCount > 0
          ? ` (${overloadCount} overloaded)`
          : '';
        lines.push(`- ${cls.name}: ${selectors.length} tools${overloadSuffix}`);
      }
    }

    // List overloaded selectors
    let hasOverloads = false;
    for (const cls of classes) {
      for (const [canonical, table] of cls.overloadTables) {
        if (!hasOverloads) {
          lines.push('');
          lines.push('Overloaded methods:');
          hasOverloads = true;
        }
        const overloads = table.allOverloads();
        const signatures = overloads
          .map(o => o.signature.signatureKey)
          .join(', ');
        lines.push(`  ${canonical}: ${overloads.length} overloads [${signatures}]`);
      }
    }

    lines.push('');
    lines.push('To use a tool, describe what you want to do. The runtime will resolve');
    lines.push('the best tool and provide the required arguments.');
    lines.push('Overloaded tools accept different argument types and counts.');

    return lines.join('\n');
  }
}

export interface RuntimeOptions {
  selectorThreshold?: number;
  cacheSize?: number;
  minConfidence?: number;
  /** Model/embedder version — cache entries tagged with a different version auto-expire */
  modelVersion?: string;
  /** Selector namespace for core selector protection. A new empty one is created if not provided. */
  selectorNamespace?: SelectorNamespace;
}
