import type { Embedder, ToolCandidate, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex, DispatchEvent, InferenceDelta } from '../core/types.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { SCObject, wrapValue, unwrapValue } from '../core/sc-object.js';
import type { OverloadResolutionResult } from '../core/overload-table.js';

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
    const nearest = context.nearestSelectors;
    const suggestions = nearest.length > 0
      ? `\n\nDid you mean one of these?\n${nearest.slice(0, 3).map(s => `  - "${s.id}" (${((1 - s.distance) * 100).toFixed(0)}% match)`).join('\n')}`
      : '';
    const fixes = [
      '\nTo fix this:',
      '  1. Check that your manifest includes a tool for this intent',
      '  2. Run "smallchat compile" to rebuild the dispatch table',
      '  3. Run "smallchat resolve <artifact> <intent>" to debug resolution',
      '  4. Lower the selector threshold if tools exist but similarity is too low',
    ].join('\n');

    super(`No tool available for: "${intent}" (selector: ${selector.canonical})${suggestions}\n${fixes}`);
    this.name = 'UnrecognizedIntent';
    this.selector = selector;
    this.intent = intent;
    this.nearestSelectors = context.nearestSelectors;
    this.suggestion = context.suggestion;
  }
}

/**
 * FallbackStep — a single step in the fallback chain, recording what was tried.
 */
export interface FallbackStep {
  strategy: 'superclass' | 'broadened_search' | 'llm_disambiguate';
  tried: string;
  result: 'hit' | 'miss';
}

/**
 * FallbackChainResult — returned instead of throwing when no exact match is found.
 * Contains the resolution attempt trace and either a resolved tool or a stub
 * inviting the caller to search further.
 */
export interface FallbackChainResult {
  tool: string;
  message: string;
  intent: string;
  nearestSelectors: Array<{ id: string; distance: number }>;
  fallbackSteps: FallbackStep[];
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

  /**
   * Forwarding chain — slow path when no compiled tool matches.
   *
   * Instead of throwing immediately, walks a fallback chain:
   *  1. Superclass traversal — check superclass dispatch tables across all classes
   *  2. Broadened vector search — lower the similarity threshold to find near-misses
   *  3. LLM disambiguation stub — placeholder for Phase 3 LLM-assisted resolution
   *  4. Return a stub result inviting the caller to search, rather than crashing
   */
  async forward(
    selector: ToolSelector,
    intent: string,
    args?: Record<string, unknown>,
  ): Promise<ToolResult> {
    const fallbackSteps: FallbackStep[] = [];

    // Step 1: SUPERCLASS TRAVERSAL — walk isa chains for a match
    for (const toolClass of this.getClasses()) {
      if (!toolClass.superclass) continue;

      const imp = toolClass.superclass.resolveSelector(selector);
      if (imp) {
        fallbackSteps.push({
          strategy: 'superclass',
          tried: `${toolClass.name} → ${toolClass.superclass.name}`,
          result: 'hit',
        });
        this.cache.store(selector, imp, 0.6);
        return executeWithArgs(imp, args ?? {});
      }

      fallbackSteps.push({
        strategy: 'superclass',
        tried: `${toolClass.name} → ${toolClass.superclass.name}`,
        result: 'miss',
      });
    }

    // Step 2: BROADENED SEARCH — lower threshold to find near-misses
    const broadMatches = await this.vectorIndex.search(selector.vector, 5, 0.5);
    if (broadMatches.length > 0) {
      // Try to resolve the best broad match
      for (const match of broadMatches) {
        const matchSelector = this.selectorTable.get(match.id);
        if (!matchSelector) continue;

        for (const toolClass of this.getClasses()) {
          const imp = toolClass.resolveSelector(matchSelector);
          if (imp) {
            fallbackSteps.push({
              strategy: 'broadened_search',
              tried: `${match.id} (distance: ${match.distance.toFixed(3)})`,
              result: 'hit',
            });
            const confidence = 1 - match.distance;
            this.cache.store(selector, imp, confidence);
            return executeWithArgs(imp, args ?? {});
          }
        }
      }

      fallbackSteps.push({
        strategy: 'broadened_search',
        tried: broadMatches.map(m => m.id).join(', '),
        result: 'miss',
      });
    }

    // Step 3: LLM DISAMBIGUATION — Phase 3 stub
    // In a full implementation this would call the LLM to interpret the intent,
    // decompose it into sub-intents, or ask clarifying questions.
    fallbackSteps.push({
      strategy: 'llm_disambiguate',
      tried: 'LLM disambiguation (not yet implemented)',
      result: 'miss',
    });

    // Step 4: Return a stub instead of throwing
    const nearest = await this.vectorIndex.search(selector.vector, 3, 0.5);

    const fallbackResult: FallbackChainResult = {
      tool: 'unknown',
      message: nearest.length > 0
        ? `No exact match for "${intent}". Nearest: ${nearest.map(n => n.id).join(', ')}. Want me to search?`
        : `No match for "${intent}"—want me to search?`,
      intent,
      nearestSelectors: nearest,
      fallbackSteps,
    };

    return {
      content: fallbackResult,
      isError: false,
      metadata: {
        fallback: true,
        stepsAttempted: fallbackSteps.length,
        fallbackSteps,
      },
    };
  }

  /** Get all registered tool classes */
  getClasses(): ToolClass[] {
    return Array.from(this.toolClasses.values());
  }
}

/**
 * ResolutionOutcome — the result of the shared resolve phase.
 *
 * Either a resolved IMP ready for execution, or a forwarded ToolResult
 * from the fallback chain (no IMP to execute).
 */
type ResolutionOutcome =
  | {
      kind: 'resolved';
      imp: ToolIMP;
      confidence: number;
      selector: ToolSelector;
      candidates: ToolCandidate[];
    }
  | {
      kind: 'forwarded';
      result: ToolResult;
    };

/**
 * resolveToolIMP — shared resolution logic for both sync and streaming dispatch.
 *
 * Resolution order:
 * 1. Cache lookup (sub-millisecond)
 * 2. Overload resolution (if args provided and overloads exist)
 * 3. Dispatch table via vector similarity (milliseconds)
 * 4. ISA chain / protocol conformance
 * 5. Forwarding chain (expensive, self-healing)
 */
async function resolveToolIMP(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): Promise<ResolutionOutcome> {
  // 1. RESOLVE SELECTOR (embed + intern)
  const selector = await context.selectorTable.resolve(intent);

  // 2. CHECK CACHE (the inline cache / method cache)
  // Skip cache when args are provided and overloads may exist — type matters
  const hasArgs = args && Object.keys(args).length > 0;
  if (!hasArgs) {
    const cached = context.cache.lookup(selector);
    if (cached) {
      return { kind: 'resolved', imp: cached.imp, confidence: cached.confidence, selector, candidates: [] };
    }
  }

  // 3. SEARCH DISPATCH TABLE (vector similarity)
  const matches = await context.vectorIndex.search(selector.vector, 5, 0.75);
  const candidates: ToolCandidate[] = [];

  for (const match of matches) {
    const matchSelector = context.selectorTable.get(match.id);
    if (!matchSelector) continue;

    for (const toolClass of context.getClasses()) {
      // 3a. OVERLOAD RESOLUTION — if args exist and overloads are registered
      if (hasArgs && toolClass.hasOverloads(matchSelector)) {
        const overloadResult = toolClass.resolveSelectorWithNamedArgs(
          matchSelector,
          args,
        );
        if (overloadResult) {
          context.cache.store(selector, overloadResult.imp, 1 - match.distance);
          return {
            kind: 'resolved',
            imp: overloadResult.imp,
            confidence: 1 - match.distance,
            selector: matchSelector,
            candidates: [],
          };
        }
      }

      const imp = toolClass.resolveSelector(matchSelector);
      if (imp) {
        candidates.push({
          imp,
          confidence: 1 - match.distance,
          selector: matchSelector,
        });
      }
    }
  }

  // Also check cache for non-overloaded case when args were provided
  if (hasArgs) {
    const cached = context.cache.lookup(selector);
    if (cached) {
      return { kind: 'resolved', imp: cached.imp, confidence: cached.confidence, selector, candidates: [] };
    }
  }

  if (candidates.length === 0) {
    // 4a. ISA CHAIN — check protocol conformance
    const protocolMatch = context.resolveViaProtocol(selector);
    if (protocolMatch) {
      context.cache.store(selector, protocolMatch.imp, protocolMatch.confidence);
      return {
        kind: 'resolved',
        imp: protocolMatch.imp,
        confidence: protocolMatch.confidence,
        selector: protocolMatch.selector,
        candidates: [],
      };
    }

    // 4b. FORWARDING — slow path
    const result = await context.forward(selector, intent, args);
    return { kind: 'forwarded', result };
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  context.cache.store(selector, best.imp, best.confidence);

  return {
    kind: 'resolved',
    imp: best.imp,
    confidence: best.confidence,
    selector: best.selector,
    candidates,
  };
}

/**
 * toolkit_dispatch — the hot path. Equivalent to objc_msgSend.
 *
 * Uses resolveToolIMP for resolution, then executes synchronously.
 */
export async function toolkit_dispatch(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  const outcome = await resolveToolIMP(context, intent, args);

  if (outcome.kind === 'forwarded') {
    return outcome.result;
  }

  const result = await executeWithArgs(outcome.imp, args ?? {});

  // Annotate ambiguous results so callers know disambiguation may be needed
  if (outcome.candidates.length > 1 && outcome.confidence <= 0.90) {
    result.metadata = {
      ...result.metadata,
      ambiguous: true,
      candidateCount: outcome.candidates.length,
      topCandidates: outcome.candidates.slice(0, 3).map(c => ({
        tool: c.imp.toolName,
        confidence: c.confidence,
      })),
    };
  }

  return result;
}

/**
 * smallchat_dispatchStream — async generator variant of toolkit_dispatch.
 *
 * Yields DispatchEvent objects for real-time UI feedback:
 *   1. "resolving" — immediately, so the caller knows work has started
 *   2. "tool-start" — once a tool is resolved, before execution
 *   3. "chunk" — incremental content from the tool (if it supports streaming)
 *   4. "done" — final result with the complete ToolResult
 *   5. "error" — if anything goes wrong at any stage
 *
 * Uses resolveToolIMP for resolution, then streams execution.
 */
export async function* smallchat_dispatchStream(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): AsyncGenerator<DispatchEvent> {
  yield { type: 'resolving', intent };

  let outcome: ResolutionOutcome;
  try {
    outcome = await resolveToolIMP(context, intent, args);
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      metadata: err instanceof UnrecognizedIntent
        ? { nearestSelectors: err.nearestSelectors, suggestion: err.suggestion }
        : undefined,
    };
    return;
  }

  if (outcome.kind === 'forwarded') {
    yield { type: 'done', result: outcome.result };
    return;
  }

  yield {
    type: 'tool-start',
    toolName: outcome.imp.toolName,
    providerId: outcome.imp.providerId,
    confidence: outcome.confidence,
    selector: outcome.selector.canonical,
  };

  yield* executeAndStream(outcome.imp, args ?? {});
}

/**
 * StreamableIMP — IMP with optional chunk-level streaming.
 */
interface StreamableIMP extends ToolIMP {
  executeStream?: (args: Record<string, unknown>) => AsyncIterable<ToolResult>;
}

/**
 * InferenceIMP — IMP with optional token-level progressive inference.
 *
 * This is the bridge for provider-native streaming: the IMP opens an
 * OpenAI or Anthropic SSE connection and yields individual deltas.
 * The generator signature we already have is perfect for it — each
 * InferenceDelta becomes a DispatchEventInferenceDelta event.
 */
interface InferenceIMP extends StreamableIMP {
  executeInference?: (args: Record<string, unknown>) => AsyncIterable<InferenceDelta>;
}

/**
 * Execute a tool and stream its result at the finest granularity the
 * IMP supports. Resolution order:
 *
 *   1. executeInference  — token-level deltas (OpenAI / Anthropic SSE)
 *   2. executeStream     — chunk-level results
 *   3. execute           — single-shot fallback
 *
 * Each tier falls through to the next, so every IMP works — providers
 * that expose a raw inference stream just get true progressive output.
 */
async function* executeAndStream(
  imp: ToolIMP,
  args: Record<string, unknown>,
): AsyncGenerator<DispatchEvent> {
  const unwrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    unwrapped[key] = unwrapValue(value);
  }

  try {
    const inferenceImp = imp as InferenceIMP;

    // ---- Tier 1: Progressive inference (token-level) ----
    if (typeof inferenceImp.executeInference === 'function') {
      let tokenIndex = 0;
      const parts: string[] = [];

      for await (const delta of inferenceImp.executeInference(unwrapped)) {
        yield { type: 'inference-delta', delta, tokenIndex };
        parts.push(delta.text);
        tokenIndex++;
      }

      // Synthesise a final ToolResult from the accumulated tokens
      const assembled = parts.join('');
      const result: ToolResult = { content: assembled };
      yield { type: 'chunk', content: assembled, index: 0 };
      yield { type: 'done', result };
      return;
    }

    // ---- Tier 2: Chunk-level streaming ----
    const streamable = imp as StreamableIMP;

    if (typeof streamable.executeStream === 'function') {
      let index = 0;
      let lastResult: ToolResult | undefined;

      for await (const chunk of streamable.executeStream(unwrapped)) {
        yield { type: 'chunk', content: chunk.content, index };
        index++;
        lastResult = chunk;
      }

      yield {
        type: 'done',
        result: lastResult ?? { content: null },
      };
      return;
    }

    // ---- Tier 3: Single-shot fallback ----
    const result = await imp.execute(unwrapped);
    yield { type: 'chunk', content: result.content, index: 0 };
    yield { type: 'done', result };
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Execute an IMP with arguments, unwrapping any SCObject values
 * back to their underlying representations.
 */
function executeWithArgs(
  imp: ToolIMP,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const unwrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    unwrapped[key] = unwrapValue(value);
  }
  return imp.execute(unwrapped);
}
