import type { Embedder, ToolCategory, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex } from '../core/types.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { DispatchContext, toolkit_dispatch } from './dispatch.js';

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

    this.cache = new ResolutionCache(
      options?.cacheSize ?? 1024,
      options?.minConfidence ?? 0.85,
    );

    this.context = new DispatchContext(
      this.selectorTable,
      this.cache,
      vectorIndex,
      embedder,
    );
  }

  /** Register a tool class (provider) */
  registerClass(toolClass: ToolClass): void {
    this.context.registerClass(toolClass);
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
    for (const toolClass of this.context.getClasses()) {
      const conforming = toolClass.protocols.some(
        p => p.name === category.extendsProtocol,
      );
      if (!conforming) continue;

      for (const method of category.methods) {
        toolClass.addMethod(method.selector, method.imp);
      }
    }

    // Flush cache — new methods may shadow cached resolutions
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
    const original = toolClass.dispatchTable.get(selector.canonical) ?? null;
    toolClass.dispatchTable.set(selector.canonical, newImp);

    // Flush cache entries for this selector — critical!
    this.cache.flushSelector(selector);

    return original;
  }

  /**
   * The main entry point — dispatch an intent to the resolved tool.
   */
  async dispatch(intent: string, args?: Record<string, unknown>): Promise<ToolResult> {
    return toolkit_dispatch(this.context, intent, args);
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
        lines.push(`- ${cls.name}: ${selectors.length} tools`);
      }
    }

    lines.push('');
    lines.push('To use a tool, describe what you want to do. The runtime will resolve');
    lines.push('the best tool and provide the required arguments.');

    return lines.join('\n');
  }
}

export interface RuntimeOptions {
  selectorThreshold?: number;
  cacheSize?: number;
  minConfidence?: number;
}
