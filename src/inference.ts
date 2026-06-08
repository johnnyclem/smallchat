// smallchat — Tool Inference Engine
//
// This is the durable core of smallchat: resolving a natural-language intent
// to the correct tool — semantically, deterministically, with a proof and a
// self-healing fallback chain. It is the part of the system whose value does
// NOT depend on the price of tokens. Even in a future where token costs are
// nominal, deterministic microsecond tool selection — with auditable
// resolution proofs and governance — is what an agent needs.
//
// Token compaction, output compression (RTK), knowledge pre-compilation
// (memex), CRDT memory, and importance scoring are *optimization satellites*
// that orbit this core. They address today's token economics. They are
// exported from the package root (`@smallchat/core`) but deliberately NOT
// from this entry point, which is the engine and nothing else.
//
// Import the engine alone:   import { ToolRuntime } from '@smallchat/core/inference';

// --- Parameter system: typed message arguments (NSObject-inspired) ---
export {
  SCObject,
  SCSelector,
  SCData,
  SCToolReference,
  SCArray,
  SCDictionary,
  wrapValue,
  unwrapValue,
  registerClass,
  getClassHierarchy,
  isSubclass,
} from './core/sc-object.js';
export {
  SCType,
  createSignature,
  param,
  matchType,
  scoreSignatureMatch,
  inferType,
  buildSignatureKey,
} from './core/sc-types.js';
export type {
  SCTypeDescriptor,
  SCPrimitiveType,
  SCParameterSlot,
  SCMethodSignature,
  MatchQuality,
} from './core/sc-types.js';

// --- Selectors, classes, overloads: the dispatch substrate ---
export { SelectorTable, canonicalize, VectorFloodError } from './core/selector-table.js';
export { SelectorNamespace, SelectorShadowingError } from './core/selector-namespace.js';
export type { CoreSelectorEntry } from './core/selector-namespace.js';
export { ResolutionCache, computeSchemaFingerprint } from './core/resolution-cache.js';
export { SemanticRateLimiter } from './core/semantic-rate-limiter.js';
export type { SemanticRateLimiterOptions, FloodingMetrics } from './core/semantic-rate-limiter.js';
export { ToolClass, ToolProxy } from './core/tool-class.js';
export { OverloadTable, OverloadAmbiguityError } from './core/overload-table.js';
export type { OverloadEntry, OverloadResolutionResult } from './core/overload-table.js';

// --- The runtime: dispatch, streaming, the fluent builder ---
export { DispatchContext, UnrecognizedIntent, toolkit_dispatch, smallchat_dispatchStream } from './runtime/dispatch.js';
export type { FallbackStep, FallbackChainResult, DispatchConfig } from './runtime/dispatch.js';
export { ToolRuntime } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';
export { DispatchBuilder } from './runtime/dispatch-builder.js';

// --- Confidence-tiered resolution + the serializable resolution proof ---
export { computeTier, requiresVerification, requiresDecomposition, requiresRefinement, createProof, addProofStep, DEFAULT_THRESHOLDS } from './core/confidence.js';
export type { ConfidenceTier, TierThresholds, ResolutionProof, ProofStep } from './core/confidence.js';

// --- The fallback chain: verify → decompose → refine → observe ---
export { verify, computeKeywordOverlap } from './runtime/verification.js';
export type { VerificationResult, VerificationOptions } from './runtime/verification.js';
export { decompose, executeDecomposition } from './runtime/decomposition.js';
export type { DecompositionResult, DecompositionOptions } from './runtime/decomposition.js';
export { refine, buildRefinementResult } from './runtime/refinement.js';
export type { RefinementResult } from './runtime/refinement.js';
export { DispatchObserver } from './runtime/observer.js';
export type { DispatchRecord, CorrectionSignal, SchemaRejection, AdaptiveThreshold, NegativeExample, ObserverOptions } from './runtime/observer.js';

// --- Pluggable LLM interface (degrades gracefully when absent) ---
export { NULL_LLM_CLIENT } from './core/llm-client.js';
export type { LLMClient, MicroCheckRequest, DecomposeRequest, DecomposeResponse, RefineRequest, RefineResponse, SubIntent, RefinementOption, ToolSummary } from './core/llm-client.js';

// --- Embedding substrate the engine resolves against ---
export { LocalEmbedder } from './embedding/local-embedder.js';
export { MemoryVectorIndex } from './embedding/memory-vector-index.js';

// --- Core engine types ---
export type {
  ArgumentConstraints,
  ArgumentSpec,
  DispatchEvent,
  DispatchEventChunk,
  DispatchEventDone,
  DispatchEventError,
  DispatchEventInferenceDelta,
  DispatchEventResolving,
  DispatchEventToolStart,
  InferenceDelta,
  Embedder,
  JSONSchemaType,
  ResolvedTool,
  SelectorCollision,
  SelectorMatch,
  ToolCandidate,
  ToolCategory,
  ToolDefinition,
  ToolIMP,
  ToolMethod,
  ToolProtocol,
  ToolResult,
  ToolSchema,
  ToolSelector,
  ValidationError,
  ValidationResult,
  VectorIndex,
} from './core/types.js';
