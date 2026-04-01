import type { Embedder, ToolCandidate, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex, DispatchEvent, InferenceDelta } from '../core/types.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable, canonicalize, VectorFloodError } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { SCObject, wrapValue, unwrapValue } from '../core/sc-object.js';
import type { OverloadResolutionResult } from '../core/overload-table.js';
import { SelectorNamespace } from '../core/selector-namespace.js';
import { SignatureValidationError } from '../core/overload-table.js';
import { validateNamedArgumentTypes } from '../core/sc-types.js';
import { IntentPinRegistry } from '../core/intent-pin.js';
import type { IntentPinMatch } from '../core/intent-pin.js';
import { computeTier, requiresVerification, requiresDecomposition, requiresRefinement, createProof, addProofStep, DEFAULT_THRESHOLDS } from '../core/confidence.js';
import type { ConfidenceTier, ResolutionProof, TierThresholds } from '../core/confidence.js';
import type { LLMClient, ToolSummary } from '../core/llm-client.js';
import { NULL_LLM_CLIENT } from '../core/llm-client.js';
import { verify } from './verification.js';
import type { VerificationResult } from './verification.js';
import { decompose, executeDecomposition } from './decomposition.js';
import { refine, buildRefinementResult } from './refinement.js';
import { DispatchObserver } from './observer.js';
import type { ObserverOptions } from './observer.js';

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
 * DispatchConfig — configuration for 0.4.0 dispatch features.
 */
export interface DispatchConfig {
  /** LLM client for Pillars 2c, 3, 4 (optional — features degrade without it) */
  llmClient?: LLMClient;
  /** Enable --strict mode: verify all dispatches, treat ambiguity as error */
  strict?: boolean;
  /** Custom tier thresholds */
  thresholds?: TierThresholds;
  /** Observer options for Pillar 5 */
  observerOptions?: ObserverOptions;
}

/**
 * DispatchContext — the runtime context for tool dispatch.
 *
 * Holds the selector table, resolution cache, tool classes (providers),
 * vector index, and protocol registry. This is the environment in which
 * toolkit_dispatch operates.
 *
 * 0.4.0: Now includes LLM client, observer, and strict mode config.
 */
export class DispatchContext {
  readonly selectorTable: SelectorTable;
  readonly cache: ResolutionCache;
  readonly vectorIndex: VectorIndex;
  readonly embedder: Embedder;
  readonly selectorNamespace: SelectorNamespace;
  readonly intentPins: IntentPinRegistry;
  readonly observer: DispatchObserver;
  readonly llmClient: LLMClient;
  readonly strict: boolean;
  readonly thresholds: TierThresholds;

  private toolClasses: Map<string, ToolClass> = new Map();
  private protocols: Map<string, ToolProtocol> = new Map();
  /** All tool IMPs indexed by their selector canonical name */
  private toolIndex: Map<string, ToolCandidate[]> = new Map();

  constructor(
    selectorTable: SelectorTable,
    cache: ResolutionCache,
    vectorIndex: VectorIndex,
    embedder: Embedder,
    selectorNamespace?: SelectorNamespace,
    intentPins?: IntentPinRegistry,
    dispatchConfig?: DispatchConfig,
  ) {
    this.selectorTable = selectorTable;
    this.cache = cache;
    this.vectorIndex = vectorIndex;
    this.embedder = embedder;
    this.selectorNamespace = selectorNamespace ?? new SelectorNamespace();
    this.intentPins = intentPins ?? new IntentPinRegistry();
    this.llmClient = dispatchConfig?.llmClient ?? NULL_LLM_CLIENT;
    this.strict = dispatchConfig?.strict ?? false;
    this.thresholds = dispatchConfig?.thresholds ?? { ...DEFAULT_THRESHOLDS };
    this.observer = new DispatchObserver(dispatchConfig?.observerOptions);
  }

  /**
   * Register a provider (ToolClass).
   *
   * Throws SelectorShadowingError if the class contains selectors that
   * would shadow protected core selectors.
   */
  registerClass(toolClass: ToolClass): void {
    // Guard: check all selectors in this class against the namespace
    const ownSelectors = Array.from(toolClass.dispatchTable.keys());
    this.selectorNamespace.assertNoShadowing(toolClass.name, ownSelectors);

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
 *
 * 0.4.0: Now includes confidence tier and resolution proof.
 */
type ResolutionOutcome =
  | {
      kind: 'resolved';
      imp: ToolIMP;
      confidence: number;
      tier: ConfidenceTier;
      selector: ToolSelector;
      candidates: ToolCandidate[];
      proof: ResolutionProof;
    }
  | {
      kind: 'forwarded';
      result: ToolResult;
      proof: ResolutionProof;
    }
  | {
      kind: 'decomposed';
      result: ToolResult;
      proof: ResolutionProof;
    }
  | {
      kind: 'refined';
      result: ToolResult;
      proof: ResolutionProof;
    };

/**
 * Build a list of tool summaries for LLM-powered features (Pillars 3 & 4).
 */
function collectToolSummaries(context: DispatchContext): ToolSummary[] {
  const summaries: ToolSummary[] = [];
  for (const toolClass of context.getClasses()) {
    for (const [, imp] of toolClass.dispatchTable) {
      summaries.push({
        name: imp.toolName,
        description: imp.schema?.description ?? imp.toolName,
        parameters: imp.schema?.arguments.map(a => a.name),
      });
    }
  }
  return summaries;
}

/**
 * resolveToolIMP — shared resolution logic for both sync and streaming dispatch.
 *
 * 0.4.0 resolution order:
 * 1. Cache lookup (sub-millisecond)
 * 2. Overload resolution (if args provided and overloads exist)
 * 3. Dispatch table via vector similarity (milliseconds)
 * 4. Confidence-tiered branching:
 *    - EXACT/HIGH: dispatch immediately
 *    - MEDIUM: pre-flight verification (Pillar 2)
 *    - LOW: intent decomposition (Pillar 3)
 *    - NONE: refinement protocol (Pillar 4)
 * 5. ISA chain / protocol conformance
 * 6. Forwarding chain (expensive, self-healing)
 *
 * Every dispatch now includes a ResolutionProof trace.
 */
async function resolveToolIMP(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): Promise<ResolutionOutcome> {
  const proof = createProof(intent);
  const t0 = Date.now();

  // 1. RESOLVE SELECTOR (embed + intern)
  const selector = await context.selectorTable.resolve(intent);
  const intentCanonical = canonicalize(intent);

  // 1a. INTENT PIN — exact match fast path
  if (context.intentPins.size > 0) {
    const pinT0 = Date.now();
    const exactPinMatch = context.intentPins.checkExact(intentCanonical);
    if (exactPinMatch && exactPinMatch.verdict === 'accept') {
      const pinnedSelector = context.selectorTable.get(exactPinMatch.canonical);
      if (pinnedSelector) {
        for (const toolClass of context.getClasses()) {
          const imp = toolClass.resolveSelector(pinnedSelector);
          if (imp) {
            context.cache.store(selector, imp, 1.0);
            addProofStep(proof, {
              stage: 'intent_pin',
              input: intentCanonical,
              output: exactPinMatch.canonical,
              decision: `Intent pin exact match → ${imp.toolName} at 1.0`,
            }, Date.now() - pinT0);
            proof.tier = 'exact';
            proof.resolvedTool = imp.toolName;
            return {
              kind: 'resolved',
              imp,
              confidence: 1.0,
              tier: 'exact',
              selector: pinnedSelector,
              candidates: [],
              proof,
            };
          }
        }
      }
    }
  }

  // 2. CHECK CACHE (the inline cache / method cache)
  const hasArgs = args && Object.keys(args).length > 0;
  if (!hasArgs) {
    const cacheT0 = Date.now();
    const cached = context.cache.lookup(selector);
    if (cached) {
      const tier = computeTier(cached.confidence, context.thresholds);
      addProofStep(proof, {
        stage: 'cache',
        input: selector.canonical,
        output: cached.imp.toolName,
        decision: `Cache hit → ${cached.imp.toolName} at ${cached.confidence.toFixed(3)} (${tier})`,
      }, Date.now() - cacheT0);
      proof.tier = tier;
      proof.resolvedTool = cached.imp.toolName;
      return { kind: 'resolved', imp: cached.imp, confidence: cached.confidence, tier, selector, candidates: [], proof };
    }
  }

  // 3. SEARCH DISPATCH TABLE (vector similarity)
  // Use the LOW threshold as the vector search floor — we handle all tiers
  const searchT0 = Date.now();
  const searchThreshold = context.strict ? context.thresholds.medium : context.thresholds.low;
  const matches = await context.vectorIndex.search(selector.vector, 5, searchThreshold);
  const candidates: ToolCandidate[] = [];

  for (const match of matches) {
    const matchSelector = context.selectorTable.get(match.id);
    if (!matchSelector) continue;

    // 3.PIN: INTENT PIN — guard pinned candidates against semantic collision
    if (context.intentPins.size > 0) {
      const pinCheck = context.intentPins.checkSimilarity(
        match.id,
        1 - match.distance,
        intentCanonical,
      );
      if (pinCheck) {
        if (pinCheck.verdict === 'reject') continue;
      }
    }

    // 3.OBS: OBSERVER — skip known negative examples
    for (const toolClass of context.getClasses()) {
      // 3a. OVERLOAD RESOLUTION
      if (hasArgs && toolClass.hasOverloads(matchSelector)) {
        const overloadResult = toolClass.validateAndResolveSelectorWithNamedArgs(
          matchSelector,
          args,
        );
        if (overloadResult) {
          const confidence = 1 - match.distance;
          // Skip negative examples
          if (context.observer.isNegativeExample(intent, overloadResult.imp.toolName)) continue;
          context.cache.store(selector, overloadResult.imp, confidence);
          const tier = computeTier(confidence, context.thresholds);
          addProofStep(proof, {
            stage: 'overload',
            input: { intent, args },
            output: overloadResult.imp.toolName,
            decision: `Overload match → ${overloadResult.imp.toolName} at ${confidence.toFixed(3)} (${tier})`,
          }, Date.now() - searchT0);
          proof.tier = tier;
          proof.resolvedTool = overloadResult.imp.toolName;
          return {
            kind: 'resolved',
            imp: overloadResult.imp,
            confidence,
            tier,
            selector: matchSelector,
            candidates: [],
            proof,
          };
        }
      }

      const imp = toolClass.resolveSelector(matchSelector);
      if (imp) {
        // Skip negative examples
        if (context.observer.isNegativeExample(intent, imp.toolName)) continue;
        candidates.push({
          imp,
          confidence: 1 - match.distance,
          selector: matchSelector,
        });
      }
    }
  }

  addProofStep(proof, {
    stage: 'vector_search',
    input: { intent, threshold: searchThreshold },
    output: candidates.map(c => ({ tool: c.imp.toolName, confidence: c.confidence.toFixed(3) })),
    decision: `Vector search found ${candidates.length} candidates`,
  }, Date.now() - searchT0);

  // Also check cache for non-overloaded case when args were provided
  if (hasArgs) {
    const cached = context.cache.lookup(selector);
    if (cached) {
      const tier = computeTier(cached.confidence, context.thresholds);
      proof.tier = tier;
      proof.resolvedTool = cached.imp.toolName;
      return { kind: 'resolved', imp: cached.imp, confidence: cached.confidence, tier, selector, candidates: [], proof };
    }
  }

  if (candidates.length === 0) {
    // 4a. ISA CHAIN — check protocol conformance
    const protoT0 = Date.now();
    const protocolMatch = context.resolveViaProtocol(selector);
    if (protocolMatch) {
      context.cache.store(selector, protocolMatch.imp, protocolMatch.confidence);
      const tier = computeTier(protocolMatch.confidence, context.thresholds);
      addProofStep(proof, {
        stage: 'protocol',
        input: selector.canonical,
        output: protocolMatch.imp.toolName,
        decision: `Protocol conformance → ${protocolMatch.imp.toolName} at ${protocolMatch.confidence.toFixed(3)}`,
      }, Date.now() - protoT0);
      proof.tier = tier;
      proof.resolvedTool = protocolMatch.imp.toolName;
      return {
        kind: 'resolved',
        imp: protocolMatch.imp,
        confidence: protocolMatch.confidence,
        tier,
        selector: protocolMatch.selector,
        candidates: [],
        proof,
      };
    }

    // No candidates at all — try refinement (Pillar 4) before forwarding
    const refineT0 = Date.now();
    const nearest = await context.vectorIndex.search(selector.vector, 5, 0.3);
    const toolSummaries = collectToolSummaries(context);
    const refinementResult = await refine(intent, nearest, toolSummaries, context.llmClient);
    addProofStep(proof, {
      stage: 'refinement',
      input: intent,
      output: refinementResult.refined ? 'options generated' : 'no options',
      decision: refinementResult.refined
        ? `Refinement protocol generated ${refinementResult.refinement!.options.length} options`
        : 'Refinement failed — falling through to forwarding chain',
    }, Date.now() - refineT0);

    if (refinementResult.refined && refinementResult.refinement) {
      proof.tier = 'none';
      return {
        kind: 'refined',
        result: buildRefinementResult(refinementResult.refinement),
        proof,
      };
    }

    // 4b. FORWARDING — slow path
    const fwdT0 = Date.now();
    const result = await context.forward(selector, intent, args);
    addProofStep(proof, {
      stage: 'forwarding',
      input: intent,
      output: 'forwarded',
      decision: 'Fell through to forwarding chain',
    }, Date.now() - fwdT0);
    proof.tier = 'none';
    return { kind: 'forwarded', result, proof };
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0];
  const tier = computeTier(best.confidence, context.thresholds);
  proof.tier = tier;

  // -----------------------------------------------------------------------
  // CONFIDENCE-TIERED BRANCHING (0.4.0 core logic)
  // -----------------------------------------------------------------------

  // MEDIUM tier → Pre-flight verification (Pillar 2)
  if (requiresVerification(tier) || (context.strict && tier !== 'exact')) {
    const verifyT0 = Date.now();
    const verification = await verify(
      best.imp,
      intent,
      args ?? {},
      context.llmClient,
      { skipLLMCheck: !context.llmClient.microCheck },
    );
    addProofStep(proof, {
      stage: 'verification',
      input: { tool: best.imp.toolName, intent },
      output: verification,
      decision: verification.pass
        ? `Verification passed for ${best.imp.toolName} (schema: ${verification.schemaMatch}, overlap: ${(verification.descriptionOverlap * 100).toFixed(0)}%)`
        : `Verification FAILED: ${verification.reason}`,
    }, Date.now() - verifyT0);

    if (!verification.pass) {
      // Verification failed — try next candidate or fall through
      const remaining = candidates.slice(1);
      for (const alt of remaining) {
        const altVerification = await verify(alt.imp, intent, args ?? {}, context.llmClient, { skipLLMCheck: true });
        if (altVerification.pass) {
          context.cache.store(selector, alt.imp, alt.confidence);
          proof.resolvedTool = alt.imp.toolName;
          return {
            kind: 'resolved',
            imp: alt.imp,
            confidence: alt.confidence,
            tier: computeTier(alt.confidence, context.thresholds),
            selector: alt.selector,
            candidates,
            proof,
          };
        }
      }
      // All candidates failed verification — try refinement
      const nearest = await context.vectorIndex.search(selector.vector, 5, 0.3);
      const toolSummaries = collectToolSummaries(context);
      const refinementResult = await refine(intent, nearest, toolSummaries, context.llmClient);
      if (refinementResult.refined && refinementResult.refinement) {
        proof.tier = 'none';
        return { kind: 'refined', result: buildRefinementResult(refinementResult.refinement), proof };
      }
    }
  }

  // LOW tier → Intent decomposition (Pillar 3)
  if (requiresDecomposition(tier)) {
    const decompT0 = Date.now();
    const toolSummaries = collectToolSummaries(context);
    const decompResult = await decompose(intent, toolSummaries, context.llmClient);
    addProofStep(proof, {
      stage: 'decomposition',
      input: intent,
      output: decompResult.decomposed ? `${decompResult.subIntents.length} sub-intents` : 'not decomposed',
      decision: decompResult.decomposed
        ? `Decomposed into ${decompResult.subIntents.length} sub-intents (${decompResult.strategy})`
        : 'Decomposition unavailable — dispatching best match',
    }, Date.now() - decompT0);

    if (decompResult.decomposed) {
      // Execute the decomposition using toolkit_dispatch as the dispatcher
      const execResult = await executeDecomposition(
        decompResult,
        (subIntent, subArgs) => toolkit_dispatch(context, subIntent, subArgs),
      );
      return { kind: 'decomposed', result: execResult, proof };
    }
    // If decomposition isn't available (no LLM), fall through to dispatch best match
  }

  // NONE tier → Refinement protocol (Pillar 4)
  if (requiresRefinement(tier)) {
    const refineT0 = Date.now();
    const nearest = await context.vectorIndex.search(selector.vector, 5, 0.3);
    const toolSummaries = collectToolSummaries(context);
    const refinementResult = await refine(intent, nearest, toolSummaries, context.llmClient);
    addProofStep(proof, {
      stage: 'refinement',
      input: intent,
      output: refinementResult.refined ? 'options generated' : 'no options',
      decision: refinementResult.refined
        ? `Refinement protocol generated ${refinementResult.refinement!.options.length} options`
        : 'Refinement failed — forwarding chain',
    }, Date.now() - refineT0);

    if (refinementResult.refined && refinementResult.refinement) {
      return { kind: 'refined', result: buildRefinementResult(refinementResult.refinement), proof };
    }

    // Fall through to forwarding
    const result = await context.forward(selector, intent, args);
    return { kind: 'forwarded', result, proof };
  }

  // EXACT/HIGH tier — dispatch immediately
  context.cache.store(selector, best.imp, best.confidence);
  proof.resolvedTool = best.imp.toolName;

  return {
    kind: 'resolved',
    imp: best.imp,
    confidence: best.confidence,
    tier,
    selector: best.selector,
    candidates,
    proof,
  };
}

/**
 * toolkit_dispatch — the hot path. Equivalent to objc_msgSend.
 *
 * Uses resolveToolIMP for resolution, then executes synchronously.
 *
 * 0.4.0: Now records dispatch to the observer (Pillar 5) and annotates
 * results with confidence tier and resolution proof.
 */
export async function toolkit_dispatch(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  const outcome = await resolveToolIMP(context, intent, args);

  if (outcome.kind === 'forwarded') {
    return annotateResult(outcome.result, outcome.proof);
  }

  if (outcome.kind === 'decomposed') {
    return annotateResult(outcome.result, outcome.proof);
  }

  if (outcome.kind === 'refined') {
    return annotateResult(outcome.result, outcome.proof);
  }

  const result = await executeWithArgs(outcome.imp, args ?? {});

  // Record dispatch for observer (Pillar 5)
  context.observer.recordDispatch({
    intent,
    tool: outcome.imp.toolName,
    confidence: outcome.confidence,
    timestamp: Date.now(),
    schemaRejected: result.isError && result.metadata?.validationErrors !== undefined,
  });

  // Track schema rejections
  if (result.isError && result.metadata?.validationErrors) {
    context.observer.recordSchemaRejection(
      outcome.imp.toolName,
      intent,
      typeof result.content === 'object' && result.content !== null
        ? JSON.stringify(result.content)
        : String(result.content),
    );
  }

  // Annotate with confidence tier and proof
  result.metadata = {
    ...result.metadata,
    confidence: outcome.confidence,
    tier: outcome.tier,
    proof: outcome.proof,
  };

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

/** Add proof metadata to any ToolResult */
function annotateResult(result: ToolResult, proof: ResolutionProof): ToolResult {
  result.metadata = {
    ...result.metadata,
    tier: proof.tier,
    proof,
  };
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
    const metadata: Record<string, unknown> = {};
    if (err instanceof UnrecognizedIntent) {
      metadata.nearestSelectors = err.nearestSelectors;
      metadata.suggestion = err.suggestion;
    }
    if (err instanceof SignatureValidationError) {
      metadata.typeConfusionGuard = true;
      metadata.violations = err.violations;
      metadata.signature = err.signature.signatureKey;
    }
    if (err instanceof VectorFloodError) {
      metadata.throttled = true;
      metadata.reason = 'vector-flooding';
    }
    yield {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    return;
  }

  if (outcome.kind === 'forwarded' || outcome.kind === 'decomposed' || outcome.kind === 'refined') {
    yield { type: 'done', result: annotateResult(outcome.result, outcome.proof) };
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
  // Run constraint validation before streaming — prevents type confusion
  const validation = imp.constraints.validate(args);
  if (!validation.valid) {
    yield {
      type: 'error',
      error: `Argument validation failed: ${validation.errors.map(e => e.message).join('; ')}`,
      metadata: { validationErrors: validation.errors, typeConfusionGuard: true },
    };
    return;
  }

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
 *
 * Runs the IMP's own constraint validation before execution as
 * a final safety net against type confusion.
 */
function executeWithArgs(
  imp: ToolIMP,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Run constraint validation as a final safety net
  const validation = imp.constraints.validate(args);
  if (!validation.valid) {
    return Promise.resolve({
      content: {
        error: 'Argument validation failed',
        violations: validation.errors,
      },
      isError: true,
      metadata: {
        validationErrors: validation.errors,
        typeConfusionGuard: true,
      },
    });
  }

  const unwrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    unwrapped[key] = unwrapValue(value);
  }
  return imp.execute(unwrapped);
}
