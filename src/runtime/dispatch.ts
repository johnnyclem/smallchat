import type { Embedder, ToolCandidate, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex } from '../core/types.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';

/**
 * UnrecognizedIntent — doesNotRecognizeSelector: equivalent.
 * Thrown when no tool anywhere in the registry can handle an intent.
 */
export class UnrecognizedIntent extends Error {
  selector: ToolSelector;
  intent: string;
  nearestSelectors: Array<{ id: string; distance: number }>;
  suggestion: string;

  constructor(
    selector: ToolSelector,
    intent: string,
    context: { nearestSelectors: Array<{ id: string; distance: number }>; suggestion: string },
  ) {
    super(`No tool available for: "${intent}" (selector: ${selector.canonical})`);
    this.name = 'UnrecognizedIntent';
    this.selector = selector;
    this.intent = intent;
    this.nearestSelectors = context.nearestSelectors;
    this.suggestion = context.suggestion;
  }
}

/**
 * DispatchContext — the runtime context for tool dispatch.
 *
 * Holds the selector table, resolution cache, tool classes (providers),
 * vector index, and protocol registry. This is the environment in which
 * toolkit_dispatch operates.
 */
export class DispatchContext {
  readonly selectorTable: SelectorTable;
  readonly cache: ResolutionCache;
  readonly vectorIndex: VectorIndex;
  readonly embedder: Embedder;

  private toolClasses: Map<string, ToolClass> = new Map();
  private protocols: Map<string, ToolProtocol> = new Map();
  /** All tool IMPs indexed by their selector canonical name */
  private toolIndex: Map<string, ToolCandidate[]> = new Map();

  constructor(
    selectorTable: SelectorTable,
    cache: ResolutionCache,
    vectorIndex: VectorIndex,
    embedder: Embedder,
  ) {
    this.selectorTable = selectorTable;
    this.cache = cache;
    this.vectorIndex = vectorIndex;
    this.embedder = embedder;
  }

  /** Register a provider (ToolClass) */
  registerClass(toolClass: ToolClass): void {
    this.toolClasses.set(toolClass.name, toolClass);

    // Index all methods for vector search
    for (const [canonical, imp] of toolClass.dispatchTable) {
      const selector = this.selectorTable.get(canonical);
      if (!selector) continue;

      const candidates = this.toolIndex.get(canonical) ?? [];
      candidates.push({ imp, confidence: 1.0, selector });
      this.toolIndex.set(canonical, candidates);
    }
  }

  /** Register a protocol */
  registerProtocol(protocol: ToolProtocol): void {
    this.protocols.set(protocol.name, protocol);
  }

  /** ISA chain — check protocol conformance for a selector */
  resolveViaProtocol(selector: ToolSelector): ToolCandidate | null {
    for (const [, toolClass] of this.toolClasses) {
      for (const protocol of toolClass.protocols) {
        const isRequired = protocol.requiredSelectors.some(
          s => s.canonical === selector.canonical,
        );
        const isOptional = protocol.optionalSelectors.some(
          s => s.canonical === selector.canonical,
        );

        if (isRequired || isOptional) {
          const imp = toolClass.resolveSelector(selector);
          if (imp) {
            return { imp, confidence: 0.8, selector };
          }
        }
      }
    }
    return null;
  }

  /** Forwarding chain — slow path when no compiled tool matches */
  async forward(
    selector: ToolSelector,
    intent: string,
    _args?: Record<string, unknown>,
  ): Promise<ToolResult> {
    // In v0.0.1, forwarding is limited. Full implementation will:
    // 1. Try dynamic discovery from live MCP servers
    // 2. Attempt LLM-assisted decomposition
    // 3. Fall through to doesNotRecognizeSelector:

    const nearest = this.vectorIndex.search(selector.vector, 3, 0.5);

    throw new UnrecognizedIntent(selector, intent, {
      nearestSelectors: nearest,
      suggestion: nearest.length > 0
        ? `Did you mean one of these? ${nearest.map(n => n.id).join(', ')}`
        : 'No similar capabilities found.',
    });
  }

  /** Get all registered tool classes */
  getClasses(): ToolClass[] {
    return Array.from(this.toolClasses.values());
  }
}

/**
 * toolkit_dispatch — the hot path. Equivalent to objc_msgSend.
 *
 * Resolution order:
 * 1. Cache lookup (sub-millisecond)
 * 2. Dispatch table via vector similarity (milliseconds)
 * 3. ISA chain / protocol conformance
 * 4. Forwarding chain (expensive, self-healing)
 * 5. doesNotRecognizeSelector: (UnrecognizedIntent error)
 */
export async function toolkit_dispatch(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  // 1. RESOLVE SELECTOR (embed + intern)
  const selector = await context.selectorTable.resolve(intent);

  // 2. CHECK CACHE (the inline cache / method cache)
  const cached = context.cache.lookup(selector);
  if (cached) {
    return cached.imp.execute(args ?? {});
  }

  // 3. SEARCH DISPATCH TABLE (vector similarity)
  const matches = context.vectorIndex.search(selector.vector, 5, 0.75);
  const candidates: ToolCandidate[] = [];

  for (const match of matches) {
    const matchSelector = context.selectorTable.get(match.id);
    if (!matchSelector) continue;

    for (const toolClass of context.getClasses()) {
      const imp = toolClass.resolveSelector(matchSelector);
      if (imp) {
        candidates.push({
          imp,
          confidence: 1 - match.distance, // Convert distance to confidence
          selector: matchSelector,
        });
      }
    }
  }

  if (candidates.length === 0) {
    // 4a. ISA CHAIN — check protocol conformance
    const protocolMatch = context.resolveViaProtocol(selector);
    if (protocolMatch) {
      context.cache.store(selector, protocolMatch.imp, protocolMatch.confidence);
      return protocolMatch.imp.execute(args ?? {});
    }

    // 4b. FORWARDING — slow path
    return context.forward(selector, intent, args);
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  if (candidates.length === 1 || candidates[0].confidence > 0.90) {
    // Unambiguous match. Cache and execute.
    const tool = candidates[0];
    context.cache.store(selector, tool.imp, tool.confidence);
    return tool.imp.execute(args ?? {});
  }

  // Multiple candidates — for v0.0.1, take the best match.
  // Full implementation will involve LLM-assisted disambiguation.
  const best = candidates[0];
  context.cache.store(selector, best.imp, best.confidence);
  return best.imp.execute(args ?? {});
}
