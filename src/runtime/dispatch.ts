import type { Embedder, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex, DispatchEvent, InferenceDelta, ToolRefinementNeeded, ValidationError } from '../core/types.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable, canonicalize, VectorFloodError } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { unwrapValue } from '../core/sc-object.js';
import { SelectorNamespace } from '../core/selector-namespace.js';
import { SignatureValidationError } from '../core/overload-table.js';
import { IntentPinRegistry } from '../core/intent-pin.js';
import { computeTier, DEFAULT_THRESHOLDS } from '../core/confidence.js';
import type { ConfidenceTier, TierThresholds } from '../core/confidence.js';
import { addProofStep, createProof, finalizeProof, proofClock } from '../core/proof.js';
import type { CandidateSource, DecisionCode, ProofCandidate, ProofStage, ResolutionOutcome, ResolutionProof } from '../core/proof.js';
import { cosineSimilarity } from '../core/vector-math.js';
import { canonicalJson } from '../core/jcs.js';
import { callDigest } from '../core/call-digest.js';
import { compileArgumentValidator, InputSchemaError } from '../core/argument-validator.js';
import type { ArgumentCoercion } from '../core/argument-validator.js';
import type { LLMClient, ToolSummary } from '../core/llm-client.js';
import { NULL_LLM_CLIENT } from '../core/llm-client.js';
import { verify } from './verification.js';
import { decompose, executeDecomposition } from './decomposition.js';
import type { DecompositionResult } from './decomposition.js';
import { refine } from './refinement.js';
import { DispatchObserver } from './observer.js';
import type { ObserverOptions } from './observer.js';
import { SemanticMap } from './semantic-map.js';
import type { SemanticMapOptions, LearnedPreference } from './semantic-map.js';
import { evaluateDispatchPolicy, isDestructive } from './policy.js';
import type { DispatchPolicyOptions, PinState, PolicyCode, PolicyVerdict } from './policy.js';

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
 * DispatchConfig — configuration for dispatch features.
 */
export interface DispatchConfig {
  /** LLM client for verification, decomposition, refinement (optional — features degrade without it) */
  llmClient?: LLMClient;
  /** Strict mode: verify every dispatch below EXACT, and raise the search floor to MEDIUM */
  strict?: boolean;
  /** Custom tier thresholds */
  thresholds?: TierThresholds;
  /** Observer options for Pillar 5 */
  observerOptions?: ObserverOptions;
  /** Pre-built semantic map (Pillar 4b) — e.g. restored from persistence */
  semanticMap?: SemanticMap;
  /** Options for the semantic map, when one is not supplied */
  semanticMapOptions?: SemanticMapOptions;
  /**
   * Below HIGH confidence (MEDIUM/LOW), auto-dispatch a resolved tool only
   * when an LLM verifier (LLMClient.microCheck) approved it for the intent.
   * Without approval the outcome is needs-disambiguation. Default true.
   * Set false to restore 0.x behaviour (schema/keyword verification only).
   */
  requireLLMForSubHighDispatch?: boolean;
  /**
   * Treat tools without any MCP annotations as destructive (they then run
   * only by exact id, a pinned phrase or EXACT similarity). Default false.
   */
  treatUnannotatedAsDestructive?: boolean;
  /** Type coercion applied before argument validation. Default 'none'. */
  argumentCoercion?: ArgumentCoercion;
  /** contentHash of the artifact the tools came from — recorded in every proof */
  artifactHash?: string;
}

/** One executable tool in the dispatch registry. */
export interface RegisteredTool {
  /** Canonical tool id `<providerId>/<toolName>` */
  id: string;
  imp: ToolIMP;
  /** Selector canonicals that dispatch to this tool */
  selectors: string[];
}

/**
 * DispatchContext — the runtime context for tool dispatch.
 *
 * Holds the selector table, resolution cache, tool classes (providers),
 * vector index, protocol registry, and the dispatch policy configuration.
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
  readonly requireLLMForSubHighDispatch: boolean;
  readonly treatUnannotatedAsDestructive: boolean;
  readonly argumentCoercion: ArgumentCoercion;
  readonly artifactHash: string | null;

  private toolClasses: Map<string, ToolClass> = new Map();
  private protocols: Map<string, ToolProtocol> = new Map();
  /**
   * Dispatch index — selector canonical → the classes that declare it
   * (directly or through a superclass). The hot path consults only the
   * classes that own a matched selector.
   */
  private selectorToClasses: Map<string, ToolClass[]> = new Map();
  /** Tool index — canonical tool id → the one IMP it names (O(1) dispatch by id) */
  private toolsById: Map<string, RegisteredTool> = new Map();
  /** Ids claimed by two different IMPs; dispatch by such an id is refused */
  private ambiguousIds: Set<string> = new Set();
  /** Memoized tool summaries for LLM-powered features; invalidated on registry mutation */
  private toolSummariesCache: ToolSummary[] | null = null;

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
    this.requireLLMForSubHighDispatch = dispatchConfig?.requireLLMForSubHighDispatch ?? true;
    this.treatUnannotatedAsDestructive = dispatchConfig?.treatUnannotatedAsDestructive ?? false;
    this.argumentCoercion = dispatchConfig?.argumentCoercion ?? 'none';
    this.artifactHash = dispatchConfig?.artifactHash ?? null;
    this.observer = new DispatchObserver(dispatchConfig?.observerOptions);
    this.semanticMap = dispatchConfig?.semanticMap
      ?? new SemanticMap(dispatchConfig?.semanticMapOptions);
  }

  /** The policy options every dispatch path evaluates against. */
  get policyOptions(): DispatchPolicyOptions {
    return {
      thresholds: this.thresholds,
      requireLLMForSubHighDispatch: this.requireLLMForSubHighDispatch,
      treatUnannotatedAsDestructive: this.treatUnannotatedAsDestructive,
    };
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

  /** Index a class's selectors → owning class and its tools by id; invalidate summaries. */
  private indexClass(toolClass: ToolClass): void {
    for (const canonical of new Set(toolClass.allSelectors())) {
      const owners = this.selectorToClasses.get(canonical) ?? [];
      if (!owners.includes(toolClass)) owners.push(toolClass);
      this.selectorToClasses.set(canonical, owners);

      const imp = toolClass.resolveSelector({ canonical } as ToolSelector);
      if (imp) this.indexTool(imp, canonical);
    }
    for (const table of toolClass.overloadTables.values()) {
      for (const entry of table.allOverloads()) this.indexTool(entry.imp, table.selectorCanonical);
    }
    this.toolSummariesCache = null;
  }

  private indexTool(imp: ToolIMP, selector: string): void {
    const id = toolIdOf(imp);
    const existing = this.toolsById.get(id);
    if (!existing) {
      this.toolsById.set(id, { id, imp, selectors: [selector] });
    } else if (existing.imp === imp) {
      if (!existing.selectors.includes(selector)) existing.selectors.push(selector);
    } else {
      this.ambiguousIds.add(id);
    }
  }

  /**
   * Rebuild the dispatch index from scratch. Call after a registry mutation
   * that changes existing dispatch tables (loadCategory, addOverload, swizzle).
   */
  reindex(): void {
    this.selectorToClasses.clear();
    this.toolsById.clear();
    this.ambiguousIds.clear();
    for (const toolClass of this.toolClasses.values()) this.indexClass(toolClass);
    this.toolSummariesCache = null;
  }

  /** The classes that declare a given selector canonical — the resolution candidates. */
  classesForSelector(canonical: string): ToolClass[] {
    return this.selectorToClasses.get(canonical) ?? [];
  }

  /**
   * The tool a canonical id names, or undefined when no tool has that id
   * (or two different tools claim it). O(1); no embedding.
   */
  getTool(toolId: string): RegisteredTool | undefined {
    if (this.ambiguousIds.has(toolId)) return undefined;
    return this.toolsById.get(toolId);
  }

  /** Whether two different tools claim this id (dispatch by it is refused). */
  isAmbiguousToolId(toolId: string): boolean {
    return this.ambiguousIds.has(toolId);
  }

  /** Every registered tool id, sorted. */
  toolIds(): string[] {
    return [...this.toolsById.keys()].filter(id => !this.ambiguousIds.has(id)).sort();
  }

  /** The tool a selector canonical dispatches to (its first owning class), if any. */
  toolForSelector(canonical: string): { imp: ToolIMP; selector: ToolSelector; toolId: string } | null {
    const selector = this.selectorTable.get(canonical);
    if (!selector) return null;
    for (const toolClass of this.classesForSelector(canonical)) {
      const imp = toolClass.resolveSelector(selector);
      if (imp) return { imp, selector, toolId: toolIdOf(imp) };
    }
    return null;
  }

  /**
   * Resolve a canonical selector id to a concrete IMP + selector, if any
   * registered class still owns it. Used by the semantic map to turn a learned
   * preference back into an executable dispatch. Returns null if the selector
   * has since been unregistered (a stale learned preference).
   */
  resolveLearnedSelector(selectorId: string): { imp: ToolIMP; selector: ToolSelector } | null {
    const found = this.toolForSelector(selectorId);
    return found ? { imp: found.imp, selector: found.selector } : null;
  }

  /**
   * Reinforce a learned dispatch preference (Pillar 4b).
   *
   * Called when the user resolves a refinement by choosing one of the deferred
   * options. Embeds the original (unresolvable) intent and records a mapping to
   * the chosen selector so that the exact intent resolves instantly next time,
   * and *similar* intents get a confidence boost toward the same selector.
   * Learned preferences never authorize a pinned or destructive tool: the
   * dispatch policy requires an exact phrase or EXACT similarity for those.
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
  resolveViaProtocol(selector: ToolSelector): { imp: ToolIMP; confidence: number; selector: ToolSelector } | null {
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
   * How the intent pins apply to one tool for one intent. `ownSimilarity`
   * computes the cosine similarity between the intent's own embedding and
   * a selector (for 'elevated' pins).
   */
  async pinStatesFor(
    toolId: string,
    intent: string,
    ownSimilarity: (selector: ToolSelector) => Promise<number>,
  ): Promise<PinState[]> {
    if (this.intentPins.size === 0) return [];
    const states: PinState[] = [];
    for (const canonical of this.intentPins.pinnedCanonicals()) {
      const owner = this.toolForSelector(canonical);
      if (!owner || owner.toolId !== toolId) continue;
      const pin = this.intentPins.getPin(canonical)!;
      const phrase = this.intentPins.matchesPinnedPhrase(canonical, intent);
      if (pin.policy === 'exact') {
        states.push({ canonical, policy: 'exact', satisfied: phrase });
        continue;
      }
      const similarity = phrase ? null : await ownSimilarity(owner.selector);
      const verdict = this.intentPins.checkSimilarity(canonical, similarity ?? 0, intent);
      states.push({
        canonical,
        policy: 'elevated',
        satisfied: phrase || verdict?.verdict === 'accept',
        similarity,
        requiredThreshold: verdict?.requiredThreshold,
      });
    }
    return states;
  }

  /** Whether any intent pin applies to this tool. */
  isPinnedTool(toolId: string): boolean {
    if (this.intentPins.size === 0) return false;
    return this.intentPins.pinnedCanonicals().some(c => this.toolForSelector(c)?.toolId === toolId);
  }

  /** A new proof stamped with this context's thresholds, guards and identity. */
  newProof(intent: string | null): ResolutionProof {
    return createProof(intent, {
      thresholds: this.thresholds,
      guards: {
        requireLLMForSubHighDispatch: this.requireLLMForSubHighDispatch,
        strict: this.strict,
        llmVerifier: typeof this.llmClient.microCheck === 'function',
        treatUnannotatedAsDestructive: this.treatUnannotatedAsDestructive,
      },
      embedder: this.embedder.fingerprint ?? null,
      artifactHash: this.artifactHash,
    });
  }

  /** Get all registered tool classes */
  getClasses(): ToolClass[] {
    return Array.from(this.toolClasses.values());
  }
}

/** Canonical tool id of an IMP: `<providerId>/<toolName>`. */
export function toolIdOf(imp: Pick<ToolIMP, 'providerId' | 'toolName'>): string {
  return `${imp.providerId}/${imp.toolName}`;
}

// ---------------------------------------------------------------------------
// Resolution — pure: chooses a tool (or refuses to), never executes
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /**
   * Record what resolution learns: intern the intent into the selector
   * table and cache a HIGH/EXACT result. Default false for
   * `runtime.resolve()`, which then has no effect on the runtime beyond
   * semantic rate limiting; `dispatch()` resolves with learning on.
   */
  learn?: boolean;
  /**
   * The arguments the call will carry, when known. Used to choose among
   * overloads and by verification's required-parameter check.
   */
  args?: Record<string, unknown>;
}

/** One ranked candidate of a resolution. */
export type ResolutionCandidate = ProofCandidate;

/** What `resolve(intent)` decided. Nothing has executed. */
export interface Resolution {
  outcome: ResolutionOutcome;
  intent: string;
  /** Tier of the chosen (or best) candidate */
  tier: ConfidenceTier;
  /** Canonical tool id resolution chose — present only when outcome is 'resolved' */
  chosen?: string;
  /** Score of the chosen candidate */
  confidence?: number;
  /** Eligible candidates, best first (excluded ones are listed in the proof) */
  candidates: ResolutionCandidate[];
  proof: ResolutionProof;
  /** Why the runtime would not pick a tool on its own (needs-disambiguation / unresolved) */
  reason?: string;
  /** Options to present to the user; each carries a toolId for dispatchById */
  refinement?: ToolRefinementNeeded;
}

interface Candidate {
  imp: ToolIMP;
  toolId: string;
  /** The tool selector the candidate matched through */
  selector: ToolSelector;
  score: number;
  similarity: number | null;
  source: CandidateSource;
}

interface InternalResolution {
  resolution: Resolution;
  /** The chosen IMP when resolved */
  imp: ToolIMP | null;
  /** Set when dispatch should run a decomposition instead of one tool */
  decomposition: DecompositionResult | null;
}

interface ResolveRun {
  learn: boolean;
  args?: Record<string, unknown>;
  /** Dispatch (not resolve) may decompose LOW-tier / unmatched intents */
  allowDecomposition: boolean;
  /** Decomposition depth of this dispatch (sub-intents are depth + 1) */
  depth: number;
}

/** Maximum decomposition depth: sub-intents of sub-intents… stop here. */
const MAX_DECOMPOSITION_DEPTH = 3;

/**
 * Convert a vector distance into a confidence score, clamped to [0, 1].
 *
 * Some backends can return a cosine distance greater than 1 (vectors more
 * than orthogonal); without the clamp that would yield a negative confidence
 * and corrupt tier computation. Confidence is never negative.
 */
function toConfidence(distance: number): number {
  return Math.min(1, Math.max(0, 1 - distance));
}

/** The decision code recorded when the policy refuses a candidate. */
function denial(verdict: PolicyVerdict): DecisionCode {
  return verdict.code as Exclude<PolicyCode, 'allow'>;
}

/** Candidates ranked by score, ties broken by tool id (deterministic). */
function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => b.score - a.score || (a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0));
}

/**
 * Resolve an intent to at most one tool. Never executes anything.
 *
 * Order: pinned phrase → learned exact intent → cache → ranked candidates
 * (vector and overload matches, learned similar-intent boosts, protocol
 * conformance). Every candidate passes the pin gate; the chosen one passes
 * verification (below HIGH, or in strict mode) and the dispatch policy
 * (runtime/policy.ts). Anything the policy refuses is needs-disambiguation.
 */
export async function resolveIntent(
  context: DispatchContext,
  intent: string,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const r = await resolveInternal(context, intent, {
    learn: options.learn ?? false,
    args: options.args,
    allowDecomposition: false,
    depth: 0,
  });
  return r.resolution;
}

async function resolveInternal(
  context: DispatchContext,
  intent: string,
  run: ResolveRun,
): Promise<InternalResolution> {
  const proof = context.newProof(intent);
  const llm = context.llmClient;
  const args = run.args;
  const hasArgs = args !== undefined && Object.keys(args).length > 0;
  const excluded: ProofCandidate[] = [];
  let clock = proofClock();

  const step = (stage: ProofStage, decision: string, detail?: Record<string, unknown>): void => {
    const now = proofClock();
    addProofStep(proof, detail === undefined ? { stage, decision } : { stage, decision, detail }, now - clock);
    clock = now;
  };

  // The intent's own embedding, computed at most once: similarities that
  // authorize pinned or destructive tools are always measured from it,
  // never from a cached or interned vector of some other phrasing.
  let ownVector: Float32Array | null = null;
  const ownSimilarity = async (selector: ToolSelector): Promise<number> => {
    ownVector ??= await context.embedder.embed(intent);
    return Math.min(1, Math.max(0, cosineSimilarity(ownVector, selector.vector)));
  };

  const toProofCandidate = (c: Candidate, excludedBy?: string): ProofCandidate => ({
    toolId: c.toolId,
    selector: c.selector.canonical,
    score: c.score,
    similarity: c.similarity,
    tier: computeTier(c.score, context.thresholds),
    source: c.source,
    ...(excludedBy ? { excluded: excludedBy } : {}),
  });

  /** Pin gate + dispatch policy for one candidate. */
  const judge = async (c: Candidate, llmApproved: boolean): Promise<PolicyVerdict> => {
    let similarity = c.similarity;
    if (similarity !== null && (isDestructive(c.imp.annotations, context.policyOptions) || context.isPinnedTool(c.toolId))) {
      // Re-measure from this intent's own text (the selector table may have
      // handed back an interned vector of a different phrasing).
      similarity = await ownSimilarity(c.selector);
    }
    const pins = await context.pinStatesFor(c.toolId, intent, ownSimilarity);
    return evaluateDispatchPolicy(
      { mode: 'intent', toolId: c.toolId, imp: c.imp, source: c.source, score: c.score, similarity, llmApproved, pins },
      context.policyOptions,
    );
  };

  const isPinFailure = (v: PolicyVerdict): boolean =>
    v.code === 'pin-exact-required' || v.code === 'pin-elevated-required';

  const finish = (
    outcome: ResolutionOutcome,
    decision: DecisionCode,
    ranked: Candidate[],
    chosen: Candidate | null,
    extra: { reason?: string; refinement?: ToolRefinementNeeded; imp?: ToolIMP | null; decomposition?: DecompositionResult | null } = {},
  ): InternalResolution => {
    const best = chosen ?? ranked[0] ?? null;
    proof.outcome = outcome;
    proof.decision = decision;
    proof.tier = best ? computeTier(best.score, context.thresholds) : 'none';
    proof.chosen = outcome === 'resolved' && chosen ? chosen.toolId : null;
    proof.confidence = outcome === 'resolved' && chosen ? chosen.score : null;
    proof.candidates = [...ranked.map(c => toProofCandidate(c)), ...excluded];
    finalizeProof(proof);
    const resolution: Resolution = {
      outcome,
      intent,
      tier: proof.tier,
      candidates: ranked.map(c => toProofCandidate(c)),
      proof,
      ...(proof.chosen ? { chosen: proof.chosen, confidence: proof.confidence! } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.refinement ? { refinement: extra.refinement } : {}),
    };
    return { resolution, imp: extra.imp ?? null, decomposition: extra.decomposition ?? null };
  };

  const disambiguate = (decision: DecisionCode, ranked: Candidate[], reason: string): InternalResolution => {
    const refinement: ToolRefinementNeeded = {
      type: 'tool_refinement_needed',
      originalIntent: intent,
      question: `${reason}. Choose a tool and call it by id.`,
      options: ranked.slice(0, 5).map(c => ({
        label: c.toolId,
        intent: c.selector.canonical.replace(/[:._]/g, ' ').trim(),
        confidence: c.score,
        selectorId: c.selector.canonical,
        toolId: c.toolId,
      })),
      narrowedIntents: [],
    };
    return finish('needs-disambiguation', decision, ranked, null, { reason, refinement });
  };

  // 1. PINNED PHRASE — the intent is, verbatim, a pinned phrase.
  if (context.intentPins.size > 0) {
    const pinMatch = context.intentPins.checkExact(intent);
    const owner = pinMatch ? context.toolForSelector(pinMatch.canonical) : null;
    if (pinMatch && owner) {
      const c: Candidate = { imp: owner.imp, toolId: owner.toolId, selector: owner.selector, score: 1, similarity: null, source: 'pin' };
      const verdict = await judge(c, false);
      step('intent_pin', `"${intent}" is a pinned phrase of ${pinMatch.canonical} → ${c.toolId}`, { pin: pinMatch.canonical, policy: pinMatch.policy });
      if (verdict.allow) return finish('resolved', 'pin-exact', [c], c, { imp: c.imp });
      step('policy', verdict.reason, { code: verdict.code, toolId: c.toolId });
      return disambiguate(denial(verdict), [c], verdict.reason);
    }
  }

  // 2. EMBED the intent (interned into the selector table only when learning).
  const selector = run.learn
    ? await context.selectorTable.resolve(intent)
    : await context.selectorTable.probe(intent);
  if (!run.learn) ownVector = selector.vector;

  // 3. LEARNED EXACT — the user taught this exact intent before.
  if (context.semanticMap.size > 0) {
    const learned = context.semanticMap.lookupExact(canonicalize(intent));
    const resolved = learned ? context.resolveLearnedSelector(learned.selectorId) : null;
    if (learned && resolved && !context.observer.isNegativeExample(intent, resolved.imp.toolName)) {
      const c: Candidate = {
        imp: resolved.imp,
        toolId: toolIdOf(resolved.imp),
        selector: resolved.selector,
        score: context.semanticMap.exactConfidence,
        similarity: null,
        source: 'semantic-map-exact',
      };
      const usable = !(context.strict && computeTier(c.score, context.thresholds) !== 'exact');
      const verdict = await judge(c, false);
      if (usable && verdict.allow) {
        step('semantic_map', `Learned preference (exact, ${learned.reinforcements}x reinforced) → ${c.toolId} at ${c.score.toFixed(3)}`, { selector: learned.selectorId, reinforcements: learned.reinforcements });
        return finish('resolved', 'learned-exact', [c], c, { imp: c.imp });
      }
      step('semantic_map', `Learned preference for ${c.toolId} not used: ${usable ? verdict.reason : 'strict mode verifies below EXACT'}`, { selector: learned.selectorId, code: verdict.code });
      if (isPinFailure(verdict)) excluded.push(toProofCandidate(c, verdict.code));
    }
  }

  // 4. CACHE — a previous HIGH/EXACT resolution of this intent (no-arg calls only:
  // with arguments, overload choice depends on them).
  if (run.learn && !hasArgs) {
    const cached = context.cache.lookup(selector);
    if (cached) {
      const id = toolIdOf(cached.imp);
      const toolSelector = context.getTool(id)?.selectors[0];
      const c: Candidate = {
        imp: cached.imp,
        toolId: id,
        selector: (toolSelector && context.selectorTable.get(toolSelector)) || cached.selector,
        score: cached.confidence,
        similarity: null,
        source: 'cache',
      };
      const usable = !(context.strict && computeTier(c.score, context.thresholds) !== 'exact');
      const verdict = await judge(c, false);
      if (usable && verdict.allow) {
        step('cache', `Cache hit → ${c.toolId} at ${c.score.toFixed(3)}`, { toolId: c.toolId });
        return finish('resolved', 'cache', [c], c, { imp: c.imp });
      }
      step('cache', `Cached ${c.toolId} not used: ${usable ? verdict.reason : 'strict mode verifies below EXACT'}`, { toolId: c.toolId, code: verdict.code });
    }
  }

  // 5. VECTOR SEARCH — every match (and overload) becomes a ranked candidate.
  const floor = context.strict ? context.thresholds.medium : context.thresholds.low;
  const matches = await context.selectorTable.searchTools(selector.vector, 5, floor);
  const byTool = new Map<string, Candidate>();
  const offer = (c: Candidate): void => {
    const existing = byTool.get(c.toolId);
    if (!existing || c.score > existing.score) byTool.set(c.toolId, c);
  };

  for (const match of matches) {
    const matchSelector = context.selectorTable.get(match.id);
    if (!matchSelector) continue;
    const similarity = toConfidence(match.distance);

    for (const toolClass of context.classesForSelector(match.id)) {
      let imp: ToolIMP | null = null;
      let source: CandidateSource = 'vector';

      if (hasArgs && toolClass.hasOverloads(matchSelector)) {
        try {
          const overload = toolClass.validateAndResolveSelectorWithNamedArgs(matchSelector, args!);
          if (overload) {
            imp = overload.imp;
            source = 'overload';
            step('overload', `Overload of ${match.id} for these arguments → ${toolIdOf(imp)} (${overload.signature.signatureKey})`, { selector: match.id, signature: overload.signature.signatureKey });
          }
        } catch (err) {
          if (!(err instanceof SignatureValidationError)) throw err;
          step('overload', `No overload of ${match.id} accepts these argument types (${err.signature.signatureKey})`, {
            selector: match.id,
            violations: err.violations.map(v => ({ parameter: v.parameterName, expected: v.expected, received: v.received })),
          });
          continue;
        }
      }

      imp ??= toolClass.resolveSelector(matchSelector);
      if (!imp) continue;
      const c: Candidate = { imp, toolId: toolIdOf(imp), selector: matchSelector, score: similarity, similarity, source };
      if (context.observer.isNegativeExample(intent, imp.toolName)) {
        excluded.push(toProofCandidate(c, 'negative-example'));
        continue;
      }
      offer(c);
    }
  }

  step('vector_search', `Vector search found ${byTool.size} candidate tool(s) at or above ${floor}`, {
    floor,
    matches: matches.map(m => ({ selector: m.id, similarity: toConfidence(m.distance) })),
  });

  // 6. LEARNED SIMILAR — a near-miss the user previously disambiguated gets a boost.
  if (context.semanticMap.size > 0) {
    const smMatch = context.semanticMap.lookupSimilar(selector.vector);
    const resolved = smMatch ? context.resolveLearnedSelector(smMatch.preference.selectorId) : null;
    if (smMatch && resolved && !context.observer.isNegativeExample(intent, resolved.imp.toolName)) {
      const id = toolIdOf(resolved.imp);
      const existing = byTool.get(id);
      const base = existing ? existing.score : smMatch.similarity;
      const boosted = Math.min(context.semanticMap.boostCeiling, base + smMatch.boost);
      byTool.set(id, {
        imp: resolved.imp,
        toolId: id,
        selector: existing?.selector ?? resolved.selector,
        score: boosted,
        similarity: existing?.similarity ?? null,
        source: 'semantic-map-similar',
      });
      step('semantic_map', `Learned preference (similar, ${smMatch.preference.reinforcements}x reinforced) ${existing ? 'boosted' : 'injected'} ${id} → ${boosted.toFixed(3)} (+${smMatch.boost.toFixed(3)})`, {
        selector: smMatch.preference.selectorId,
        intentSimilarity: smMatch.similarity,
        boost: smMatch.boost,
      });
    }
  }

  // 7. PROTOCOL CONFORMANCE — only when nothing matched by vector.
  if (byTool.size === 0) {
    const protocolMatch = context.resolveViaProtocol(selector);
    if (protocolMatch) {
      const c: Candidate = {
        imp: protocolMatch.imp,
        toolId: toolIdOf(protocolMatch.imp),
        selector: protocolMatch.selector,
        score: protocolMatch.confidence,
        similarity: null,
        source: 'protocol',
      };
      offer(c);
      step('protocol', `Protocol conformance → ${c.toolId} at ${c.score.toFixed(3)}`, { selector: protocolMatch.selector.canonical });
    }
  }

  // 8. PIN GATE — a pinned tool is never a candidate for an intent its pin refuses.
  const eligible: Candidate[] = [];
  for (const c of byTool.values()) {
    if (!context.isPinnedTool(c.toolId)) {
      eligible.push(c);
      continue;
    }
    const pins = await context.pinStatesFor(c.toolId, intent, ownSimilarity);
    const refused = pins.find(p => !p.satisfied);
    if (refused) {
      excluded.push(toProofCandidate(c, refused.policy === 'exact' ? 'pin-exact-required' : 'pin-elevated-required'));
      step('intent_pin', `${c.toolId} excluded: pinned '${refused.policy}' (${refused.canonical}) and this intent does not satisfy it`, { toolId: c.toolId, pin: refused.canonical });
    } else {
      eligible.push(c);
    }
  }

  const ranked = rank(eligible);

  // 9. NOTHING MATCHED — unresolved (refinement options, or decomposition when dispatching).
  if (ranked.length === 0) {
    const nearest = await context.selectorTable.searchTools(selector.vector, 5, 0.3);
    const refinement = await refine(intent, nearest, context.getToolSummaries(), llm);
    if (refinement.refined && refinement.refinement) {
      for (const option of refinement.refinement.options) {
        if (option.selectorId) {
          const owner = context.toolForSelector(option.selectorId);
          if (owner) option.toolId = owner.toolId;
        }
      }
      step('refinement', `No candidate above ${floor}; ${refinement.refinement.options.length} refinement option(s)`);
      return finish('unresolved', 'no-candidates', ranked, null, {
        reason: `No tool matched "${intent}"`,
        refinement: refinement.refinement,
      });
    }

    if (run.allowDecomposition && llm.decompose && run.depth < MAX_DECOMPOSITION_DEPTH) {
      const d = await decompose(intent, context.getToolSummaries(), llm, { currentDepth: run.depth, maxDepth: MAX_DECOMPOSITION_DEPTH });
      step('decomposition', d.decomposed ? `Decomposed into ${d.subIntents.length} sub-intent(s) (${d.strategy})` : 'Decomposition produced no sub-intents');
      if (d.decomposed) return finish('resolved', 'decomposed', ranked, null, { decomposition: d });
    }

    step('refinement', `No candidate above ${floor} and no refinement options`);
    return finish('unresolved', 'no-candidates', ranked, null, { reason: `No tool matched "${intent}"` });
  }

  const best = ranked[0];
  const bestTier = computeTier(best.score, context.thresholds);
  const subHigh = (t: ConfidenceTier) => t === 'medium' || t === 'low';

  // 10. LOW-tier decomposition (dispatch only): a compound intent may need several tools.
  if (bestTier === 'low' && run.allowDecomposition && llm.decompose && run.depth < MAX_DECOMPOSITION_DEPTH) {
    const d = await decompose(intent, context.getToolSummaries(), llm, { currentDepth: run.depth, maxDepth: MAX_DECOMPOSITION_DEPTH });
    step('decomposition', d.decomposed ? `Decomposed into ${d.subIntents.length} sub-intent(s) (${d.strategy})` : 'Decomposition produced no sub-intents');
    if (d.decomposed) return finish('resolved', 'decomposed', ranked, null, { decomposition: d });
  }

  // 11. VERIFICATION — below HIGH, or below EXACT in strict mode. The best
  // candidate and every alternate get the same strategies, the LLM included.
  let chosen: Candidate | null = best;
  let llmApproved = false;
  const needsVerification = subHigh(bestTier) || (context.strict && bestTier !== 'exact');
  if (needsVerification) {
    const llmVerifier = typeof llm.microCheck === 'function';
    if (subHigh(bestTier) && context.requireLLMForSubHighDispatch && !llmVerifier) {
      step('verification', `Best candidate is ${bestTier}; no LLM verifier is configured to approve it`);
    } else {
      chosen = null;
      for (const c of ranked) {
        const tier = computeTier(c.score, context.thresholds);
        if (tier === 'none') break;
        if (subHigh(tier) && context.requireLLMForSubHighDispatch && !llmVerifier) break;
        const forceLLM = subHigh(tier) && context.requireLLMForSubHighDispatch;
        const v = await verify(c.imp, intent, args ?? {}, llm, {
          skipLLMCheck: !llmVerifier,
          forceLLMCheck: forceLLM,
          skipSchemaCheck: args === undefined,
        });
        step('verification', v.pass
          ? `Verification passed for ${c.toolId} (overlap ${(v.descriptionOverlap * 100).toFixed(0)}%${v.llmConfirmed === true ? ', LLM approved' : ''})`
          : `Verification failed for ${c.toolId}: ${v.reason}`, {
          toolId: c.toolId,
          pass: v.pass,
          schemaMatch: v.schemaMatch,
          descriptionOverlap: v.descriptionOverlap,
          llmConfirmed: v.llmConfirmed ?? null,
        });
        if (v.pass) {
          chosen = c;
          llmApproved = v.llmConfirmed === true;
          break;
        }
      }
      if (!chosen) {
        return disambiguate('verification-failed', ranked, `No candidate for "${intent}" passed verification`);
      }
    }
  }

  // 12. POLICY — the same rule set as every other path.
  const verdict = await judge(chosen, llmApproved);
  step('policy', verdict.reason, { code: verdict.code, toolId: chosen.toolId });
  if (!verdict.allow) {
    return disambiguate(denial(verdict), ranked, verdict.reason);
  }

  const chosenTier = computeTier(chosen.score, context.thresholds);
  const decision: DecisionCode = llmApproved && subHigh(chosenTier)
    ? 'llm-verified'
    : subHigh(chosenTier) ? 'verified' : 'ranked';

  // Learn: cache plain vector resolutions of ordinary tools (never pinned or destructive ones).
  if (run.learn && chosen.source === 'vector' && !context.isPinnedTool(chosen.toolId)
      && !isDestructive(chosen.imp.annotations, context.policyOptions)) {
    context.cache.store(selector, chosen.imp, chosen.score);
  }

  return finish('resolved', decision, ranked, chosen, { imp: chosen.imp });
}

// ---------------------------------------------------------------------------
// Execution — the one boundary every dispatch path goes through
// ---------------------------------------------------------------------------

export interface DispatchByIdOptions {
  /**
   * proofDigest of the resolution this call acts on (e.g. a
   * `runtime.resolve()` proposal the user confirmed). Recorded in the proof.
   */
  resolutionDigest?: string;
}

interface PreparedCall {
  ok: true;
  args: Record<string, unknown>;
  callDigest: string | null;
}

interface RejectedCall {
  ok: false;
  errors: ValidationError[];
}

/** Input schema of an IMP, loaded at most once per IMP. */
const schemaByImp = new WeakMap<ToolIMP, { schema: unknown }>();

async function inputSchemaOf(imp: ToolIMP): Promise<unknown> {
  if (imp.constraints?.inputSchema) return imp.constraints.inputSchema;
  const cached = schemaByImp.get(imp);
  if (cached) return cached.schema;
  const loaded = imp.schema ?? await imp.schemaLoader();
  const schema = loaded?.inputSchema;
  schemaByImp.set(imp, { schema });
  return schema;
}

/**
 * Unwrap SCObjects, validate against the tool's inputSchema (and its own
 * constraints), and compute the canonical call digest. Nothing executes
 * unless this succeeds.
 */
async function prepareCall(
  context: DispatchContext,
  imp: ToolIMP,
  toolId: string,
  args: Record<string, unknown>,
): Promise<PreparedCall | RejectedCall> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: [{ path: '', message: 'arguments must be a JSON object' }] };
  }
  const unwrapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    unwrapped[key] = unwrapValue(value);
  }

  let schema: unknown;
  try {
    schema = await inputSchemaOf(imp);
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: `could not load ${toolId}'s inputSchema: ${(err as Error).message}` }] };
  }

  let value = unwrapped;
  if (schema !== undefined && schema !== null) {
    try {
      const check = compileArgumentValidator(schema, { coerce: context.argumentCoercion }).check(unwrapped);
      if (!check.valid) return { ok: false, errors: check.errors };
      value = check.value;
    } catch (err) {
      if (!(err instanceof InputSchemaError)) throw err;
      return { ok: false, errors: [{ path: '', message: `${toolId} cannot be called: its ${err.message}` }] };
    }
  }

  const own = imp.constraints.validate(value);
  if (!own.valid) return { ok: false, errors: own.errors };

  try {
    canonicalJson(value);
  } catch (err) {
    return { ok: false, errors: [{ path: '', message: `arguments are not plain JSON: ${(err as Error).message}` }] };
  }
  let digest: string | null = null;
  try {
    digest = callDigest(toolId, value);
  } catch {
    digest = null; // an id that is not `<providerId>/<toolName>`; the call itself is fine
  }
  return { ok: true, args: value, callDigest: digest };
}

/** The result returned when arguments fail validation. Nothing ran. */
function invalidArgumentsResult(toolId: string, errors: ValidationError[], proof: ResolutionProof): ToolResult {
  return {
    content: {
      error: `Invalid arguments for ${toolId}; the tool was not called.`,
      errors: errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)),
    },
    isError: true,
    metadata: {
      outcome: 'invalid-arguments',
      toolId,
      validationErrors: errors,
      proof,
    },
  };
}

/** Record the validation result in the proof and finalize it. */
function recordCall(proof: ResolutionProof, toolId: string, prepared: PreparedCall | RejectedCall, started: number): void {
  if (prepared.ok) {
    proof.ran = toolId;
    proof.callDigest = prepared.callDigest;
    addProofStep(proof, { stage: 'validation', decision: `Arguments valid for ${toolId}; executing`, detail: { callDigest: prepared.callDigest } }, proofClock() - started);
  } else {
    addProofStep(proof, {
      stage: 'validation',
      decision: `Arguments rejected for ${toolId} (${prepared.errors.length} error(s)); nothing executed`,
      detail: { paths: prepared.errors.map(e => e.path) },
    }, proofClock() - started);
  }
  finalizeProof(proof);
}

/** Annotate a tool's result with what ran and why. */
function annotateExecuted(
  result: ToolResult,
  toolId: string,
  proof: ResolutionProof,
): ToolResult {
  result.metadata = {
    ...result.metadata,
    outcome: 'resolved',
    toolId,
    callDigest: proof.callDigest,
    confidence: proof.confidence,
    tier: proof.tier,
    proof,
  };
  return result;
}

/** The result of an intent that did not resolve to one tool. Nothing ran. */
function notExecutedResult(resolution: Resolution): ToolResult {
  const options = resolution.refinement?.options ?? [];
  return {
    content: {
      error: `${resolution.reason ?? `No tool was chosen for "${resolution.intent}"`}. Nothing was executed.`,
      outcome: resolution.outcome,
      intent: resolution.intent,
      candidates: resolution.candidates.slice(0, 5).map(c => ({ toolId: c.toolId, score: c.score, tier: c.tier })),
      ...(options.length > 0 ? { options: options.map(o => o.toolId ?? o.label) } : {}),
    },
    isError: true,
    ...(resolution.refinement ? { refinement: resolution.refinement } : {}),
    metadata: {
      outcome: resolution.outcome,
      tier: resolution.tier,
      proof: resolution.proof,
      ...(resolution.refinement ? { refinement: true, optionCount: options.length } : {}),
    },
  };
}

/** The proof of a dispatch by exact tool id (before execution). */
function exactIdProof(
  context: DispatchContext,
  toolId: string,
  tool: RegisteredTool,
  options: DispatchByIdOptions,
  started: number,
): ResolutionProof {
  const proof = context.newProof(null);
  const verdict = evaluateDispatchPolicy(
    { mode: 'id', toolId, imp: tool.imp, source: 'exact-id', score: 1, similarity: null, llmApproved: false, pins: [] },
    context.policyOptions,
  );
  proof.resolutionDigest = options.resolutionDigest ?? null;
  proof.outcome = 'resolved';
  proof.decision = 'exact-id';
  proof.tier = 'exact';
  proof.chosen = toolId;
  proof.confidence = 1;
  proof.candidates = [{ toolId, selector: tool.selectors[0], score: 1, similarity: null, tier: 'exact', source: 'exact-id' }];
  addProofStep(proof, { stage: 'exact_id', decision: verdict.reason, detail: { toolId } }, proofClock() - started);
  return proof;
}

/**
 * dispatchById — execute exactly the named tool. O(1) lookup, no
 * embedding, no resolution. Arguments are validated against the tool's
 * inputSchema first; invalid arguments, an unknown id or an ambiguous id
 * return an isError result and run nothing.
 */
export async function dispatchById(
  context: DispatchContext,
  toolId: string,
  args: Record<string, unknown> = {},
  options: DispatchByIdOptions = {},
): Promise<ToolResult> {
  const started = proofClock();
  const tool = context.getTool(toolId);

  if (!tool) {
    const proof = context.newProof(null);
    proof.resolutionDigest = options.resolutionDigest ?? null;
    const ambiguous = context.isAmbiguousToolId(toolId);
    proof.decision = 'unknown-tool';
    addProofStep(proof, { stage: 'exact_id', decision: ambiguous ? `${toolId} is claimed by more than one tool` : `${toolId} is not a registered tool` }, proofClock() - started);
    finalizeProof(proof);
    return {
      content: {
        error: ambiguous
          ? `Tool id "${toolId}" is claimed by more than one registered tool; nothing was executed.`
          : `Unknown tool "${toolId}"; nothing was executed. Tool ids have the form "<providerId>/<toolName>".`,
      },
      isError: true,
      metadata: { outcome: 'unresolved', toolId, proof },
    };
  }

  const proof = exactIdProof(context, toolId, tool, options, started);
  const callStarted = proofClock();
  const prepared = await prepareCall(context, tool.imp, toolId, args);
  recordCall(proof, toolId, prepared, callStarted);
  if (!prepared.ok) return invalidArgumentsResult(toolId, prepared.errors, proof);

  const result = await tool.imp.execute(prepared.args);
  return annotateExecuted(result, toolId, proof);
}

/**
 * toolkit_dispatch — the convenience path: resolve(intent) → policy →
 * execute exactly the chosen tool (through the same validation boundary
 * as dispatchById). When resolution does not settle on one tool, nothing
 * runs and the result is an isError result carrying the candidates.
 */
export async function toolkit_dispatch(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): Promise<ToolResult> {
  return dispatchIntent(context, intent, args, 0);
}

async function dispatchIntent(
  context: DispatchContext,
  intent: string,
  args: Record<string, unknown> | undefined,
  depth: number,
): Promise<ToolResult> {
  const r = await resolveInternal(context, intent, { learn: true, args, allowDecomposition: true, depth });
  const { resolution } = r;

  if (r.decomposition) {
    // Each sub-intent goes through this same pipeline (and policy), one level deeper.
    const result = await executeDecomposition(
      r.decomposition,
      (subIntent, subArgs) => dispatchIntent(context, subIntent, subArgs, depth + 1),
    );
    result.metadata = { ...result.metadata, outcome: 'resolved', tier: resolution.tier, proof: resolution.proof };
    return result;
  }

  if (resolution.outcome !== 'resolved' || !r.imp) {
    return notExecutedResult(resolution);
  }

  const toolId = resolution.chosen!;
  const proof = resolution.proof;
  const callStarted = proofClock();
  const prepared = await prepareCall(context, r.imp, toolId, args ?? {});
  recordCall(proof, toolId, prepared, callStarted);
  if (!prepared.ok) {
    context.observer.recordSchemaRejection(r.imp.toolName, intent, JSON.stringify(prepared.errors));
    return invalidArgumentsResult(toolId, prepared.errors, proof);
  }

  const result = annotateExecuted(await r.imp.execute(prepared.args), toolId, proof);

  // Record dispatch for observer (Pillar 5)
  context.observer.recordDispatch({
    intent,
    tool: r.imp.toolName,
    confidence: resolution.confidence ?? 0,
    timestamp: Date.now(),
    schemaRejected: result.isError === true && result.metadata?.validationErrors !== undefined,
  });

  // Annotate ambiguous results so callers know another tool was close
  if (resolution.candidates.length > 1 && (resolution.confidence ?? 0) <= 0.90) {
    result.metadata = {
      ...result.metadata,
      ambiguous: true,
      candidateCount: resolution.candidates.length,
      topCandidates: resolution.candidates.slice(0, 3).map(c => ({ toolId: c.toolId, confidence: c.score })),
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * smallchat_dispatchStream — async generator variant of toolkit_dispatch.
 *
 * Yields DispatchEvent objects for real-time UI feedback:
 *   1. "resolving" — immediately, so the caller knows work has started
 *   2. "tool-start" — once a tool is resolved, before execution
 *   3. "chunk" — incremental content from the tool (if it supports streaming)
 *   4. "done" — final result with the complete ToolResult
 *   5. "error" — if anything goes wrong at any stage
 */
export async function* smallchat_dispatchStream(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
): AsyncGenerator<DispatchEvent> {
  yield { type: 'resolving', intent };

  let r: InternalResolution;
  try {
    r = await resolveInternal(context, intent, { learn: true, args, allowDecomposition: true, depth: 0 });
  } catch (err) {
    yield streamError(err);
    return;
  }

  if (r.decomposition) {
    const result = await executeDecomposition(
      r.decomposition,
      (subIntent, subArgs) => dispatchIntent(context, subIntent, subArgs, 1),
    );
    result.metadata = { ...result.metadata, outcome: 'resolved', tier: r.resolution.tier, proof: r.resolution.proof };
    yield { type: 'done', result };
    return;
  }

  if (r.resolution.outcome !== 'resolved' || !r.imp) {
    yield { type: 'done', result: notExecutedResult(r.resolution) };
    return;
  }

  yield {
    type: 'tool-start',
    toolId: r.resolution.chosen!,
    toolName: r.imp.toolName,
    providerId: r.imp.providerId,
    confidence: r.resolution.confidence ?? 0,
    selector: r.resolution.candidates.find(c => c.toolId === r.resolution.chosen)?.selector ?? '',
  };

  yield* executeAndStream(context, r.imp, r.resolution.chosen!, args ?? {}, r.resolution.proof);
}

/**
 * Streaming variant of dispatchById: executes exactly the named tool.
 */
export async function* smallchat_dispatchStreamById(
  context: DispatchContext,
  toolId: string,
  args: Record<string, unknown> = {},
  options: DispatchByIdOptions = {},
): AsyncGenerator<DispatchEvent> {
  const tool = context.getTool(toolId);
  if (!tool) {
    yield { type: 'done', result: await dispatchById(context, toolId, args, options) };
    return;
  }

  const proof = exactIdProof(context, toolId, tool, options, proofClock());

  yield {
    type: 'tool-start',
    toolId,
    toolName: tool.imp.toolName,
    providerId: tool.imp.providerId,
    confidence: 1,
    selector: tool.selectors[0],
  };
  yield* executeAndStream(context, tool.imp, toolId, args, proof);
}

function streamError(err: unknown): DispatchEvent {
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
  return {
    type: 'error',
    error: err instanceof Error ? err.message : String(err),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
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
 * Validate, then execute a tool and stream its result at the finest
 * granularity the IMP supports:
 *
 *   1. executeInference  — token-level deltas (OpenAI / Anthropic SSE)
 *   2. executeStream     — chunk-level results
 *   3. execute           — single-shot fallback
 */
async function* executeAndStream(
  context: DispatchContext,
  imp: ToolIMP,
  toolId: string,
  args: Record<string, unknown>,
  proof: ResolutionProof,
): AsyncGenerator<DispatchEvent> {
  const callStarted = proofClock();
  const prepared = await prepareCall(context, imp, toolId, args);
  recordCall(proof, toolId, prepared, callStarted);
  if (!prepared.ok) {
    yield {
      type: 'error',
      error: `Invalid arguments for ${toolId}; the tool was not called: ${prepared.errors.map(e => e.message).join('; ')}`,
      metadata: { validationErrors: prepared.errors, toolId, proof },
    };
    return;
  }
  const callArgs = prepared.args;

  try {
    const inferenceImp = imp as InferenceIMP;

    // ---- Tier 1: Progressive inference (token-level) ----
    if (typeof inferenceImp.executeInference === 'function') {
      let tokenIndex = 0;
      const parts: string[] = [];

      for await (const delta of inferenceImp.executeInference(callArgs)) {
        yield { type: 'inference-delta', delta, tokenIndex };
        parts.push(delta.text);
        tokenIndex++;
      }

      // Synthesise a final ToolResult from the accumulated tokens
      const assembled = parts.join('');
      yield { type: 'chunk', content: assembled, index: 0 };
      yield { type: 'done', result: annotateExecuted({ content: assembled }, toolId, proof) };
      return;
    }

    // ---- Tier 2: Chunk-level streaming ----
    const streamable = imp as StreamableIMP;

    if (typeof streamable.executeStream === 'function') {
      let index = 0;
      let lastResult: ToolResult | undefined;

      for await (const chunk of streamable.executeStream(callArgs)) {
        yield { type: 'chunk', content: chunk.content, index };
        index++;
        lastResult = chunk;
      }

      yield { type: 'done', result: annotateExecuted(lastResult ?? { content: null }, toolId, proof) };
      return;
    }

    // ---- Tier 3: Single-shot fallback ----
    const result = await imp.execute(callArgs);
    yield { type: 'chunk', content: result.content, index: 0 };
    yield { type: 'done', result: annotateExecuted(result, toolId, proof) };
  } catch (err) {
    yield {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
