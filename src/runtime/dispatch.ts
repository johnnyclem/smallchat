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
import { SemanticMap } from './semantic-map.js';
import type { SemanticMapOptions, LearnedPreference } from './semantic-map.js';

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
  /** Pre-built semantic map (Pillar 4b) — e.g. restored from persistence */
  semanticMap?: SemanticMap;
  /** Options for the semantic map, when one is not supplied */
  semanticMapOptions?: SemanticMapOptions;
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
  readonly semanticMap: SemanticMap;
  readonly llmClient: LLMClient;
  readonly strict: boolean;
  readonly thresholds: TierThresholds;

  private toolClasses: Map<string, ToolClass> = new Map();
  private protocols: Map<string, ToolProtocol> = new Map();
  /**
   * Dispatch index — selector canonical → the classes that declare it.
   *
   * The inline-cache analogue for resolution: instead of re-scanning every
   * registered class for every vector match (O(matches × classes)), the hot
   * path consults only the classes that actually own the matched selector.
   * This is what lets the registry scale to thousands of tools.
   */
  private selectorToClasses: Map<string, ToolClass[]> = new Map();
  /** Memoized tool summaries for LLM-powered features; invalidated on registry mutation */
  private toolSummariesCache: ToolSummary[] | null = null;
  /** Reentrancy guard so the forwarding chain's decomposition can't loop forever */
  private inForwardDecompose = false;

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
    this.semanticMap = dispatchConfig?.semanticMap
      ?? new SemanticMap(dispatchConfig?.semanticMapOptions);
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
    this.indexClass(toolClass);
  }

  /** Index a class's selectors → owning class, and invalidate the summary cache. */
  private indexClass(toolClass: ToolClass): void {
    for (const canonical of toolClass.dispatchTable.keys()) {
      const owners = this.selectorToClasses.get(canonical) ?? [];
      if (!owners.includes(toolClass)) owners.push(toolClass);
      this.selectorToClasses.set(canonical, owners);
    }
    this.toolSummariesCache = null;
  }

  /**
   * Rebuild the dispatch index from scratch. Call after a registry mutation
   * that changes existing dispatch tables (loadCategory, addOverload, swizzle).
   */
  reindex(): void {
    this.selectorToClasses.clear();
    for (const toolClass of this.toolClasses.values()) this.indexClass(toolClass);
    this.toolSummariesCache = null;
  }

  /** The classes that declare a given selector canonical — the resolution candidates. */
  classesForSelector(canonical: string): ToolClass[] {
    return this.selectorToClasses.get(canonical) ?? [];
  }

  /**
   * Resolve a canonical selector id to a concrete IMP + selector, if any
   * registered class still owns it. Used by the semantic map to turn a learned
   * preference back into an executable dispatch. Returns null if the selector
   * has since been unregistered (a stale learned preference).
   */
  resolveLearnedSelector(selectorId: string): { imp: ToolIMP; selector: ToolSelector } | null {
    const selector = this.selectorTable.get(selectorId);
    if (!selector) return null;
    for (const toolClass of this.classesForSelector(selectorId)) {
      const imp = toolClass.resolveSelector(selector);
      if (imp) return { imp, selector };
    }
    return null;
  }

  /**
   * Reinforce a learned dispatch preference (Pillar 4b).
   *
   * Called when the user resolves a refinement by choosing one of the deferred
   * options. Embeds the original (unresolvable) intent and records a mapping to
   * the chosen selector so that the exact intent resolves instantly next time,
   * and *similar* intents get a confidence boost toward the same selector.
   */
  async reinforceRefinement(originalIntent: string, selectorId: string): Promise<LearnedPreference> {
    const selector = await this.selectorTable.resolve(originalIntent);
    return this.semanticMap.reinforce(canonicalize(originalIntent), selector.vector, selectorId);
  }

  /**
   * Tool summaries for LLM-powered features (verification, decomposition,
   * refinement). Computed once and memoized; invalidated on registry mutation.
   */
  getToolSummaries(): ToolSummary[] {
    if (this.toolSummariesCache) return this.toolSummariesCache;
    const summaries: ToolSummary[] = [];
    for (const toolClass of this.toolClasses.values()) {
      for (const [, imp] of toolClass.dispatchTable) {
        summaries.push({
          name: imp.toolName,
          description: imp.schema?.description ?? imp.toolName,
          parameters: imp.schema?.arguments.map(a => a.name),
        });
      }
    }
    this.toolSummariesCache = summaries;
    return summaries;
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

        for (const toolClass of this.classesForSelector(match.id)) {
          const imp = toolClass.resolveSelector(matchSelector);
          if (imp) {
            fallbackSteps.push({
              strategy: 'broadened_search',
              tried: `${match.id} (distance: ${match.distance.toFixed(3)})`,
              result: 'hit',
            });
            const confidence = toConfidence(match.distance);
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

    // Step 3: LLM DISAMBIGUATION — decompose an unrecognized compound intent.
    //
    // This is the genuinely-missing capability at this depth: refinement has
    // already been tried before forwarding, but decomposition (breaking the
    // intent into sub-intents and dispatching each through the normal pipeline)
    // is otherwise only attempted in the LOW tier. The reentrancy guard stops a
    // pathological LLM from looping forward → decompose → forward forever.
    if (this.llmClient !== NULL_LLM_CLIENT && this.llmClient.decompose && !this.inForwardDecompose) {
      const decompResult = await decompose(intent, this.getToolSummaries(), this.llmClient);
      if (decompResult.decomposed) {
        this.inForwardDecompose = true;
        try {
          const execResult = await executeDecomposition(
            decompResult,
            (subIntent, subArgs) => toolkit_dispatch(this, subIntent, subArgs),
          );
          fallbackSteps.push({
            strategy: 'llm_disambiguate',
            tried: `decompose → ${decompResult.subIntents.length} sub-intents (${decompResult.strategy})`,
            result: 'hit',
          });
          return {
            content: execResult.content,
            isError: execResult.isError,
            metadata: { ...execResult.metadata, fallback: true, fallbackSteps },
          };
        } finally {
          this.inForwardDecompose = false;
        }
      }
      fallbackSteps.push({
        strategy: 'llm_disambiguate',
        tried: 'decompose (no sub-intents produced)',
        result: 'miss',
      });
    } else {
      fallbackSteps.push({
        strategy: 'llm_disambiguate',
        tried: this.inForwardDecompose ? 'decompose (skipped — already decomposing)' : 'no llm client',
        result: 'miss',
      });
    }

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
 * Convert a vector distance into a confidence score, clamped to [0, 1].
 *
 * Some backends can return a cosine distance greater than 1 (vectors more
 * than orthogonal); without the clamp that would yield a negative confidence
 * and corrupt tier computation. Confidence is never negative.
 */
function toConfidence(distance: number): number {
  return Math.max(0, 1 - distance);
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
        for (const toolClass of context.classesForSelector(exactPinMatch.canonical)) {
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

  // 1b. SEMANTIC MAP — exact fast-path for a previously-disambiguated intent.
  //
  // If the user has taught us this exact intent before (by resolving a
  // refinement), resolve straight to the selector they chose. This is what
  // stops smallchat from re-asking the same question every time: defer once,
  // remember forever.
  if (context.semanticMap.size > 0) {
    const smT0 = Date.now();
    const learned = context.semanticMap.lookupExact(intentCanonical);
    if (learned) {
      const resolved = context.resolveLearnedSelector(learned.selectorId);
      if (resolved && !context.observer.isNegativeExample(intent, resolved.imp.toolName)) {
        const confidence = context.semanticMap.exactConfidence;
        context.cache.store(selector, resolved.imp, confidence);
        const tier = computeTier(confidence, context.thresholds);
        addProofStep(proof, {
          stage: 'semantic_map',
          input: intentCanonical,
          output: learned.selectorId,
          decision: `Learned preference (exact, ${learned.reinforcements}× reinforced) → ${resolved.imp.toolName} at ${confidence.toFixed(3)} (${tier})`,
        }, Date.now() - smT0);
        proof.tier = tier;
        proof.resolvedTool = resolved.imp.toolName;
        return {
          kind: 'resolved',
          imp: resolved.imp,
          confidence,
          tier,
          selector: resolved.selector,
          candidates: [],
          proof,
        };
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
        toConfidence(match.distance),
        intentCanonical,
      );
      if (pinCheck) {
        if (pinCheck.verdict === 'reject') continue;
      }
    }

    // Consult only the classes that declare this selector (dispatch index),
    // not the entire registry — O(owners) instead of O(all classes).
    for (const toolClass of context.classesForSelector(match.id)) {
      // 3a. OVERLOAD RESOLUTION
      if (hasArgs && toolClass.hasOverloads(matchSelector)) {
        const overloadResult = toolClass.validateAndResolveSelectorWithNamedArgs(
          matchSelector,
          args,
        );
        if (overloadResult) {
          const confidence = toConfidence(match.distance);
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
          confidence: toConfidence(match.distance),
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

  // 3b. SEMANTIC MAP — similar-intent boost.
  //
  // A near-miss the user *previously* disambiguated should not fall back to
  // "ask again". If this intent is similar to one the user has already resolved,
  // boost the learned selector's confidence — enough to lift it out of the NONE
  // zone and often to dispatch it directly. The learned selector may score below
  // the vector-search floor (that's why it was a near-miss), so we inject it as
  // a candidate when it isn't already present.
  if (context.semanticMap.size > 0) {
    const smT0 = Date.now();
    const smMatch = context.semanticMap.lookupSimilar(selector.vector);
    if (smMatch) {
      const resolved = context.resolveLearnedSelector(smMatch.preference.selectorId);
      if (resolved && !context.observer.isNegativeExample(intent, resolved.imp.toolName)) {
        const existing = candidates.find(c => c.selector.canonical === smMatch.preference.selectorId);
        const base = existing ? existing.confidence : smMatch.similarity;
        const boosted = Math.min(context.semanticMap.boostCeiling, base + smMatch.boost);
        if (existing) {
          existing.confidence = boosted;
        } else {
          candidates.push({ imp: resolved.imp, confidence: boosted, selector: resolved.selector });
        }
        addProofStep(proof, {
          stage: 'semantic_map',
          input: { intent, similarity: smMatch.similarity.toFixed(3) },
          output: smMatch.preference.selectorId,
          decision: `Learned preference (similar, ${smMatch.preference.reinforcements}× reinforced) ${existing ? 'boosted' : 'injected'} ${resolved.imp.toolName} → ${boosted.toFixed(3)} (+${smMatch.boost.toFixed(3)})`,
        }, Date.now() - smT0);
      }
    }
  }

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
    const toolSummaries = context.getToolSummaries();
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
      const toolSummaries = context.getToolSummaries();
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
    const toolSummaries = context.getToolSummaries();
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
  //
  // NOTE: this branch is effectively unreachable for the candidate path. The
  // vector search floor is `thresholds.low` (and `thresholds.medium` in strict
  // mode), so any surviving candidate already scores >= low and never computes
  // to the `none` tier. The candidates-empty case above handles true NONE via
  // protocol → refine → forward. Kept for completeness and custom thresholds.
  if (requiresRefinement(tier)) {
    const refineT0 = Date.now();
    const nearest = await context.vectorIndex.search(selector.vector, 5, 0.3);
    const toolSummaries = context.getToolSummaries();
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
