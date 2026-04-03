// ToolKit — A Message-Passing Tool Compiler
// v0.4.0 — "Tool Selection Errors: Solved"

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
  Embedder,
  JSONSchemaType,
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
export { SelectorTable, canonicalize, VectorFloodError } from './core/selector-table.js';
export { SelectorNamespace, SelectorShadowingError } from './core/selector-namespace.js';
export type { CoreSelectorEntry } from './core/selector-namespace.js';
export { ResolutionCache, computeSchemaFingerprint } from './core/resolution-cache.js';
export { SemanticRateLimiter } from './core/semantic-rate-limiter.js';
export type { SemanticRateLimiterOptions, FloodingMetrics } from './core/semantic-rate-limiter.js';
export { ToolClass, ToolProxy } from './core/tool-class.js';

// Runtime
export { DispatchContext, UnrecognizedIntent, toolkit_dispatch, smallchat_dispatchStream } from './runtime/dispatch.js';
export type { FallbackStep, FallbackChainResult, DispatchConfig } from './runtime/dispatch.js';
export { ToolRuntime } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';
export { DispatchBuilder } from './runtime/dispatch-builder.js';

// 0.4.0: Confidence-Tiered Dispatch (Pillar 1)
export { computeTier, requiresVerification, requiresDecomposition, requiresRefinement, createProof, addProofStep, DEFAULT_THRESHOLDS } from './core/confidence.js';
export type { ConfidenceTier, TierThresholds, ResolutionProof, ProofStep } from './core/confidence.js';

// 0.4.0: Pluggable LLM Interface
export { NULL_LLM_CLIENT } from './core/llm-client.js';
export type { LLMClient, MicroCheckRequest, DecomposeRequest, DecomposeResponse, RefineRequest, RefineResponse, SubIntent, RefinementOption, ToolSummary } from './core/llm-client.js';

// 0.4.0: Pre-Flight Verification (Pillar 2)
export { verify, computeKeywordOverlap } from './runtime/verification.js';
export type { VerificationResult, VerificationOptions } from './runtime/verification.js';

// 0.4.0: Intent Decomposition (Pillar 3)
export { decompose, executeDecomposition } from './runtime/decomposition.js';
export type { DecompositionResult, DecompositionOptions } from './runtime/decomposition.js';

// 0.4.0: Refinement Protocol (Pillar 4)
export { refine, buildRefinementResult } from './runtime/refinement.js';
export type { RefinementResult } from './runtime/refinement.js';

// 0.4.0: Observation & Adaptation (Pillar 5)
export { DispatchObserver } from './runtime/observer.js';
export type { DispatchRecord, CorrectionSignal, SchemaRejection, AdaptiveThreshold, NegativeExample, ObserverOptions } from './runtime/observer.js';

// Compiler
export { ToolCompiler } from './compiler/compiler.js';
export type { CompilerOptions } from './compiler/compiler.js';
export { parseMCPManifest, parseOpenAPISpec, parseRawSchema } from './compiler/parser.js';
export type { ParsedTool } from './compiler/parser.js';

// Embedding
export { LocalEmbedder } from './embedding/local-embedder.js';
export { MemoryVectorIndex } from './embedding/memory-vector-index.js';
export { ONNXEmbedder } from './embedding/onnx-embedder.js';
export type { ONNXEmbedderOptions } from './embedding/onnx-embedder.js';
export { SqliteVectorIndex } from './embedding/sqlite-vector-index.js';
export { EmbeddingWorkerBridge, WorkerEmbedder, createWorkerEmbedder } from './embedding/worker-embedder.js';
export { WorkerVectorIndex } from './embedding/worker-vector-index.js';

// MCP Client — stdio introspection
export { introspectMcpServer, introspectMcpConfigFile, introspectLocalMcpServer, isMcpConfigFile, isMcpServerProject } from './mcp/client.js';
export type { McpServerConfig, McpConfigFile, IntrospectionResult } from './mcp/client.js';

// MCP Server & Transport Engine
export { MCPServer } from './mcp/server.js';
export type { MCPServerConfig } from './mcp/server.js';
export { MCPTransport, getTransport, clearTransports, registerLocalHandler, unregisterLocalHandler } from './mcp/transport.js';
export type { TransportOptions } from './mcp/transport.js';
export { SessionStore } from './mcp/session-store.js';
export type { MCPSession } from './mcp/session-store.js';
export { OAuthManager, MCP_SCOPES } from './mcp/oauth.js';
export type { OAuthToken, OAuthClient, TokenIntrospection, PermissionsConfig, OAuthManagerOptions, MCPScope } from './mcp/oauth.js';
export { ResourceRegistry, ResourceNotFoundError } from './mcp/resources.js';
export type { MCPResource, MCPResourceContent, MCPResourceTemplate, ResourceChangeEvent, ResourceHandler } from './mcp/resources.js';
export { PromptRegistry, PromptNotFoundError } from './mcp/prompts.js';
export type { MCPPrompt, MCPPromptArgument, MCPPromptMessage, MCPPromptContent, PromptHandler, StaticPrompt } from './mcp/prompts.js';
export { RateLimiter } from './mcp/rate-limiter.js';
export { AuditLog } from './mcp/audit-log.js';
export type { AuditEntry } from './mcp/audit-log.js';
export { loadRuntime, buildToolList, formatContent, findManifests, buildArtifact } from './mcp/artifact.js';
export type { SerializedArtifact } from './mcp/artifact.js';
export { SqliteArtifactStore } from './mcp/sqlite-artifact.js';

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

// Dream — memory-driven tool re-compilation
export { compileLatest, dream } from './dream/dream-compiler.js';
export type { CompileLatestOptions } from './dream/dream-compiler.js';
export { readMemoryFiles, extractToolMentions } from './dream/memory-reader.js';
export { discoverLogFiles, analyzeSessionLog, aggregateUsageStats } from './dream/log-analyzer.js';
export { prioritizeTools, generateReport } from './dream/tool-prioritizer.js';
export { loadDreamConfig, saveDreamConfig, DEFAULT_DREAM_CONFIG } from './dream/config.js';
export {
  loadManifest as loadArtifactManifest,
  archiveCurrentArtifact,
  promoteArtifact,
  rollbackToFallback,
  pruneOldVersions,
  listVersions,
} from './dream/artifact-versioning.js';
export type {
  ToolUsageRecord,
  ToolUsageStats,
  MemoryFileContent,
  MemoryToolMention,
  ToolPriorityHints,
  DreamAnalysis,
  DreamResult,
  DreamConfig,
  ArtifactVersion,
  ArtifactManifest,
} from './dream/types.js';

// Compaction — re-exported from @shorthand/core
export {
  DefaultCompactor,
  estimateTokens,
  estimateConversationTokens,
  extractEntities,
  extractDecisions,
  detectTombstones,
  DefaultQuizGenerator,
  DefaultQuizEvaluator,
  tokenOverlapScore,
  runRecallTest,
  correctionPropagation,
  entityProvenance,
  decisionCompleteness,
  tombstoneConsistency,
  temporalOrdering,
  BUILTIN_INVARIANTS,
  checkInvariants,
  tokenize,
  shannonEntropy,
  totalInformationBits,
  computeEntropyMetrics,
  computeRateDistortion,
  measureEntityRetention,
  analyzeInformationTheoretic,
  VerificationHarness,
  DEFAULT_VERIFICATION_CONFIG,
} from '@shorthand/core/compaction';
export type {
  CompactedState,
  CompactionInvariant,
  CompactionLevel,
  CompactionVerificationConfig,
  Compactor,
  ConversationHistory,
  ConversationMessage,
  Decision,
  EntityCorrection,
  EntityRetention,
  EntropyMetrics,
  ExtractedEntity,
  InformationTheoreticResult,
  InvariantCheckResult,
  InvariantViolation,
  QuizEvaluator,
  QuizGenerator,
  RateDistortionMetrics,
  RecallAnswer,
  RecallQuestion,
  RecallTestResult,
  Tombstone,
} from '@shorthand/core/compaction';
// VerificationResult name collides with core/types — export under alias
export type { VerificationResult as CompactionVerificationResult } from '@shorthand/core/compaction';

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

// CRDT — re-exported from @shorthand/core
export {
  LamportClock,
  compareLamport,
  createVectorClock,
  tickVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
  LWWRegister,
  ORSet,
  GSet,
  defaultMergeFn,
  RGA,
  AgentMemory,
  MemoryMerge,
  ConflictDetector,
} from '@shorthand/core/crdt';
export type {
  AgentId,
  LamportTimestamp,
  VectorClock,
  UniqueTag,
  CausalMeta,
  MergeResult,
  CRDTInterface,
  LWWEntry,
  LWWRegisterState,
  ORSetState,
  GSetEntry,
  GSetState,
  GSetMergeFn,
  RGANodeId,
  RGANode,
  RGAState,
  MemoryLayer,
  L4Invariants,
  L3Entity,
  L3Edge,
  L3Graph,
  L2Summary,
  L1Context,
  L0Message,
  AgentMemoryState,
  SemanticConflict,
  ConflictSeverity,
} from '@shorthand/core/crdt';

// Manifest types
export type {
  SmallChatManifest,
  SmallChatPackage,
  ManifestCompilerConfig,
  ManifestOutputConfig,
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
