/**
 * Transport Layer — ITransport interface and core types.
 *
 * Defines the universal transport contract that all transport implementations
 * (HTTP, MCP, Local, gRPC) must satisfy. Inspired by the Objective-C forwarding
 * pattern: any tool invocation is a "message send" routed through a transport.
 */

import type { ToolResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// ITransport — the universal transport interface
// ---------------------------------------------------------------------------

/**
 * ITransport — the single contract for executing tool calls.
 *
 * Every transport (HTTP, MCP stdio/SSE, local function, gRPC) implements this
 * interface. The runtime dispatches through it without knowing the underlying
 * protocol, keeping tool resolution and execution cleanly separated.
 */
export interface ITransport {
  /** Unique identifier for this transport instance */
  readonly id: string;

  /** Transport type discriminator */
  readonly type: TransportKind;

  /** Execute a tool call and return the result */
  execute(input: TransportInput): Promise<TransportOutput>;

  /** Execute a tool call with streaming response */
  executeStream?(input: TransportInput): AsyncGenerator<TransportOutput>;

  /** Gracefully shut down the transport (close connections, etc.) */
  dispose?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Transport kinds
// ---------------------------------------------------------------------------

export type TransportKind = 'http' | 'mcp-stdio' | 'mcp-sse' | 'local' | 'grpc';

// ---------------------------------------------------------------------------
// TransportInput — what goes into a transport
// ---------------------------------------------------------------------------

export interface TransportInput {
  /** Tool name / operation ID */
  toolName: string;

  /** Arguments to pass to the tool */
  args: Record<string, unknown>;

  /** HTTP method override (for HTTP transports) */
  method?: HttpMethod;

  /** URL path override (for HTTP transports) */
  path?: string;

  /** Additional headers */
  headers?: Record<string, string>;

  /** Request timeout in milliseconds (overrides transport-level timeout) */
  timeoutMs?: number;

  /** Whether to stream the response */
  stream?: boolean;

  /** File uploads for multipart requests */
  files?: FileUpload[];

  /** Signal for cancellation */
  signal?: AbortSignal;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface FileUpload {
  /** Field name in the multipart form */
  fieldName: string;
  /** File content as Buffer or ReadableStream */
  content: Buffer | ReadableStream<Uint8Array>;
  /** Original filename */
  filename: string;
  /** MIME type */
  contentType: string;
}

// ---------------------------------------------------------------------------
// TransportOutput — what comes out of a transport
// ---------------------------------------------------------------------------

export interface TransportOutput {
  /** The response content (parsed) */
  content: unknown;

  /** Whether this represents an error */
  isError: boolean;

  /** Optional metadata about the response */
  metadata?: TransportMetadata;
}

export interface TransportMetadata {
  /** HTTP status code */
  statusCode?: number;
  /** Response headers */
  headers?: Record<string, string>;
  /** Timing information */
  durationMs?: number;
  /** Transport-specific error details */
  error?: string;
  /** Error code (HTTP status, JSON-RPC code, etc.) */
  errorCode?: number;
  /** Whether this chunk is part of a stream */
  streaming?: boolean;
  /** Retry attempt number (0 = first attempt) */
  attempt?: number;
  /** Circuit breaker state at time of call */
  circuitState?: 'closed' | 'open' | 'half-open';
  /** Any additional provider-specific data */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Auth strategy types
// ---------------------------------------------------------------------------

export interface AuthStrategy {
  /** Apply auth to a request (mutates headers in-place) */
  apply(headers: Record<string, string>): Promise<void>;

  /** Refresh credentials if needed (e.g., token refresh) */
  refresh?(): Promise<void>;
}

export interface BearerTokenConfig {
  token: string;
}

export interface OAuth2ClientCredentialsConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes?: string[];
  /** Cached token — auto-refreshed on expiry */
  audience?: string;
}

// ---------------------------------------------------------------------------
// HTTP Transport config
// ---------------------------------------------------------------------------

export interface HttpTransportConfig {
  /** Base URL for the API */
  baseUrl: string;

  /** Default headers applied to every request */
  headers?: Record<string, string>;

  /** Default HTTP method */
  defaultMethod?: HttpMethod;

  /** Authentication strategy */
  auth?: AuthStrategy;

  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;

  /** Retry configuration */
  retry?: RetryConfig;

  /** Circuit breaker configuration */
  circuitBreaker?: CircuitBreakerConfig;

  /** Connection pool size (default: 10) */
  poolSize?: number;
}

// ---------------------------------------------------------------------------
// MCP Client Transport config
// ---------------------------------------------------------------------------

export interface McpStdioTransportConfig {
  /** Command to spawn the MCP server */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Timeout for initialization in ms (default: 10000) */
  initTimeoutMs?: number;
}

export interface McpSseTransportConfig {
  /** SSE endpoint URL */
  url: string;
  /** Authentication strategy */
  auth?: AuthStrategy;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Reconnect delay in ms (default: 1000) */
  reconnectDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Local Transport config
// ---------------------------------------------------------------------------

export interface LocalTransportConfig {
  /** Map of tool name → handler function */
  handlers?: Map<string, LocalHandler>;

  /** Enable sandboxing for untrusted code */
  sandbox?: SandboxConfig;
}

export type LocalHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export interface SandboxConfig {
  /** Enable sandbox isolation */
  enabled: boolean;
  /** Execution timeout in ms (default: 5000) */
  timeoutMs?: number;
  /** Memory limit in MB (default: 128) */
  memoryLimitMb?: number;
  /** Allowed built-in modules (default: none) */
  allowedModules?: string[];
}

// ---------------------------------------------------------------------------
// Retry config
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Jitter factor 0-1 (default: 0.1) */
  jitter?: number;
  /** Which status codes to retry on (default: [408, 429, 500, 502, 503, 504]) */
  retryableStatuses?: number[];
}

// ---------------------------------------------------------------------------
// Circuit breaker config
// ---------------------------------------------------------------------------

export interface CircuitBreakerConfig {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** Time in ms before attempting to close a half-open circuit (default: 60000) */
  resetTimeoutMs?: number;
  /** Number of successful calls in half-open state to close the circuit (default: 1) */
  successThreshold?: number;
}

// ---------------------------------------------------------------------------
// OpenAPI generator types
// ---------------------------------------------------------------------------

export interface HttpTransportRoute {
  toolName: string;
  method: HttpMethod;
  path: string;
  queryParams?: string[];
  pathParams?: string[];
  bodyParams?: string[];
  headers?: Record<string, string>;
}

export interface GeneratedHttpConfig {
  baseUrl: string;
  routes: HttpTransportRoute[];
  auth?: AuthStrategy;
}

// ---------------------------------------------------------------------------
// Postman types
// ---------------------------------------------------------------------------

export interface PostmanCollection {
  info: { name: string; schema: string };
  item: PostmanItem[];
  auth?: PostmanAuth;
  variable?: PostmanVariable[];
}

export interface PostmanItem {
  name: string;
  request?: PostmanRequest;
  item?: PostmanItem[]; // folders
}

export interface PostmanRequest {
  method: string;
  header?: Array<{ key: string; value: string }>;
  url: PostmanUrl;
  body?: PostmanBody;
  auth?: PostmanAuth;
}

export interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[];
  path?: string[];
  query?: Array<{ key: string; value: string }>;
}

export interface PostmanBody {
  mode: 'raw' | 'formdata' | 'urlencoded';
  raw?: string;
  formdata?: Array<{ key: string; value: string; type: string }>;
}

export interface PostmanAuth {
  type: string;
  bearer?: Array<{ key: string; value: string }>;
  oauth2?: Array<{ key: string; value: string }>;
}

export interface PostmanVariable {
  key: string;
  value: string;
}
