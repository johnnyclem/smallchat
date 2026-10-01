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
export { SelectorTable, canonicalize, intentKey, intentSelector, VectorFloodError } from './core/selector-table.js';
export { SelectorNamespace, SelectorShadowingError } from './core/selector-namespace.js';
export type { CoreSelectorEntry } from './core/selector-namespace.js';
export { ResolutionCache, computeSchemaFingerprint } from './core/resolution-cache.js';
export { SemanticRateLimiter, DEFAULT_PRINCIPAL } from './core/semantic-rate-limiter.js';
export type { SemanticRateLimiterOptions, FloodingMetrics, RateLimitVerdict } from './core/semantic-rate-limiter.js';
export { ToolClass, ToolProxy } from './core/tool-class.js';
export { OverloadTable, OverloadAmbiguityError } from './core/overload-table.js';
export type { OverloadEntry, OverloadResolutionResult } from './core/overload-table.js';

// --- The runtime: dispatch, streaming, the fluent builder ---
export {
  DispatchContext,
  UnrecognizedIntent,
  toolkit_dispatch,
  smallchat_dispatchStream,
  smallchat_dispatchStreamById,
  dispatchById,
  resolveIntent,
  toolIdOf,
  DEFAULT_MAX_DECOMPOSITION_DEPTH,
  DEFAULT_MAX_SUB_DISPATCHES,
} from './runtime/dispatch.js';
export type {
  DispatchConfig,
  DispatchOptions,
  DispatchOutcome,
  DispatchByIdOptions,
  RegisteredTool,
  Resolution,
  ResolutionCandidate,
  ResolveOptions,
} from './runtime/dispatch.js';
export { ToolRuntime, runtimeOptionsFromPolicy } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';
export { DispatchBuilder, DispatchError } from './runtime/dispatch-builder.js';

// --- Confidence-tiered resolution + the serializable resolution proof ---
export { computeTier, requiresVerification, requiresDecomposition, requiresRefinement, DEFAULT_THRESHOLDS, quantizeScore, compareRanked, SCORE_QUANTUM } from './core/confidence.js';
export type { ConfidenceTier, TierThresholds } from './core/confidence.js';
export { createProof, addProofStep, finalizeProof, computeProofDigest, PROOF_DIGEST_DOMAIN } from './core/proof.js';
export type {
  ResolutionProof,
  ResolutionOutcome,
  ProofStep,
  ProofStage,
  ProofCandidate,
  ProofGuards,
  ProofContext,
  CandidateSource,
  DecisionCode,
} from './core/proof.js';

// Replay, decision log and explain — exact by construction, and checkable
export {
  DecisionLog,
  DecisionLogError,
  DECISION_LOG_SCHEMA,
  INTENT_DIGEST_DOMAIN,
  intentDigest,
  decisionRecordHash,
  verifyDecisionLog,
  readDecisionLog,
  replayDecisionLog,
} from './runtime/decision-log.js';
export type {
  DecisionRecord,
  DecisionInput,
  DecisionKind,
  DecisionExecution,
  DecisionLogOptions,
  DecisionLogVerification,
  DecisionReplayEntry,
  DecisionReplayReport,
} from './runtime/decision-log.js';
export {
  TraceFormatError,
  REPLAY_EXIT,
  parseTraceFile,
  findTraceFiles,
  loadTraceFiles,
  checkExpectation,
  replayTraces,
  replayPaths,
  formatReplayReport,
  formatDecisionLogReplay,
} from './runtime/replay.js';
export type {
  TraceCase,
  TraceExpectation,
  LoadedTraceCase,
  TraceActual,
  TraceCaseResult,
  ReplayReport,
  ReplayRun,
  DecisionLogReplay,
} from './runtime/replay.js';
export { explainResolution, formatExplanation } from './runtime/explain.js';
export type { Explanation, ExplainedCandidate } from './runtime/explain.js';

// Dispatch policy, guards, argument validation and the canonical call digest
export { evaluateDispatchPolicy, isDestructive } from './runtime/policy.js';
export type { DispatchPolicyOptions, PinState, PolicyCode, PolicyInput, PolicyVerdict } from './runtime/policy.js';
export { IntentPinRegistry, normalizePinPhrase } from './core/intent-pin.js';
export type { IntentPin, IntentPinPolicy, IntentPinMatch } from './core/intent-pin.js';
export { SignatureValidationError } from './core/overload-table.js';
export type { SignatureViolation } from './core/sc-types.js';
export { compileArgumentValidator, createSchemaConstraints, InputSchemaError } from './core/argument-validator.js';
export type { ArgumentCheck, ArgumentCoercion, ArgumentValidationOptions, ArgumentValidator, SchemaDialect } from './core/argument-validator.js';
export { callDigest, CALL_DIGEST_DOMAIN } from './core/call-digest.js';
export { canonicalJson } from './core/jcs.js';
export { toolId, parseToolId } from './core/tool-id.js';

// --- The fallback chain: verify → decompose → refine → observe ---
export { verify, computeKeywordOverlap } from './runtime/verification.js';
export type { VerificationResult, VerificationOptions } from './runtime/verification.js';
export { decompose, executeDecomposition } from './runtime/decomposition.js';
export type { DecompositionResult, DecompositionOptions } from './runtime/decomposition.js';
export { refine, buildRefinementResult } from './runtime/refinement.js';
export type { RefinementResult } from './runtime/refinement.js';
export { DispatchObserver } from './runtime/observer.js';
export type { DispatchRecord, CorrectionSignal, SchemaRejection, NegativeExample, DispatchFeedback, ObserverOptions } from './runtime/observer.js';
export { SemanticMap } from './runtime/semantic-map.js';
export type { LearnedPreference, SemanticMapMatch, SemanticMapOptions, SerializedSemanticMap, SerializedSemanticMapV1, SerializedPreference } from './runtime/semantic-map.js';

// --- Pluggable LLM interface (degrades gracefully when absent) ---
export { NULL_LLM_CLIENT } from './core/llm-client.js';
export type { LLMClient, MicroCheckRequest, DecomposeRequest, DecomposeResponse, RefineRequest, RefineResponse, SubIntent, RefinementOption, ToolSummary } from './core/llm-client.js';

// --- Embedding substrate the engine resolves against ---
// HashEmbedder is a dependency-free placeholder for development and tests;
// real semantic matching uses ONNXEmbedder (package root).
export { HashEmbedder, LocalEmbedder } from './embedding/hash-embedder.js';
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
  EmbedderFingerprint,
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
  ToolAnnotations,
  ToolRefinementNeeded,
  ToolTransport,
  ToolTransportConnectionOptions,
  ToolTransportFactory,
  ExecuteOptions,
  InferenceStream,
  ValidationError,
  ValidationResult,
  VectorIndex,
} from './core/types.js';
