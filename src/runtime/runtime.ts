import type { Embedder, ToolCategory, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex, OverloadTableData, InvalidationHook, CacheVersionContext, DispatchEvent, InferenceDelta } from '../core/types.js';
import { ResolutionCache, computeSchemaFingerprint } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { OverloadTable } from '../core/overload-table.js';
import { DispatchContext, toolkit_dispatch, smallchat_dispatchStream, smallchat_dispatchStreamById, dispatchById, resolveIntent } from './dispatch.js';
import type { DispatchConfig, DispatchByIdOptions, DispatchOptions, RegisteredTool, Resolution, ResolveOptions } from './dispatch.js';
import type { SCMethodSignature } from '../core/sc-types.js';
import { DispatchBuilder } from './dispatch-builder.js';
import { SelectorNamespace } from '../core/selector-namespace.js';
import type { LLMClient } from '../core/llm-client.js';
import type { DispatchObserver, DispatchFeedback } from './observer.js';
import type { SemanticMap, SemanticMapOptions, LearnedPreference } from './semantic-map.js';
import type { TierThresholds } from '../core/confidence.js';
import { IntentPinRegistry } from '../core/intent-pin.js';
import type { IntentPin } from '../core/intent-pin.js';
import type { ArgumentCoercion } from '../core/argument-validator.js';
import type { ManifestPolicyConfig } from '../core/manifest.js';
import { DEFAULT_THRESHOLDS } from '../core/confidence.js';

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

    this.selectorTable = new SelectorTable(
      vectorIndex,
      embedder,
      options?.selectorThreshold ?? 0.95,
    );

    this.selectorNamespace = options?.selectorNamespace ?? new SelectorNamespace();

    const dispatchConfig: DispatchConfig = {
      llmClient: options?.llmClient,
      strict: options?.strict,
      thresholds: options?.thresholds,
      observerOptions: options?.observerOptions,
      semanticMap: options?.semanticMap,
      semanticMapOptions: options?.semanticMapOptions,
      requireLLMForSubHighDispatch: options?.requireLLMForSubHighDispatch,
      treatUnannotatedAsDestructive: options?.treatUnannotatedAsDestructive,
      argumentCoercion: options?.argumentCoercion,
      artifactHash: options?.artifactHash,
      rateLimiter: options?.rateLimiter,
      maxDecompositionDepth: options?.maxDecompositionDepth,
      maxSubDispatches: options?.maxSubDispatches,
    };

    let intentPins: IntentPinRegistry | undefined;
    if (options?.intentPins instanceof IntentPinRegistry) {
      intentPins = options.intentPins;
    } else if (options?.intentPins) {
      intentPins = new IntentPinRegistry();
      for (const pin of options.intentPins) intentPins.pin(pin);
    }

    this.context = new DispatchContext(
      this.selectorTable,
      this.cache,
      vectorIndex,
      embedder,
      this.selectorNamespace,
      intentPins,
      dispatchConfig,
    );
  }

  /** The intent pins guarding sensitive selectors (add pins at any time) */
  get intentPins(): IntentPinRegistry {
    return this.context.intentPins;
  }

  // ---------------------------------------------------------------------------
  // 0.4.0: Observer access
  // ---------------------------------------------------------------------------

  /** Get the dispatch observer for inspection and diagnostics */
  get observer(): DispatchObserver {
    return this.context.observer;
  }

  /**
   * Get the semantic map — learned dispatch preferences from resolved
   * refinements (Pillar 4b). Inspect it for diagnostics, or serialize it
   * (`runtime.semanticMap.toJSON()`) to persist learning across sessions.
   */
  get semanticMap(): SemanticMap {
    return this.context.semanticMap;
  }

  /** Whether strict mode is enabled */
  get strict(): boolean {
    return this.context.strict;
  }

  /**
   * Register a tool class (provider). Registering a class with the name of
   * one already registered replaces it (hot reload). Cached resolutions are
   * flushed.
   *
   * Throws SelectorShadowingError if the class contains selectors that
   * would shadow protected core selectors.
   */
  registerClass(toolClass: ToolClass): void {
    this.context.registerClass(toolClass);
  }

  /**
   * Remove a provider by name; its tools are no longer dispatchable and
   * cached resolutions are flushed. Returns false when no class has that
   * name.
   */
  unregisterClass(name: string): boolean {
    return this.context.unregisterClass(name);
  }

  /**
   * Explicit feedback about an intent → tool decision. `correct: false`
   * records a negative example: resolution will not choose `toolId` for
   * this intent text again (for `principal` only, when given). `correct:
   * true` clears it. This is the only source of negative examples unless
   * observerOptions.implicitCorrections is set.
   */
  feedback(input: DispatchFeedback): void {
    this.context.feedback(input);
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
    // Rebuild the dispatch index — categories add selectors to existing classes
    this.context.reindex();
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
    // Rebuild the dispatch index — addOverload may introduce a new selector
    this.context.reindex();
  }

  /**
   * Swizzle: replace the IMP for a selector in a specific provider.
   * Every other selector of that class that dispatched to the same
   * original IMP (its aliases) is swizzled with it, so the tool has one
   * implementation. Returns the original IMP.
   *
   * Takes effect for the next dispatch: cached resolutions are flushed and
   * the dispatch index is rebuilt.
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
    if (original) {
      for (const [canonical, imp] of toolClass.dispatchTable) {
        if (imp === original) toolClass.dispatchTable.set(canonical, newImp);
      }
    }

    // Cache entries are keyed by intent, not by tool selector: flush them all.
    this.cache.flush();
    // Rebuild the dispatch index — the swizzled IMP changes tool summaries
    this.context.reindex();

    return original;
  }

  /**
   * Resolve an intent to at most one tool, without executing anything.
   *
   * Returns the outcome ('resolved' | 'needs-disambiguation' |
   * 'unresolved'), the chosen tool id when resolved, the ranked
   * candidates, and a proof with a stable `proofDigest`. By default
   * (`learn: false`) it changes nothing in the runtime — no caching; only
   * an opted-in rate limiter counts the embedding. Run the chosen tool
   * with `dispatchById(resolution.chosen, args)`.
   */
  resolve(intent: string, options?: ResolveOptions): Promise<Resolution> {
    return resolveIntent(this.context, intent, options);
  }

  /**
   * Execute exactly the tool with this canonical id (`<providerId>/<toolName>`):
   * O(1) lookup, no embedding, no semantic resolution. Arguments are
   * validated against the tool's inputSchema first. An unknown id or
   * invalid arguments return an isError result; nothing runs.
   */
  dispatchById(
    toolId: string,
    args: Record<string, unknown> = {},
    options?: DispatchByIdOptions,
  ): Promise<ToolResult> {
    return dispatchById(this.context, toolId, args, options);
  }

  /** Streaming variant of dispatchById. */
  dispatchStreamById(
    toolId: string,
    args: Record<string, unknown> = {},
    options?: DispatchByIdOptions,
  ): AsyncGenerator<DispatchEvent> {
    return smallchat_dispatchStreamById(this.context, toolId, args, options);
  }

  /** The registered tool with this canonical id, if any. */
  getTool(toolId: string): RegisteredTool | undefined {
    return this.context.getTool(toolId);
  }

  /** Every registered canonical tool id, sorted. */
  toolIds(): string[] {
    return this.context.toolIds();
  }

  /**
   * Fluent dispatch — returns a DispatchBuilder for chaining .withArgs().exec()/.stream().
   *
   * `dispatch(intent, args)` is resolve → policy → execute: the chosen tool
   * runs only when resolution settles on exactly one tool that the
   * dispatch policy allows; otherwise the result is an isError result
   * (outcome 'needs-disambiguation' or 'unresolved') listing candidates.
   *
   * @example
   *   const result = await runtime.dispatch("fetch url").withArgs({ url }).exec();
   *   const result = await runtime.dispatch("fetch url", { url });
   */
  dispatch(intent: string): DispatchBuilder;
  dispatch(intent: string, args: Record<string, unknown>, options?: DispatchOptions): Promise<ToolResult>;
  dispatch(
    intent: string,
    args?: Record<string, unknown>,
    options?: DispatchOptions,
  ): DispatchBuilder | Promise<ToolResult> {
    if (args !== undefined) {
      return toolkit_dispatch(this.context, intent, args, options);
    }
    return new DispatchBuilder(this.context, intent);
  }

  /**
   * Resolve a refinement by the user's real-time choice (Pillar 4b).
   *
   * When smallchat defers ("Did you mean one of these?"), the caller presents
   * the options and the user picks one. Pass the original intent and the chosen
   * option back here. This does two things at once:
   *
   *   1. Executes exactly the chosen tool (by id) — the user named it.
   *   2. Reinforces the semantic map — so the exact intent resolves instantly
   *      next time, and *similar* intents get a confidence boost toward the same
   *      selector. (A learned preference never authorizes a pinned or
   *      destructive tool on its own; see runtime/policy.ts.)
   *
   * `choice` is a canonical selector id (as carried on
   * `ToolRefinementNeeded.options[n].selectorId`) or the option object itself
   * (whose `toolId` or `selectorId` is used). When only a narrowed intent is
   * available (some LLM-suggested rewrites carry neither), the narrowed intent
   * is dispatched as an intent, without reinforcement.
   */
  async resolveRefinement(
    originalIntent: string,
    choice: string | { selectorId?: string; toolId?: string; intent?: string },
    args?: Record<string, unknown>,
  ): Promise<ToolResult> {
    const selectorId = typeof choice === 'string' ? choice : choice.selectorId;
    const narrowedIntent = typeof choice === 'string' ? undefined : choice.intent;
    const owner = selectorId ? this.context.toolForSelector(selectorId) : null;
    const toolId = (typeof choice === 'string' ? undefined : choice.toolId) ?? owner?.toolId;

    if (toolId) {
      if (selectorId) await this.context.reinforceRefinement(originalIntent, selectorId);
      return dispatchById(this.context, toolId, args ?? {});
    }

    // No tool to bind to — dispatch the narrowed rewrite as an intent.
    return toolkit_dispatch(this.context, narrowedIntent ?? originalIntent, args);
  }

  /**
   * Directly reinforce a learned dispatch preference without executing it.
   * Lower-level than `resolveRefinement`; use when the host has already run the
   * tool and only wants to record the mapping.
   */
  reinforceRefinement(originalIntent: string, selectorId: string): Promise<LearnedPreference> {
    return this.context.reinforceRefinement(originalIntent, selectorId);
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
  dispatchStream(intent: string, args?: Record<string, unknown>, options?: DispatchOptions): AsyncGenerator<DispatchEvent> {
    return smallchat_dispatchStream(this.context, intent, args, options);
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
    options?: DispatchOptions,
  ): AsyncGenerator<string> {
    let sawDelta = false;
    for await (const event of this.dispatchStream(intent, args, options)) {
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
  /**
   * Opt-in semantic rate limiting of novel intents (vector-flooding DoS
   * protection), kept per principal (DispatchOptions.principal). Off when
   * unset. A throttled intent resolves to outcome 'throttled'.
   */
  rateLimiter?: import('../core/semantic-rate-limiter.js').SemanticRateLimiterOptions;
  /** 0.4.0: Pluggable LLM client for verification, decomposition, refinement */
  llmClient?: LLMClient;
  /** 0.4.0: Enable --strict mode — verify all dispatches, treat ambiguity as error */
  strict?: boolean;
  /** 0.4.0: Custom confidence tier thresholds */
  thresholds?: TierThresholds;
  /** Observer options (implicit correction detection is off by default) */
  observerOptions?: import('./observer.js').ObserverOptions;
  /** Pillar 4b: pre-built semantic map (e.g. restored from persistence via SemanticMap.fromJSON) */
  semanticMap?: SemanticMap;
  /** Pillar 4b: options for the semantic map, when one is not supplied */
  semanticMapOptions?: SemanticMapOptions;
  /** LOW-tier decomposition depth bound (default 2). See DispatchConfig. */
  maxDecompositionDepth?: number;
  /** Cap on sub-intents dispatched for one top-level dispatch (default 16). */
  maxSubDispatches?: number;
  /**
   * Below HIGH confidence, run a resolved tool only when an LLM verifier
   * (llmClient.microCheck) approved it; otherwise the outcome is
   * needs-disambiguation. Default true (0.x default was false).
   */
  requireLLMForSubHighDispatch?: boolean;
  /**
   * Intent pins guarding sensitive selectors: a registry, or pins to load
   * into a new one. See core/intent-pin.ts.
   */
  intentPins?: IntentPinRegistry | IntentPin[];
  /**
   * Treat tools without any MCP annotations as destructive (they then run
   * only by exact id, a pinned phrase, or EXACT similarity). Default false.
   */
  treatUnannotatedAsDestructive?: boolean;
  /** Type coercion before argument validation: 'none' (default) or 'primitives'. */
  argumentCoercion?: ArgumentCoercion;
  /** contentHash of the artifact the tools came from (recorded in proofs) */
  artifactHash?: string;
}

/**
 * RuntimeOptions for a smallchat.json "policy" block. Unset fields are left
 * out, so the runtime defaults apply to them.
 */
export function runtimeOptionsFromPolicy(policy: ManifestPolicyConfig): RuntimeOptions {
  const options: RuntimeOptions = {};
  if (policy.requireLLMForSubHighDispatch !== undefined) options.requireLLMForSubHighDispatch = policy.requireLLMForSubHighDispatch;
  if (policy.strict !== undefined) options.strict = policy.strict;
  if (policy.treatUnannotatedAsDestructive !== undefined) options.treatUnannotatedAsDestructive = policy.treatUnannotatedAsDestructive;
  if (policy.argumentCoercion !== undefined) options.argumentCoercion = policy.argumentCoercion;
  if (policy.thresholds) options.thresholds = { ...DEFAULT_THRESHOLDS, ...policy.thresholds };
  if (policy.pins) options.intentPins = policy.pins;
  return options;
}
