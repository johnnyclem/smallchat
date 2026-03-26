/**
 * Transport Layer — public API.
 *
 * Re-exports all transport types, implementations, and utilities.
 */

// Core types and interfaces
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
  PostmanCollection,
  PostmanItem,
  PostmanRequest,
} from './types.js';

// Error types
export {
  ToolExecutionError,
  TransportTimeoutError,
  CircuitOpenError,
  SandboxError,
  ContainerSandboxError,
  httpStatusToError,
  jsonRpcErrorToError,
  errorToOutput,
  isRetryable,
} from './errors.js';

// Auth strategies
export { BearerTokenAuth, OAuth2ClientCredentialsAuth } from './auth.js';

// Transport implementations
export { HttpTransport } from './http-transport.js';
export { McpStdioTransport, McpSseTransport } from './mcp-client-transport.js';
export { LocalTransport } from './local-transport.js';

// MCP protocol handler
export {
  buildInitializeRequest,
  buildInitializedNotification,
  buildToolsListRequest,
  buildToolCallRequest,
  parseJsonRpcResponse,
  parseStdioMessages,
  encodeStdioMessage,
  nextRequestId,
  resetRequestIdCounter,
} from './mcp-protocol.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  McpToolsListResult,
  McpToolDefinition,
  McpToolCallResult,
  McpContent,
  McpInitializeResult,
} from './mcp-protocol.js';

// Serialization
export { serializeInput, parseOutput } from './serialization.js';

// Middleware
export { withRetry, calculateDelay } from './retry.js';
export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitState } from './circuit-breaker.js';
export { withTimeout, createTimeoutSignal } from './timeout.js';

// Streaming
export { parseSSEStream, parseNDJSONStream, parseTextStream, getStreamParser } from './streaming.js';

// File uploads
export { buildMultipartBody, requiresMultipart } from './file-upload.js';

// Connection pooling
export { ConnectionPool } from './connection-pool.js';
export type { ConnectionPoolConfig } from './connection-pool.js';

// Container sandbox
export { spawnMcpProcess, buildDockerArgs, isDockerAvailable } from './container-sandbox.js';

// Generators
export { generateFromOpenAPI, openAPIToToolDefinitions, fetchOpenAPISpec } from './openapi-generator.js';
export { importPostmanCollection, postmanToToolDefinitions, parsePostmanCollection } from './postman-importer.js';
