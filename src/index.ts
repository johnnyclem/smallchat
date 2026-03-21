// ToolKit — A Message-Passing Tool Compiler
// v0.0.2

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

// MCP Compliance (full MCP 2025-03-26 spec)
export {
  negotiateProtocolVersion,
  validateJsonRpcRequest,
  requireSession,
  paginate,
  buildProgressNotification,
  buildCancellationNotification,
  buildLogNotification,
  buildRootsChangedNotification,
  buildToolsChangedNotification,
  buildResourcesChangedNotification,
  buildPromptsChangedNotification,
  mcpError,
  MCPErrorCode,
  MCP_PROTOCOL_VERSIONS,
  LATEST_MCP_VERSION,
} from './mcp/compliance.js';
export type {
  MCPProtocolVersion,
  MCPClientCapabilities,
  MCPServerCapabilities,
  MCPLogLevel,
  MCPLogNotification,
  MCPRoot,
  MCPRootsListResult,
  MCPSamplingMessage,
  MCPCreateMessageRequest,
  MCPCreateMessageResult,
  ProgressToken,
  ProgressNotification,
  CancellationNotification,
  PaginationParams,
  PaginatedResult,
} from './mcp/compliance.js';

// MCP Client Registry
export { MCPClientRegistry, mcpClientRegistry } from './mcp/client-registry.js';
export type { MCPClientEntry, MCPClientConfig, MCPClientAuth, AuthType } from './mcp/client-registry.js';

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

// LangChain
export { SmallChatTool, SmallChatToolkit, SmallChatDispatchTool } from './integrations/langchain/index.js';
export type { LangChainToolFields, LangChainSchema, LangChainToolCallResult, LangChainToolCall } from './integrations/langchain/index.js';

// Semantic Kernel
export {
  SmallChatKernelFunction,
  SmallChatPlugin as SmallChatSKPlugin,
  SmallChatDispatchPlugin,
  registerSmallChatPlugin,
  createSemanticKernelPlugins,
} from './integrations/semantic-kernel/index.js';
export type {
  SKKernelFunction,
  SKKernelPlugin,
  SKKernelFunctionMetadata,
  SKParameterMetadata,
  SKFunctionResult,
} from './integrations/semantic-kernel/index.js';

// OpenAI
export {
  toOpenAIFunctionTool,
  toOpenAIAssistantTools,
  toOpenAIChatTools,
  handleAssistantToolCall,
  diffAssistantTools,
} from './integrations/openai/assistant-adapter.js';
export type {
  OpenAIFunctionDefinition,
  OpenAIAssistantFunctionTool,
  OpenAIAssistantTool,
  OpenAIToolCall,
  OpenAIToolOutput,
  OpenAISubmitToolOutputs,
  OpenAIChatTool,
} from './integrations/openai/assistant-adapter.js';

export {
  dispatchToOpenAIStream,
  dispatchToOpenAICompletion,
  chatRequestToDispatch,
  createOpenAIHandler,
} from './integrations/openai/streaming.js';
export type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletion,
  OpenAIChatRequest,
  OpenAIChatMessage,
  OpenAIStreamOptions,
} from './integrations/openai/streaming.js';

// Anthropic
export {
  toAnthropicTool,
  toAnthropicTools,
  handleAnthropicToolUse,
  buildAnthropicToolResultMessage,
  dispatchToAnthropicStream,
} from './integrations/anthropic/adapter.js';
export type {
  AnthropicTool,
  AnthropicInputSchema,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  AnthropicContentBlock,
  AnthropicMessage,
} from './integrations/anthropic/adapter.js';

// Vercel AI SDK
export {
  toVercelAITools,
  impToVercelAITool,
  createSmallChatProvider,
} from './integrations/vercel-ai/index.js';
export type {
  VercelAITool,
  VercelAITools,
  VercelAISchema,
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from './integrations/vercel-ai/index.js';

// LlamaIndex
export {
  SmallChatFunctionTool,
  SmallChatDispatchFunctionTool,
  SmallChatToolset,
  toLlamaIndexTools,
} from './integrations/llamaindex/index.js';
export type {
  LlamaIndexBaseTool,
  LlamaIndexToolMetadata,
  LlamaIndexToolOutput,
} from './integrations/llamaindex/index.js';

// Zapier
export { createSmallChatZapierApp, createLocalDispatchAction } from './integrations/zapier/index.js';
export type {
  ZapierApp,
  ZapierAction,
  ZapierTrigger,
  ZapierBundle,
  ZapierAppOptions,
} from './integrations/zapier/index.js';

// n8n
export {
  SMALLCHAT_NODE_DESCRIPTION,
  SMALLCHAT_CREDENTIAL_DEFINITION,
  executeSmallchatNode,
  createN8nDispatchEndpoints,
} from './integrations/n8n/index.js';
export type {
  N8nNodeDescription,
  N8nNodeProperty,
  N8nNodeExecuteContext,
  N8nNodeExecuteResult,
} from './integrations/n8n/index.js';

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// GraphQL Transport
export { GraphQLTransport, createGraphQLToolIMP } from './transports/graphql.js';
export type {
  GraphQLTransportOptions,
  GraphQLOperation,
  GraphQLResponse,
  GraphQLToolDefinition,
} from './transports/graphql.js';

// SQL Transport
export { SQLTransport, BetterSqlite3Adapter, HttpSqlAdapter, createSQLToolIMPs } from './transports/sql.js';
export type { SQLTransportOptions, SqlAdapter, SqlQueryResult, SqlExecuteOptions } from './transports/sql.js';

// Redis Transport
export { RedisTransport, UpstashRestAdapter, createRedisToolIMPs } from './transports/redis.js';
export type { RedisTransportOptions, RedisAdapter, UpstashConfig } from './transports/redis.js';

// AWS Lambda Transport
export {
  AWSLambdaTransport,
  HttpLambdaAdapter,
  LambdaFunctionUrlAdapter,
  createLambdaToolIMP,
} from './transports/aws-lambda.js';
export type {
  AWSLambdaTransportOptions,
  LambdaAdapter,
  LambdaToolDefinition,
  AWSCredentials,
} from './transports/aws-lambda.js';

// Webhook Transport
export {
  WebhookRouter,
  createGitHubWebhookReceiver,
  createStripeWebhookReceiver,
  createSlackWebhookReceiver,
} from './transports/webhook.js';
export type {
  WebhookReceiverDef,
  WebhookHandler,
  WebhookEventMeta,
  WebhookRouterOptions,
  WebhookDelivery,
  WebhookIncomingRequest,
  WebhookResponse,
} from './transports/webhook.js';

// ---------------------------------------------------------------------------
// Plugin System
// ---------------------------------------------------------------------------

export {
  SmallChatPlugin,
  PluginRegistry,
  defineTransportPlugin,
  defineProviderPlugin,
  defineEmbedderPlugin,
  defineMiddlewarePlugin,
} from './plugins/index.js';
export type {
  PluginMetadata,
  PluginContext,
  TransportHandler,
  DispatchMiddleware,
  PluginLogEntry,
} from './plugins/index.js';

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

export {
  FederationNode,
  FederationPeer,
  FEDERATION_PROTOCOL_VERSION,
} from './federation/index.js';
export type {
  FederationNodeInfo,
  FederationCapability,
  FederationDispatchRequest,
  FederationDispatchResponse,
  FederationPeerConfig,
  FederationNodeOptions,
  FederationHttpHandlers,
} from './federation/index.js';
