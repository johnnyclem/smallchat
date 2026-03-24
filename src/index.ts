// ToolKit — A Message-Passing Tool Compiler
// v0.1.0

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
export { SelectorTable, canonicalize } from './core/selector-table.js';
export { ResolutionCache, computeSchemaFingerprint } from './core/resolution-cache.js';
export { ToolClass, ToolProxy } from './core/tool-class.js';

// Runtime
export { DispatchContext, UnrecognizedIntent, toolkit_dispatch, smallchat_dispatchStream } from './runtime/dispatch.js';
export type { FallbackStep, FallbackChainResult } from './runtime/dispatch.js';
export { ToolRuntime } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';
export { DispatchBuilder } from './runtime/dispatch-builder.js';

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
  RetryConfig,
  CircuitBreakerConfig,
} from './transport/index.js';

export {
  // Error types
  ToolExecutionError,
  TransportTimeoutError,
  CircuitOpenError,
  SandboxError,
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
} from './transport/index.js';
