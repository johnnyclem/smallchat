// smallchat — Semantic Tool Inference
// v1.0 — message-passing dispatch from intent to tool.
//
// The root entry (`@smallchat/core`) is the tool inference core and the
// surfaces built on it: resolving an intent to the right tool (selectors,
// dispatch tables, confidence tiers, resolution proofs, one dispatch policy,
// argument validation), embeddings and compiled artifacts, the compiler, the
// MCP server and clients, transports and the channel bridge.
// `@smallchat/core/inference` is the engine alone.
//
// The optimization satellites are not re-exported here (1.0 breaking change):
//   - compaction, CRDT memory, importance scoring and truth-ledger interop
//     live in `@shorthand/core` (a dependency). `@smallchat/core/compaction`,
//     `/crdt`, `/importance` and `/truth` re-export it unchanged and are
//     deprecated: import `@shorthand/core/<module>` directly.
//   - knowledge pre-compilation and dream recompilation are experimental:
//     `@smallchat/core/memex`, `@smallchat/core/dream`.

// ===== TOOL INFERENCE CORE =====

// Core types
export type {
  ArgumentConstraints,
  ArgumentSpec,
  CompilationResult,
  DispatchEvent,
  DispatchEventChunk,
  DispatchEventDone,
  DispatchEventError,
  DispatchEventInferenceDelta,
  DispatchEventResolving,
  DispatchEventToolStart,
  InferenceDelta,
  CompiledToolRef,
  DuplicateToolPair,
  Embedder,
  EmbedderFingerprint,
  JSONSchemaType,
  LaunchSpec,
  StdioLaunchSpec,
  RemoteLaunchSpec,
  ToolAnnotations,
  ToolRefinementNeeded,
  OverloadEntryData,
  OverloadTableData,
  ProviderManifest,
  ResolvedTool,
  SelectorCollision,
  SelectorMatch,
  SemanticOverloadGroup,
  ToolCandidate,
  ToolCategory,
  ToolDefinition,
  ToolIMP,
  ToolMethod,
  ToolProtocol,
  ToolResult,
  ToolSchema,
  ToolSelector,
  ToolTransport,
  ToolTransportConnectionOptions,
  ToolTransportFactory,
  ExecuteOptions,
  InferenceStream,
  TransportType,
  ValidationError,
  ValidationResult,
  VectorIndex,
  CacheVersionContext,
  InvalidationEvent,
  InvalidationHook,
} from './core/types.js';

// SCObject hierarchy — NSObject-inspired base class for parameter passing
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

// Type system — type descriptors and method signatures
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

// Overload system
export { OverloadTable, OverloadAmbiguityError } from './core/overload-table.js';
export type { OverloadEntry, OverloadResolutionResult } from './core/overload-table.js';

// Core classes
export { SelectorTable, canonicalize, intentKey, intentSelector, VectorFloodError } from './core/selector-table.js';
export { SelectorNamespace, SelectorShadowingError } from './core/selector-namespace.js';
export type { CoreSelectorEntry } from './core/selector-namespace.js';
export { ResolutionCache, computeSchemaFingerprint } from './core/resolution-cache.js';
export { cosineSimilarity } from './core/vector-math.js';
export { SemanticRateLimiter, DEFAULT_PRINCIPAL } from './core/semantic-rate-limiter.js';
export type { SemanticRateLimiterOptions, FloodingMetrics, RateLimitVerdict } from './core/semantic-rate-limiter.js';
export { ToolClass, ToolProxy } from './core/tool-class.js';

// Runtime
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

// 0.4.0: Confidence-Tiered Dispatch (Pillar 1)
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
export { PACKAGE_VERSION } from './core/version.js';
export { canonicalJson } from './core/jcs.js';

// 0.4.0: Pluggable LLM Interface
export { NULL_LLM_CLIENT } from './core/llm-client.js';
export type { LLMClient, MicroCheckRequest, DecomposeRequest, DecomposeResponse, RefineRequest, RefineResponse, SubIntent, RefinementOption, ToolSummary } from './core/llm-client.js';

// 0.4.0: Pre-Flight Verification (Pillar 2)
export { verify, computeKeywordOverlap } from './runtime/verification.js';
export type { VerificationResult, VerificationOptions } from './runtime/verification.js';
export { JevJudge, jevTrigger, JEV_ABSTAIN } from './runtime/jev-judge.js';
export type { JevCandidate, JevJudgeOptions, JevJudgeRequest, JevTrigger, JevVerdict } from './runtime/jev-judge.js';

// 0.4.0: Intent Decomposition (Pillar 3)
export { decompose, executeDecomposition } from './runtime/decomposition.js';
export type { DecompositionResult, DecompositionOptions } from './runtime/decomposition.js';

// 0.4.0: Refinement Protocol (Pillar 4)
export { refine, buildRefinementResult } from './runtime/refinement.js';
export type { RefinementResult } from './runtime/refinement.js';

// Pillar 4b: Semantic Map — learned dispatch preferences from resolved refinements
export { SemanticMap } from './runtime/semantic-map.js';
export type {
  LearnedPreference,
  SemanticMapMatch,
  SemanticMapOptions,
  SerializedSemanticMap,
  SerializedSemanticMapV1,
  SerializedPreference,
} from './runtime/semantic-map.js';

// 0.4.0: Observation & Adaptation (Pillar 5)
export { DispatchObserver } from './runtime/observer.js';
export type { DispatchRecord, CorrectionSignal, SchemaRejection, NegativeExample, DispatchFeedback, ObserverOptions } from './runtime/observer.js';

// Compiler
export { ToolCompiler, DuplicateToolError, SelectorConflictError, toolEmbeddingText } from './compiler/compiler.js';
export type { CompilerOptions } from './compiler/compiler.js';
export { parseMCPManifest, parseOpenAPISpec, parseRawSchema } from './compiler/parser.js';
export type { ParsedTool } from './compiler/parser.js';

// Embedding
export { HashEmbedder, LocalEmbedder, hashFingerprint } from './embedding/hash-embedder.js';
export { MemoryVectorIndex } from './embedding/memory-vector-index.js';
export { ONNXEmbedder, onnxFingerprint } from './embedding/onnx-embedder.js';
export type { ONNXEmbedderOptions } from './embedding/onnx-embedder.js';
export { SqliteVectorIndex } from './embedding/sqlite-vector-index.js';
export { EmbeddingWorkerBridge, WorkerEmbedder, createWorkerEmbedder } from './embedding/worker-embedder.js';
export { WorkerVectorIndex } from './embedding/worker-vector-index.js';

// MCP Client — stdio introspection
export { introspectMcpServer, introspectMcpConfigFile, introspectLocalMcpServer, isMcpConfigFile, isMcpServerProject } from './mcp/client.js';
export type { McpServerConfig, McpConfigFile, IntrospectionResult } from './mcp/client.js';

// MCP Server & Transport Engine
export { MCPServer } from './mcp/server.js';
export type { MCPServerConfig, HttpServeOptions, McpApp, McpToolExecutor } from './mcp/server.js';
export { UpstreamPool } from './mcp/upstream.js';
export type { UpstreamPoolOptions } from './mcp/upstream.js';
export { MCPTransport, getTransport, clearTransports, registerLocalHandler, unregisterLocalHandler } from './mcp/transport.js';
export type { TransportOptions } from './mcp/transport.js';
export { ResourceRegistry, ResourceNotFoundError } from './mcp/resources.js';
export type { MCPResource, MCPResourceContent, MCPResourceTemplate, ResourceChangeEvent, ResourceHandler } from './mcp/resources.js';
export { PromptRegistry, PromptNotFoundError } from './mcp/prompts.js';
export type { MCPPrompt, MCPPromptArgument, MCPPromptMessage, MCPPromptContent, PromptHandler, StaticPrompt } from './mcp/prompts.js';
export { RateLimiter } from './mcp/rate-limiter.js';
export { AuditLog } from './mcp/audit-log.js';
export type { AuditEntry, AuditLogOptions } from './mcp/audit-log.js';
export { diagnoseArtifact, findNearDuplicates, formatDiagnosis } from './artifact/doctor.js';
export type { ArtifactDiagnosis, CheckStatus, DiagnoseOptions, DoctorCheck, NearDuplicate } from './artifact/doctor.js';
export { loadRuntime, buildToolList, findManifests } from './mcp/artifact.js';
export { toCallToolResult } from './mcp/results.js';
export type { LoadRuntimeOptions, LoadedRuntime } from './mcp/artifact.js';
export { SqliteArtifactStore } from './mcp/sqlite-artifact.js';
export type { SqliteArtifactStoreOptions } from './mcp/sqlite-artifact.js';

// Compiled artifacts (format 1.0) and embedder identity — also importable
// alone via `@smallchat/core/artifact`.
export {
  ARTIFACT_FORMAT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  EmbedderMismatchError,
  EmbedderUnavailableError,
  DEFAULT_EMBEDDER_KIND,
  buildArtifact,
  computeContentHash,
  validateArtifact,
  parseArtifact,
  serializeArtifact,
  readArtifact,
  writeArtifact,
  parseEmbedderKind,
  createEmbedder,
  fingerprintOf,
  fingerprintsEqual,
  describeFingerprint,
  assertEmbedderMatches,
  resolveArtifactEmbedder,
  createArtifactIndex,
  toolId,
  parseToolId,
} from './artifact/index.js';
export type {
  ArtifactV1,
  ArtifactProvider,
  ArtifactTool,
  ArtifactSelector,
  ArtifactCollision,
  ArtifactDuplicate,
  ArtifactStats,
  BuildArtifactOptions,
  BuiltinEmbedderKind,
} from './artifact/index.js';

// Channel — Claude Code channel protocol support
export {
  ClaudeCodeChannelAdapter,
  ChannelServer,
  SenderGate,
  filterMetaKeys,
  isValidMetaKey,
  parsePermissionReply,
  isValidPermissionId,
  validatePayloadSize,
  serializeChannelTag,
} from './channel/index.js';
export type {
  ChannelCapabilities,
  ChannelExperimentalCapabilities,
  ChannelEvent,
  ChannelNotificationParams,
  PermissionRequest,
  PermissionVerdict,
  ChannelProviderMeta,
  ChannelServerConfig,
  ChannelMessage,
} from './channel/index.js';

// Transport Layer — ITransport interface and implementations
export type {
  ITransport,
  TransportKind,
  TransportInput,
  TransportOutput,
  TransportMetadata,
  HttpMethod,
  FileUpload,
  AuthStrategy,
  BearerTokenConfig,
  OAuth2ClientCredentialsConfig,
  HttpTransportConfig,
  HttpTransportRoute,
  GeneratedHttpConfig,
  McpStdioTransportConfig,
  McpHttpTransportConfig,
  McpSseTransportConfig,
  LocalTransportConfig,
  LocalHandler,
  SandboxConfig,
  ContainerSandboxConfig,
  RetryConfig,
  CircuitBreakerConfig,
} from './transport/index.js';

export {
  // Error types
  ToolExecutionError,
  TransportTimeoutError,
  CircuitOpenError,
  SandboxError,
  ContainerSandboxError,
  httpStatusToError,
  jsonRpcErrorToError,
  errorToOutput,
  isRetryable,
  // Auth strategies
  BearerTokenAuth,
  OAuth2ClientCredentialsAuth,
  // Transport implementations
  HttpTransport,
  McpStdioTransport,
  McpHttpTransport,
  McpSseTransport,
  LocalTransport,
  // Middleware
  withRetry,
  CircuitBreaker,
  withTimeout,
  // Serialization
  serializeInput,
  parseOutput,
  // Streaming
  parseSSEStream as parseTransportSSEStream,
  parseNDJSONStream,
  parseTextStream,
  getStreamParser,
  // File uploads
  buildMultipartBody,
  requiresMultipart,
  // Connection pooling
  ConnectionPool,
  // Generators
  generateFromOpenAPI,
  openAPIToToolDefinitions,
  fetchOpenAPISpec,
  importPostmanCollection,
  postmanToToolDefinitions,
  parsePostmanCollection,
  // Container sandbox
  spawnMcpProcess,
  buildDockerArgs,
  isDockerAvailable,
} from './transport/index.js';

// Manifest types
export type {
  SmallChatManifest,
  SmallChatPackage,
  ManifestCompilerConfig,
  ManifestOutputConfig,
  ManifestPolicyConfig,
  PreCompiledProvider,
} from './core/manifest.js';

// Registry & Bundle types
export type {
  RegistryEntry,
  RegistryIndex,
  RegistryIndexEntry,
  SmallChatBundle,
  BundleServer,
  ServerInstallConfig,
  EnvVarSpec,
  ServerArgSpec,
  McpServerEntry,
  InstallMethod,
  ServerRuntime,
  InstallTarget,
  ServerCapabilities,
  RegistryEntryStats,
  CategoryDefinition,
  PrecompiledArtifact,
  InstallPlan,
  InstallStep,
  ConfigWriteStep,
  PrerequisiteCheck,
} from './core/registry-types.js';

// MCP Apps Extension — UI dispatch surface used by @smallchat/react
export type {
  AppIMP,
  SerializedAppIMP,
  DispatchEventUIAvailable,
} from './core/types.js';
