import type { Embedder, ExecuteOptions, ToolIMP, ToolProtocol, ToolResult, ToolSelector, VectorIndex, DispatchEvent, InferenceDelta, InferenceStream, ToolRefinementNeeded, ValidationError } from '../core/types.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable, intentKey, intentSelector } from '../core/selector-table.js';
import { SemanticRateLimiter, DEFAULT_PRINCIPAL } from '../core/semantic-rate-limiter.js';
import type { SemanticRateLimiterOptions } from '../core/semantic-rate-limiter.js';
import { ToolClass } from '../core/tool-class.js';
import { unwrapValue } from '../core/sc-object.js';
import { SelectorNamespace } from '../core/selector-namespace.js';
import { OverloadAmbiguityError, SignatureValidationError } from '../core/overload-table.js';
import { IntentPinRegistry } from '../core/intent-pin.js';
import { compareRanked, computeTier, DEFAULT_THRESHOLDS, quantizeScore } from '../core/confidence.js';
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
import type { DispatchFeedback, ObserverOptions } from './observer.js';
import { SemanticMap } from './semantic-map.js';
import type { SemanticMapOptions, LearnedPreference } from './semantic-map.js';
import { evaluateDispatchPolicy, isDestructive } from './policy.js';
import type { DispatchPolicyOptions, PinState, PolicyCode, PolicyVerdict } from './policy.js';
import type { DecisionExecution, DecisionKind, DecisionLog } from './decision-log.js';

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
  /**
   * Opt-in semantic rate limiting of novel intents, per principal (see
   * SemanticRateLimiter). Off when unset.
   */
  rateLimiter?: SemanticRateLimiterOptions;
  /**
   * How many levels deep LOW-tier decomposition may go: sub-intents of the
   * dispatched intent are depth 1, theirs depth 2, and so on. A dispatch at
   * this depth is never decomposed further. Default 2.
   */
  maxDecompositionDepth?: number;
  /**
   * Cap on sub-intents dispatched (at any depth) for one top-level
   * dispatch; the rest are reported as not dispatched. Default 16.
   */
  maxSubDispatches?: number;
  /**
   * Append-only decision log: one hash-chained line per resolve(),
   * dispatch and dispatch by id, written before anything executes (see
   * runtime/decision-log.ts). Off when unset.
   */
  decisionLog?: DecisionLog;
}

/**
 * `metadata.outcome` of a dispatch result: a ResolutionOutcome, or
 * - 'invalid-arguments': the arguments failed the tool's inputSchema;
 * - 'aborted': the caller's signal fired before the tool started;
 * - 'not-dispatched': a decomposition sub-intent past the sub-dispatch limit
 *   (inside a decomposed result's content).
 * Only 'resolved' means a tool ran; its own failure is `isError: true` with
 * outcome 'resolved'. Every other outcome ran nothing and is `isError: true`.
 */
export type DispatchOutcome = ResolutionOutcome | 'invalid-arguments' | 'aborted' | 'not-dispatched';

/** Per-dispatch options. */
export interface DispatchOptions {
  /**
   * Who the dispatch is for (an MCP session, user or API key). Scopes the
   * semantic rate limiter and principal-scoped feedback. Default: the
   * shared DEFAULT_PRINCIPAL.
   */
  principal?: string;
  /**
   * Aborts the dispatch: nothing executes once it has fired, and the
   * running tool receives it (ToolIMP.execute options.signal).
   */
  signal?: AbortSignal;
}

/** Default decomposition depth bound (DispatchConfig.maxDecompositionDepth). */
export const DEFAULT_MAX_DECOMPOSITION_DEPTH = 2;
/** Default cap on sub-dispatches per request (DispatchConfig.maxSubDispatches). */
export const DEFAULT_MAX_SUB_DISPATCHES = 16;

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
  /** Opt-in semantic rate limiter (null when RuntimeOptions.rateLimiter is unset) */
  readonly rateLimiter: SemanticRateLimiter | null;
  readonly maxDecompositionDepth: number;
  readonly maxSubDispatches: number;
  /** Decision log every decision is appended to (null when off) */
  readonly decisionLog: DecisionLog | null;

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
    this.rateLimiter = dispatchConfig?.rateLimiter ? new SemanticRateLimiter(dispatchConfig.rateLimiter) : null;
    this.maxDecompositionDepth = dispatchConfig?.maxDecompositionDepth ?? DEFAULT_MAX_DECOMPOSITION_DEPTH;
    this.maxSubDispatches = dispatchConfig?.maxSubDispatches ?? DEFAULT_MAX_SUB_DISPATCHES;
    this.decisionLog = dispatchConfig?.decisionLog ?? null;
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
   * Register a provider (ToolClass). A class with the same name replaces
   * the one registered before (hot reload): its selectors and tool ids are
   * re-indexed from scratch, so nothing of the old class stays reachable.
   * Cached resolutions are flushed either way — a new tool may now be the
   * better match for an intent cached before it existed.
   *
   * Throws SelectorShadowingError if the class contains selectors that
   * would shadow protected core selectors.
   */
  registerClass(toolClass: ToolClass): void {
    // Guard: check all selectors in this class against the namespace
    const ownSelectors = Array.from(toolClass.dispatchTable.keys());
    this.selectorNamespace.assertNoShadowing(toolClass.name, ownSelectors);

    const replaces = this.toolClasses.has(toolClass.name);
    this.toolClasses.set(toolClass.name, toolClass);
    if (replaces) this.reindex();
    else this.indexClass(toolClass);
    this.cache.flush();
  }

  /**
   * Remove a provider by name: its tools leave the dispatch index and
   * every cached resolution is flushed. Returns false when no class has
   * that name.
   */
  unregisterClass(name: string): boolean {
    if (!this.toolClasses.delete(name)) return false;
    this.reindex();
    this.cache.flush();
    return true;
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

  /** Whether `selectorId` dispatches to the tool `toolId` (as default, overload or in any class). */
  selectorReachesTool(selectorId: string, toolId: string): boolean {
    return this.getTool(toolId)?.selectors.includes(selectorId) ?? false;
  }

  /**
   * Resolve a learned preference to a concrete IMP + selector. With
   * `toolId`, that exact tool, provided the selector still dispatches to it;
   * without, the selector's default tool (its first owning class). Returns
   * null if the selector or tool has since been unregistered (a stale
   * learned preference).
   */
  resolveLearnedSelector(selectorId: string, toolId?: string): { imp: ToolIMP; selector: ToolSelector } | null {
    if (toolId !== undefined) {
      const selector = this.selectorTable.get(selectorId);
      const tool = this.getTool(toolId);
      return selector && tool && tool.selectors.includes(selectorId) ? { imp: tool.imp, selector } : null;
    }
    const found = this.toolForSelector(selectorId);
    return found ? { imp: found.imp, selector: found.selector } : null;
  }

  /**
   * Reinforce a learned dispatch preference (Pillar 4b).
   *
   * Called when the user resolves a refinement by choosing one of the deferred
   * options. Embeds the original (unresolvable) intent and records a mapping to
   * the chosen selector — and, with `toolId`, the tool chosen through it (an
   * overload variant, or one of several classes declaring the selector) — so
   * that the exact intent resolves to that tool instantly next time, and
   * *similar* intents get a confidence boost toward it. Throws when `toolId`
   * is given and the selector does not dispatch to it. Learned preferences
   * never authorize a pinned or destructive tool: the dispatch policy
   * requires an exact phrase or EXACT similarity for those.
   */
  async reinforceRefinement(originalIntent: string, selectorId: string, toolId?: string): Promise<LearnedPreference> {
    if (toolId !== undefined && !this.selectorReachesTool(selectorId, toolId)) {
      throw new Error(`Selector "${selectorId}" does not dispatch to tool "${toolId}"`);
    }
    const vector = await this.embedder.embed(originalIntent);
    const preference = this.semanticMap.reinforce(originalIntent, vector, selectorId, Date.now(), toolId);
    // A learned boost can change how nearby intents rank.
    this.cache.flush();
    return preference;
  }

  /**
   * Explicit feedback about an intent → tool decision (see
   * DispatchObserver.feedback). `correct: false` keeps resolution from
   * choosing that tool for that intent (for `principal` only, when given);
   * `correct: true` clears it. Cached resolutions are flushed.
   */
  feedback(input: DispatchFeedback): void {
    this.observer.feedback(input);
    this.cache.flush();
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
   * The pinned canonicals that apply to a tool: every pinned selector the
   * tool is reachable through — its own selectors, the overload tables it
   * is a variant in (whichever class declares them), and `via`, the
   * selector a candidate matched through.
   */
  private pinnedCanonicalsOf(toolId: string, via?: string): string[] {
    if (this.intentPins.size === 0) return [];
    const reachable = new Set(this.toolsById.get(toolId)?.selectors ?? []);
    if (via !== undefined) reachable.add(via);
    return this.intentPins.pinnedCanonicals().filter(c => reachable.has(c));
  }

  /**
   * How the intent pins apply to one tool for one intent (see
   * pinnedCanonicalsOf; `via` is the selector the candidate matched
   * through). `ownSimilarity` computes the cosine similarity between the
   * intent's own embedding and a selector (for 'elevated' pins).
   */
  async pinStatesFor(
    toolId: string,
    intent: string,
    ownSimilarity: (selector: ToolSelector) => Promise<number>,
    via?: string,
  ): Promise<PinState[]> {
    const states: PinState[] = [];
    for (const canonical of this.pinnedCanonicalsOf(toolId, via)) {
      const pin = this.intentPins.getPin(canonical)!;
      const phrase = this.intentPins.matchesPinnedPhrase(canonical, intent);
      if (pin.policy === 'exact') {
        states.push({ canonical, policy: 'exact', satisfied: phrase });
        continue;
      }
      const pinnedSelector = this.selectorTable.get(canonical);
      const similarity = phrase ? null : pinnedSelector ? await ownSimilarity(pinnedSelector) : null;
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

  /** Whether any intent pin applies to this tool (see pinnedCanonicalsOf). */
  isPinnedTool(toolId: string, via?: string): boolean {
    return this.pinnedCanonicalsOf(toolId, via).length > 0;
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

  /**
   * Append a decision to the decision log, if one is configured. Throws
   * DecisionLogError when the line cannot be written — callers record
   * before executing, so nothing runs unrecorded.
   */
  logDecision(kind: DecisionKind, proof: ResolutionProof, execution: DecisionExecution, principal?: string, toolId?: string): void {
    this.decisionLog?.record({ kind, proof, execution, ...(principal !== undefined ? { principal } : {}), ...(toolId !== undefined ? { toolId } : {}) });
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
   * Record what resolution learns: cache a HIGH/EXACT result under this
   * intent's identity key (intentKey), and consult that cache. Default
   * false for `runtime.resolve()`, which then changes nothing in the
   * runtime beyond the (opt-in) rate limiter's window; `dispatch()`
   * resolves with learning on. Intents are never interned either way.
   */
  learn?: boolean;
  /**
   * The arguments the call will carry, when known. Used to choose among
   * overloads and by verification's required-parameter check.
   */
  args?: Record<string, unknown>;
  /** Who is asking — scopes the rate limiter and feedback (DispatchOptions.principal) */
  principal?: string;
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
  /** Why the runtime would not pick a tool on its own (needs-disambiguation / unresolved / throttled) */
  reason?: string;
  /** Options to present to the user; each carries a toolId for dispatchById */
  refinement?: ToolRefinementNeeded;
  /** outcome 'throttled': milliseconds until this principal may try again */
  retryAfterMs?: number;
}

interface Candidate {
  imp: ToolIMP;
  toolId: string;
  /** The tool selector the candidate matched through */
  selector: ToolSelector;
  /** Quantized score (quantizeScore) */
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
  principal?: string;
  /** Dispatch (not resolve) may decompose LOW-tier / unmatched intents */
  allowDecomposition: boolean;
  /** Decomposition depth of this dispatch (sub-intents are depth + 1) */
  depth: number;
  /** intentKeys of the intents this one was decomposed from */
  ancestors: readonly string[];
}

/** Nearest tools offered as refinement options start at this similarity. */
const REFINEMENT_FLOOR = 0.3;

/** How many vector matches resolution considers. */
const SEARCH_TOP_K = 5;

/**
 * Convert a vector distance into a confidence score: 1 − distance,
 * clamped to [0, 1] and quantized (quantizeScore), so that backends that
 * differ in the last bits of a distance produce the same score.
 */
function toConfidence(distance: number): number {
  return quantizeScore(1 - distance);
}

/** The decision code recorded when the policy refuses a candidate. */
function denial(verdict: PolicyVerdict): DecisionCode {
  return verdict.code as Exclude<PolicyCode, 'allow'>;
}

/** Candidates ranked by quantized score, ties broken by canonical tool id. */
function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort(compareRanked);
}

/**
 * Resolve an intent to at most one tool. Never executes anything.
 *
 * Order: pinned phrase → learned exact intent → cache → (rate limit) →
 * ranked candidates (vector and overload matches, learned similar-intent
 * boosts, protocol conformance). Every candidate passes the pin gate; the
 * chosen one passes verification (below HIGH, or in strict mode) and the
 * dispatch policy (runtime/policy.ts). Anything the policy refuses is
 * needs-disambiguation.
 *
 * Determinism: for the same artifact, embedder and runtime state
 * (registered classes, pins, semantic map, negative examples, cache), the
 * same intent text yields the same outcome, candidates and proofDigest.
 * Scores are quantized to 1e-4 and ties ordered by canonical tool id;
 * other intents the process has seen do not enter into it. An LLM
 * verifier's answers are an input like any other.
 */
export async function resolveIntent(
  context: DispatchContext,
  intent: string,
  options: ResolveOptions = {},
): Promise<Resolution> {
  const r = await resolveInternal(context, intent, {
    learn: options.learn ?? false,
    args: options.args,
    principal: options.principal,
    allowDecomposition: false,
    depth: 0,
    ancestors: [],
  });
  context.logDecision('resolve', r.resolution.proof, 'none', options.principal);
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
  const key = intentKey(intent);
  let clock = proofClock();

  const step = (stage: ProofStage, decision: string, detail?: Record<string, unknown>): void => {
    const now = proofClock();
    addProofStep(proof, detail === undefined ? { stage, decision } : { stage, decision, detail }, now - clock);
    clock = now;
  };

  const isNegative = (toolId: string): boolean => context.observer.isNegativeExample(intent, toolId, run.principal);

  // The intent's own embedding, computed at most once. Similarities that
  // authorize pinned or destructive tools are always measured from it.
  let ownVector: Float32Array | null = null;
  const embedOwn = async (): Promise<Float32Array> => (ownVector ??= await context.embedder.embed(intent));
  const ownSimilarity = async (selector: ToolSelector): Promise<number> =>
    quantizeScore(cosineSimilarity(await embedOwn(), selector.vector));

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
    const via = c.selector.canonical;
    if (similarity !== null && (isDestructive(c.imp.annotations, context.policyOptions) || context.isPinnedTool(c.toolId, via))) {
      // Always measured from this intent's own text.
      similarity = await ownSimilarity(c.selector);
    }
    const pins = await context.pinStatesFor(c.toolId, intent, ownSimilarity, via);
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
    extra: { reason?: string; refinement?: ToolRefinementNeeded; imp?: ToolIMP | null; decomposition?: DecompositionResult | null; retryAfterMs?: number } = {},
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
      ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
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

  /**
   * Ask the LLM to split the intent, keeping only sub-intents that differ
   * from it and from every intent it was itself split from (a model that
   * answers with the intent itself would otherwise recurse).
   */
  const tryDecompose = async (): Promise<DecompositionResult | null> => {
    if (!run.allowDecomposition || !llm.decompose || run.depth >= context.maxDecompositionDepth) return null;
    const d = await decompose(intent, context.getToolSummaries(), llm, { currentDepth: run.depth, maxDepth: context.maxDecompositionDepth });
    const seen = new Set([key, ...run.ancestors]);
    const proposed = d.subIntents.length;
    d.subIntents = d.subIntents.filter(sub => typeof sub.intent === 'string' && !seen.has(intentKey(sub.intent)));
    d.decomposed = d.decomposed && d.subIntents.length > 0;
    step('decomposition', d.decomposed
      ? `Decomposed into ${d.subIntents.length} sub-intent(s) (${d.strategy})`
      : proposed > 0
        ? `Decomposition only restated the intent (${proposed} sub-intent(s) refused)`
        : 'Decomposition produced no sub-intents', { depth: run.depth, proposed, kept: d.subIntents.length });
    return d.decomposed ? d : null;
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

  // 2. LEARNED EXACT — the user taught this exact intent (same intentKey) before.
  if (context.semanticMap.size > 0) {
    const learned = context.semanticMap.lookupExact(intent);
    const resolved = learned ? context.resolveLearnedSelector(learned.selectorId, learned.toolId) : null;
    if (learned && resolved && !isNegative(toolIdOf(resolved.imp))) {
      const c: Candidate = {
        imp: resolved.imp,
        toolId: toolIdOf(resolved.imp),
        selector: resolved.selector,
        score: quantizeScore(context.semanticMap.exactConfidence),
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

  // 3. CACHE — a previous HIGH/EXACT resolution of this exact intent text
  // (no-arg calls only: with arguments, overload choice depends on them).
  if (run.learn && !hasArgs) {
    const cached = context.cache.lookup(key);
    if (cached && !isNegative(toolIdOf(cached.imp))) {
      const id = toolIdOf(cached.imp);
      const toolSelector = context.getTool(id)?.selectors[0];
      const c: Candidate = {
        imp: cached.imp,
        toolId: id,
        selector: (toolSelector && context.selectorTable.get(toolSelector)) || cached.selector,
        score: quantizeScore(cached.confidence),
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

  // 4. RATE LIMIT (opt-in) — a novel intent from this principal is about to be embedded.
  const principal = run.principal ?? DEFAULT_PRINCIPAL;
  if (context.rateLimiter && ownVector === null) {
    const verdict = context.rateLimiter.evaluate(key, principal);
    if (!verdict.allowed) {
      step('rate_limit', `Rate limit (${verdict.reason}) reached for this principal; the intent was not embedded`, { reason: verdict.reason });
      return finish('throttled', 'rate-limited', [], null, {
        reason: `Too many novel intents (${verdict.reason}); retry in ${Math.ceil(verdict.retryAfterMs / 1000)}s`,
        retryAfterMs: verdict.retryAfterMs,
      });
    }
  }

  // 5. EMBED the intent — its own vector, never interned.
  const selector = intentSelector(intent, await embedOwn());
  context.rateLimiter?.record(key, selector.vector, principal);

  // 6. VECTOR SEARCH — every match (and overload) becomes a ranked candidate.
  // One search serves both the candidates (>= floor) and, when there are
  // none, the refinement options (>= REFINEMENT_FLOOR).
  const floor = context.strict ? context.thresholds.medium : context.thresholds.low;
  const nearest = await context.selectorTable.searchTools(selector.vector, SEARCH_TOP_K, Math.min(floor, REFINEMENT_FLOOR));
  const matches = nearest.filter(m => toConfidence(m.distance) >= floor);
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
          if (err instanceof OverloadAmbiguityError) {
            step('overload', `Overloads of ${match.id} are ambiguous for these arguments`, { selector: match.id });
            continue;
          }
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
      if (isNegative(c.toolId)) {
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

  // 7. LEARNED SIMILAR — a near-miss the user previously disambiguated gets a boost.
  if (context.semanticMap.size > 0) {
    const smMatch = context.semanticMap.lookupSimilar(selector.vector);
    const resolved = smMatch ? context.resolveLearnedSelector(smMatch.preference.selectorId, smMatch.preference.toolId) : null;
    if (smMatch && resolved && !isNegative(toolIdOf(resolved.imp))) {
      const id = toolIdOf(resolved.imp);
      const existing = byTool.get(id);
      const base = existing ? existing.score : smMatch.similarity;
      const boosted = quantizeScore(Math.min(context.semanticMap.boostCeiling, base + smMatch.boost));
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
        boost: quantizeScore(smMatch.boost),
      });
    }
  }

  // 8. PROTOCOL CONFORMANCE — only when nothing matched by vector.
  if (byTool.size === 0) {
    const protocolMatch = context.resolveViaProtocol(selector);
    if (protocolMatch) {
      const c: Candidate = {
        imp: protocolMatch.imp,
        toolId: toolIdOf(protocolMatch.imp),
        selector: protocolMatch.selector,
        score: quantizeScore(protocolMatch.confidence),
        similarity: null,
        source: 'protocol',
      };
      offer(c);
      step('protocol', `Protocol conformance → ${c.toolId} at ${c.score.toFixed(3)}`, { selector: protocolMatch.selector.canonical });
    }
  }

  // 9. PIN GATE — a pinned tool is never a candidate for an intent its pin refuses.
  const eligible: Candidate[] = [];
  for (const c of byTool.values()) {
    const via = c.selector.canonical;
    if (!context.isPinnedTool(c.toolId, via)) {
      eligible.push(c);
      continue;
    }
    const pins = await context.pinStatesFor(c.toolId, intent, ownSimilarity, via);
    const refused = pins.find(p => !p.satisfied);
    if (refused) {
      excluded.push(toProofCandidate(c, refused.policy === 'exact' ? 'pin-exact-required' : 'pin-elevated-required'));
      step('intent_pin', `${c.toolId} excluded: pinned '${refused.policy}' (${refused.canonical}) and this intent does not satisfy it`, { toolId: c.toolId, pin: refused.canonical });
    } else {
      eligible.push(c);
    }
  }

  const ranked = rank(eligible);

  // 10. NOTHING MATCHED — unresolved (refinement options, or decomposition when dispatching).
  if (ranked.length === 0) {
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

    const d = await tryDecompose();
    if (d) return finish('resolved', 'decomposed', ranked, null, { decomposition: d });

    step('refinement', `No candidate above ${floor} and no refinement options`);
    return finish('unresolved', 'no-candidates', ranked, null, { reason: `No tool matched "${intent}"` });
  }

  const best = ranked[0];
  const bestTier = computeTier(best.score, context.thresholds);
  const subHigh = (t: ConfidenceTier) => t === 'medium' || t === 'low';

  // 11. LOW-tier decomposition (dispatch only): a compound intent may need several tools.
  if (bestTier === 'low') {
    const d = await tryDecompose();
    if (d) return finish('resolved', 'decomposed', ranked, null, { decomposition: d });
  }

  // 12. VERIFICATION — below HIGH, or below EXACT in strict mode. The best
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

  // 13. POLICY — the same rule set as every other path.
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
  if (run.learn && chosen.source === 'vector' && !context.isPinnedTool(chosen.toolId, chosen.selector.canonical)
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
  /**
   * Aborts the call: nothing executes once it has fired, and the running
   * tool receives it (ToolIMP.execute options.signal).
   */
  signal?: AbortSignal;
  /** Who the call is for; recorded in the decision log */
  principal?: string;
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

/**
 * The result of a call whose AbortSignal fired before the tool started.
 * Nothing ran.
 */
function abortedResult(toolId: string, proof: ResolutionProof, signal: AbortSignal): ToolResult {
  proof.ran = null;
  addProofStep(proof, { stage: 'execution', decision: `The caller aborted before ${toolId} started; nothing executed` }, 0);
  finalizeProof(proof);
  const why = signal.reason instanceof Error ? signal.reason.message : 'aborted';
  return {
    content: { error: `Dispatch of ${toolId} was aborted (${why}); nothing was executed.` },
    isError: true,
    metadata: { outcome: 'aborted', toolId, proof },
  };
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
      ...(resolution.retryAfterMs !== undefined ? { retryAfterMs: resolution.retryAfterMs } : {}),
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
    context.logDecision('dispatch-by-id', proof, 'none', options.principal, toolId);
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
  if (options.signal?.aborted) {
    const aborted = abortedResult(toolId, proof, options.signal);
    context.logDecision('dispatch-by-id', proof, 'aborted', options.principal);
    return aborted;
  }
  const callStarted = proofClock();
  const prepared = await prepareCall(context, tool.imp, toolId, args);
  recordCall(proof, toolId, prepared, callStarted);
  if (!prepared.ok) {
    context.logDecision('dispatch-by-id', proof, 'invalid-arguments', options.principal);
    return invalidArgumentsResult(toolId, prepared.errors, proof);
  }

  context.logDecision('dispatch-by-id', proof, 'ran', options.principal);
  const result = await execute(tool.imp, prepared.args, options.signal);
  return annotateExecuted(result, toolId, proof);
}

/** Run an IMP, passing ExecuteOptions only when there is a signal to carry. */
function execute(imp: ToolIMP, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ToolResult> {
  return signal ? imp.execute(args, { signal }) : imp.execute(args);
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
  options: DispatchOptions = {},
): Promise<ToolResult> {
  return dispatchIntent(context, intent, args, rootFrame(options));
}

/**
 * Per-request dispatch state. Each top-level dispatch gets its own frame,
 * so concurrent dispatches never see each other's depth or budget.
 */
interface DispatchFrame {
  depth: number;
  /** intentKeys of the intents this one was decomposed from */
  ancestors: readonly string[];
  /** Sub-dispatches left for the whole request (shared by the tree) */
  budget: { remaining: number; limit: number };
  principal?: string;
  signal?: AbortSignal;
}

function rootFrame(options: DispatchOptions, budget?: number): DispatchFrame {
  return {
    depth: 0,
    ancestors: [],
    budget: { remaining: budget ?? Infinity, limit: budget ?? Infinity },
    principal: options.principal,
    signal: options.signal,
  };
}

/** Run a decomposition's sub-intents, one level deeper, within the request's budget. */
function runDecomposition(
  context: DispatchContext,
  intent: string,
  decomposition: DecompositionResult,
  frame: DispatchFrame,
): Promise<ToolResult> {
  if (frame.budget.limit === Infinity) {
    frame.budget.remaining = frame.budget.limit = context.maxSubDispatches;
  }
  const child: DispatchFrame = {
    ...frame,
    depth: frame.depth + 1,
    ancestors: [...frame.ancestors, intentKey(intent)],
  };
  return executeDecomposition(decomposition, async (subIntent, subArgs) => {
    if (frame.budget.remaining <= 0) {
      return {
        content: { error: `Not dispatched: the sub-dispatch limit (${frame.budget.limit}) for this request was reached.` },
        isError: true,
        metadata: { outcome: 'not-dispatched' },
      };
    }
    frame.budget.remaining--;
    return dispatchIntent(context, subIntent, subArgs, child);
  });
}

async function dispatchIntent(
  context: DispatchContext,
  intent: string,
  args: Record<string, unknown> | undefined,
  frame: DispatchFrame,
): Promise<ToolResult> {
  const r = await resolveInternal(context, intent, {
    learn: true,
    args,
    principal: frame.principal,
    allowDecomposition: true,
    depth: frame.depth,
    ancestors: frame.ancestors,
  });
  const { resolution } = r;

  if (r.decomposition) {
    // Each sub-intent goes through this same pipeline (and policy), one level deeper.
    context.logDecision('dispatch', resolution.proof, 'decomposed', frame.principal);
    const result = await runDecomposition(context, intent, r.decomposition, frame);
    result.metadata = { ...result.metadata, outcome: 'resolved', tier: resolution.tier, proof: resolution.proof };
    return result;
  }

  if (resolution.outcome !== 'resolved' || !r.imp) {
    context.logDecision('dispatch', resolution.proof, 'none', frame.principal);
    return notExecutedResult(resolution);
  }

  const toolId = resolution.chosen!;
  const proof = resolution.proof;
  if (frame.signal?.aborted) {
    const aborted = abortedResult(toolId, proof, frame.signal);
    context.logDecision('dispatch', proof, 'aborted', frame.principal);
    return aborted;
  }
  const callStarted = proofClock();
  const prepared = await prepareCall(context, r.imp, toolId, args ?? {});
  recordCall(proof, toolId, prepared, callStarted);
  if (!prepared.ok) {
    context.logDecision('dispatch', proof, 'invalid-arguments', frame.principal);
    context.observer.recordSchemaRejection(toolId, intent, JSON.stringify(prepared.errors));
    return invalidArgumentsResult(toolId, prepared.errors, proof);
  }

  context.logDecision('dispatch', proof, 'ran', frame.principal);
  const result = annotateExecuted(await execute(r.imp, prepared.args, frame.signal), toolId, proof);

  // Record dispatch for observer (Pillar 5)
  context.observer.recordDispatch({
    intent,
    tool: toolId,
    confidence: resolution.confidence ?? 0,
    timestamp: Date.now(),
    schemaRejected: result.isError === true && result.metadata?.validationErrors !== undefined,
    ...(frame.principal !== undefined ? { principal: frame.principal } : {}),
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
 *
 * Closing the generator early (a `break` in for-await) aborts the signal
 * the running tool received.
 */
export async function* smallchat_dispatchStream(
  context: DispatchContext,
  intent: string,
  args?: Record<string, unknown>,
  options: DispatchOptions = {},
): AsyncGenerator<DispatchEvent> {
  yield { type: 'resolving', intent };

  const frame = rootFrame(options);
  let r: InternalResolution;
  try {
    r = await resolveInternal(context, intent, {
      learn: true,
      args,
      principal: frame.principal,
      allowDecomposition: true,
      depth: 0,
      ancestors: [],
    });
  } catch (err) {
    yield streamError(err);
    return;
  }

  if (r.decomposition) {
    context.logDecision('dispatch', r.resolution.proof, 'decomposed', frame.principal);
    const result = await runDecomposition(context, intent, r.decomposition, frame);
    result.metadata = { ...result.metadata, outcome: 'resolved', tier: r.resolution.tier, proof: r.resolution.proof };
    yield { type: 'done', result };
    return;
  }

  if (r.resolution.outcome !== 'resolved' || !r.imp) {
    context.logDecision('dispatch', r.resolution.proof, 'none', frame.principal);
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

  yield* executeAndStream(context, r.imp, r.resolution.chosen!, args ?? {}, r.resolution.proof, options.signal,
    execution => context.logDecision('dispatch', r.resolution.proof, execution, options.principal));
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
  yield* executeAndStream(context, tool.imp, toolId, args, proof, options.signal,
    execution => context.logDecision('dispatch-by-id', proof, execution, options.principal));
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
  executeStream?: (args: Record<string, unknown>, options?: ExecuteOptions) => AsyncIterable<ToolResult>;
}

/**
 * InferenceIMP — IMP with optional token-level progressive inference.
 *
 * This is the bridge for provider-native streaming: the IMP opens an
 * OpenAI or Anthropic SSE connection and yields individual deltas. See
 * InferenceStream (core/types.ts) for the contract: no deltas and no
 * returned result means nothing executed. An IMP that also defines
 * supportsInference() is asked first (ToolProxy answers for its transport).
 */
interface InferenceIMP extends StreamableIMP {
  executeInference?: (args: Record<string, unknown>, options?: ExecuteOptions) => InferenceStream | AsyncIterable<InferenceDelta>;
  supportsInference?: () => boolean;
}

/**
 * Validate, then execute a tool and stream its result at the finest
 * granularity the IMP supports:
 *
 *   1. executeInference  — token-level deltas (OpenAI / Anthropic SSE),
 *                          when the IMP supports it for this call
 *   2. executeStream     — chunk-level results
 *   3. execute           — single-shot
 *
 * An inference stream that yields no deltas falls through to its returned
 * result, or else to tiers 2–3. The tool receives an AbortSignal that
 * fires when `signal` does or when the consumer closes the stream early.
 */
async function* executeAndStream(
  context: DispatchContext,
  imp: ToolIMP,
  toolId: string,
  args: Record<string, unknown>,
  proof: ResolutionProof,
  signal: AbortSignal | undefined,
  logDecision: (execution: DecisionExecution) => void,
): AsyncGenerator<DispatchEvent> {
  if (signal?.aborted) {
    const aborted = abortedResult(toolId, proof, signal);
    logDecision('aborted');
    yield { type: 'done', result: aborted };
    return;
  }
  const callStarted = proofClock();
  const prepared = await prepareCall(context, imp, toolId, args);
  recordCall(proof, toolId, prepared, callStarted);
  if (!prepared.ok) {
    logDecision('invalid-arguments');
    yield {
      type: 'error',
      error: `Invalid arguments for ${toolId}; the tool was not called: ${prepared.errors.map(e => e.message).join('; ')}`,
      metadata: { validationErrors: prepared.errors, toolId, proof },
    };
    return;
  }
  const callArgs = prepared.args;
  logDecision('ran');

  // The tool's signal: the caller's, plus our own for early close.
  const controller = new AbortController();
  const forward = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', forward, { once: true });
  const options: ExecuteOptions = { signal: controller.signal };
  let finished = false;

  try {
    const inferenceImp = imp as InferenceIMP;

    // ---- Tier 1: Progressive inference (token-level) ----
    const inferenceSupported = typeof inferenceImp.executeInference === 'function'
      && (typeof inferenceImp.supportsInference !== 'function' || inferenceImp.supportsInference());
    if (inferenceSupported) {
      let tokenIndex = 0;
      const parts: string[] = [];
      const stream = inferenceImp.executeInference!(callArgs, options);
      const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<InferenceDelta, ToolResult | void>;
      let returned: ToolResult | void = undefined;
      let exhausted = false;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) { exhausted = true; returned = next.value; break; }
          yield { type: 'inference-delta', delta: next.value, tokenIndex };
          parts.push(next.value.text);
          tokenIndex++;
        }
      } finally {
        if (!exhausted) await iterator.return?.();
      }

      if (tokenIndex > 0) {
        // Synthesise a final ToolResult from the accumulated tokens
        const assembled = parts.join('');
        yield { type: 'chunk', content: assembled, index: 0 };
        finished = true;
        yield { type: 'done', result: annotateExecuted({ content: assembled }, toolId, proof) };
        return;
      }
      if (returned && typeof returned === 'object') {
        // The upstream answered without streaming: that is the result.
        yield { type: 'chunk', content: returned.content, index: 0 };
        finished = true;
        yield { type: 'done', result: annotateExecuted(returned, toolId, proof) };
        return;
      }
      // No deltas and no result: nothing executed — fall through.
    }

    // ---- Tier 2: Chunk-level streaming ----
    const streamable = imp as StreamableIMP;

    if (typeof streamable.executeStream === 'function') {
      let index = 0;
      let lastResult: ToolResult | undefined;

      for await (const chunk of streamable.executeStream(callArgs, options)) {
        yield { type: 'chunk', content: chunk.content, index };
        index++;
        lastResult = chunk;
      }

      finished = true;
      yield { type: 'done', result: annotateExecuted(lastResult ?? { content: null }, toolId, proof) };
      return;
    }

    // ---- Tier 3: Single-shot ----
    const result = await imp.execute(callArgs, options);
    yield { type: 'chunk', content: result.content, index: 0 };
    finished = true;
    yield { type: 'done', result: annotateExecuted(result, toolId, proof) };
  } catch (err) {
    finished = true;
    yield {
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    signal?.removeEventListener('abort', forward);
    // Closed before the result was delivered: tell the tool to stop.
    if (!finished) controller.abort(new Error('dispatch stream closed'));
  }
}
