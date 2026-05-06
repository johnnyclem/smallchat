import type {
  AppIMP,
  AppExtension,
  ComponentSelector,
  DispatchEvent,
  ToolResult,
  VectorIndex,
  Embedder,
} from '../core/types.js';
import { AppClass } from './app-class.js';
import { ComponentSelectorTable } from './component-selector.js';
import { ViewCache } from './view-cache.js';
import { AppBridgePool } from './app-bridge-wrapper.js';
import { AppBridgeWrapper } from './app-bridge-wrapper.js';
import { deserializeAppArtifact } from './app-compiler.js';
import type { AppArtifact } from '../core/types.js';

export interface UIRuntimeOptions {
  /** Max entries in the ViewCache (default 512) */
  viewCacheSize?: number;
  /** Min confidence to cache a resolved component (default 0.75) */
  minCacheConfidence?: number;
  /** Max concurrent mounted bridges (default 32) */
  bridgePoolSize?: number;
  /** Similarity threshold for ComponentSelector vector search (default 0.92) */
  resolveThreshold?: number;
}

/**
 * UIRuntime — the runtime environment for MCP Apps UI component dispatch.
 *
 * Mirrors DispatchContext / ToolRuntime in src/runtime/ but operates on the
 * component dispatch space (ComponentSelector → AppIMP) rather than the tool
 * dispatch space (ToolSelector → ToolIMP).
 *
 * Obj-C analogy:
 *   ui_dispatch()       ≈ objc_msgSend (the UI hot path)
 *   ui_dispatchStream() ≈ presentViewController: with progress callbacks
 *   loadExtension()     ≈ objc_registerCategoryMethods() (runtime extension)
 *   AppBridgePool       ≈ NSWindowController pool
 *
 * UIRuntime composes with the existing DispatchContext (holds a reference to
 * the tool runtime so view-initiated tool calls can be routed back through
 * the existing tool dispatch path — the forwardInvocation: analogy).
 *
 * Graceful degradation: ui_dispatch() returns null (never throws) when no
 * component matches. Callers receive text-only tool results and can offer the
 * UI as an opt-in.
 */
export class UIRuntime {
  private appClasses: Map<string, AppClass> = new Map();
  private componentSelectorTable: ComponentSelectorTable;
  private viewCache: ViewCache;
  readonly bridgePool: AppBridgePool;
  private readonly resolveThreshold: number;

  constructor(
    embedder: Embedder,
    vectorIndex: VectorIndex,
    options?: UIRuntimeOptions,
  ) {
    this.resolveThreshold = options?.resolveThreshold ?? 0.92;
    this.componentSelectorTable = new ComponentSelectorTable(
      vectorIndex,
      embedder,
      this.resolveThreshold,
    );
    this.viewCache = new ViewCache(
      options?.viewCacheSize ?? 512,
      options?.minCacheConfidence ?? 0.75,
    );
    this.bridgePool = new AppBridgePool(options?.bridgePoolSize ?? 32);
  }

  /**
   * Load a compiled AppArtifact into the runtime.
   * Called after AppCompiler.compile() — analogous to dlopen() + class
   * registration at runtime startup.
   */
  loadArtifact(artifact: AppArtifact): void {
    const { appClasses, componentSelectors } = deserializeAppArtifact(artifact);
    for (const [providerId, appClass] of appClasses) {
      this.appClasses.set(providerId, appClass);
    }
    // Re-intern all component selectors into the live selector table
    for (const sel of componentSelectors.values()) {
      this.componentSelectorTable.intern(sel.vector, sel.canonical);
    }
  }

  /**
   * Register an AppClass directly (used when compiling in-process).
   */
  registerAppClass(appClass: AppClass): void {
    this.appClasses.set(appClass.providerId, appClass);
  }

  /**
   * Load an AppExtension — the Category analogy.
   * Adds component methods to an existing AppClass at runtime.
   */
  loadExtension(ext: AppExtension): void {
    const targetClass = [...this.appClasses.values()].find(
      cls => cls.conformsToProtocol(ext.extendsProtocol),
    );
    if (targetClass) {
      targetClass.loadExtension(ext);
    }
  }

  /**
   * ui_dispatch — the UI hot path.
   *
   * Resolves a natural language intent to an AppIMP via:
   *   1. ViewCache lookup (fast path — version-tagged LRU)
   *   2. ComponentSelectorTable.resolve() (embed + vector search)
   *   3. AppClass dispatch table walk (ISA chain)
   *   4. ViewCache.store() (populate for next time)
   *
   * Returns null if no AppClass handles the intent.
   * Never throws — UI is a progressive enhancement.
   */
  async ui_dispatch(intent: string): Promise<AppIMP | null> {
    // Resolve intent → ComponentSelector (embed if not already interned)
    const selector = await this.componentSelectorTable.resolve(intent);

    // Fast path: ViewCache hit
    const cached = this.viewCache.lookup(selector);
    if (cached) return cached.imp;

    // Walk AppClass dispatch tables (ISA chain per class)
    const imp = this.resolveFromClasses(selector);
    if (!imp) return null;

    // Store in ViewCache for subsequent dispatches
    const nearestMatches = await this.componentSelectorTable.nearest(selector.vector, 1, 0.0);
    const confidence = nearestMatches.length > 0
      ? Math.max(0, 1 - nearestMatches[0].distance)
      : 0.8;

    this.viewCache.store(selector, imp, confidence);
    return imp;
  }

  /**
   * ui_dispatchStream — streaming UI lifecycle generator.
   *
   * Yields DispatchEvent objects describing the UI mounting lifecycle:
   *   1. ui-available: component found, host should prepare iframe
   *   2. ui-ready: bridge connected, view initialized
   *   3. ui-update: tool result delivered to view
   *   4. ui-interaction: view fired a tool call or message back
   *
   * Callers interleave these events with the existing tool dispatch events
   * (tool-start, inference-delta, done) for a unified stream.
   */
  async *ui_dispatchStream(
    intent: string,
    toolResult: ToolResult,
  ): AsyncGenerator<DispatchEvent> {
    const imp = await this.ui_dispatch(intent);
    if (!imp) return; // No view available — graceful degradation, no events emitted

    // 1. ui-available — component found
    yield {
      type: 'ui-available',
      componentUri: imp.componentUri,
      capabilities: imp.capabilities,
      confidence: 1.0,
      visibility: imp.visibility,
    };

    // 2. Mount bridge and deliver tool result
    const bridge = this.bridgePool.acquire(imp);

    const interactionEvents: DispatchEvent[] = [];
    const unsubscribe = bridge.on((event) => {
      if (event.type === 'interaction') {
        interactionEvents.push(bridge.toUIInteractionEvent(event));
      }
    });

    try {
      await bridge.mount(toolResult);

      // 3. ui-ready — bridge connected
      yield {
        type: 'ui-ready',
        displayMode: imp.preferredDisplayMode ?? 'inline',
      };

      // 4. ui-update — tool result delivered
      yield {
        type: 'ui-update',
        data: toolResult.content,
      };

      // 5. Drain any synchronous interaction events
      for (const event of interactionEvents) {
        yield event;
      }
    } finally {
      unsubscribe();
    }
  }

  /**
   * Mount a view directly from an AppIMP and tool result.
   * Returns an AppBridgeWrapper whose lifecycle the caller manages.
   * Equivalent to presentViewController:animated: — caller retains the controller.
   */
  async mountView(imp: AppIMP, toolResult: ToolResult): Promise<AppBridgeWrapper> {
    const bridge = this.bridgePool.acquire(imp);
    await bridge.mount(toolResult);
    return bridge;
  }

  /** Tear down all active bridges — call on runtime shutdown */
  async teardown(): Promise<void> {
    await this.bridgePool.teardownAll();
    this.viewCache.flush();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveFromClasses(selector: ComponentSelector): AppIMP | null {
    for (const appClass of this.appClasses.values()) {
      const imp = appClass.resolveComponent(selector);
      if (imp) return imp;
    }
    return null;
  }
}
