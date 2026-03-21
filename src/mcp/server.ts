import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, readdirSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { resolve, join } from 'node:path';
import type { CompilationResult, ProviderManifest, ToolResult, DispatchEvent } from '../core/types.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { ToolRuntime } from '../runtime/runtime.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { SessionStore, type MCPSession } from './session-store.js';
import { OAuthManager, type TokenIntrospection } from './oauth.js';
import { ResourceRegistry, ResourceNotFoundError } from './resources.js';
import { PromptRegistry, PromptNotFoundError } from './prompts.js';
import { rootLogger } from '../observability/logger.js';
import { getTracer, SpanStatusCode, flushTracing } from '../observability/tracing.js';
import { metrics, metricsRegistry, cacheHitRate } from '../observability/metrics.js';
import { flightRecorder } from '../observability/flight-recorder.js';

const log = rootLogger.child({ component: 'mcp-server' });
const tracer = getTracer('smallchat.server');

/**
 * MCPServer — production-grade MCP 2026 compliant JSON-RPC server.
 *
 * Implements the full MCP protocol:
 *   - JSON-RPC 2.0 over HTTP with SSE streaming
 *   - /.well-known/mcp.json discovery
 *   - Session management (create/resume/destroy)
 *   - tools/list, tools/call (paginated, with streaming)
 *   - resources/list, resources/read, resources/subscribe
 *   - prompts/list, prompts/get
 *   - OAuth 2.1 bearer token authentication
 *   - Progress notifications and listChanged events
 *   - Rate limiting and audit logging
 */

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'smallchat';
const SERVER_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Server configuration
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to */
  host: string;
  /** Source directory or compiled artifact */
  sourcePath: string;
  /** SQLite database path for sessions */
  dbPath?: string;
  /** Enable OAuth 2.1 authentication */
  enableAuth?: boolean;
  /** Enable rate limiting */
  enableRateLimit?: boolean;
  /** Max requests per minute per client */
  rateLimitRPM?: number;
  /** Enable audit logging */
  enableAudit?: boolean;
  /** Session TTL in milliseconds (default: 24h) */
  sessionTTLMs?: number;
  /** Max concurrent tool executions (0 = unlimited) */
  maxConcurrentExecutions?: number;
  /** Max dispatch queue depth (0 = unlimited) */
  maxQueueDepth?: number;
  /** Per-tool rate limits: map of tool name → RPM */
  toolRateLimits?: Record<string, number>;
  /** Enable hot-reload watching of sourcePath */
  enableHotReload?: boolean;
  /** Hot-reload debounce delay in ms (default: 500) */
  hotReloadDebounceMs?: number;
  /** Enable /metrics endpoint */
  enableMetrics?: boolean;
  /** Graceful shutdown timeout in ms (default: 30s) */
  gracefulShutdownTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

class RateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();
  private maxRPM: number;

  constructor(maxRPM: number = 600) {
    this.maxRPM = maxRPM;
  }

  check(clientId: string): boolean {
    const now = Date.now();
    const window = this.windows.get(clientId);

    if (!window || now > window.resetAt) {
      this.windows.set(clientId, { count: 1, resetAt: now + 60000 });
      return true;
    }

    if (window.count >= this.maxRPM) {
      return false;
    }

    window.count++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Audit logger
// ---------------------------------------------------------------------------

interface AuditEntry {
  timestamp: string;
  method: string;
  sessionId?: string;
  clientId?: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

class AuditLog {
  private entries: AuditEntry[] = [];
  private maxEntries = 10000;

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  recent(count: number = 100): AuditEntry[] {
    return this.entries.slice(-count);
  }
}

// ---------------------------------------------------------------------------
// Per-tool rate limiter
// ---------------------------------------------------------------------------

class ToolRateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();

  /** Returns true if the request is allowed */
  check(tool: string, limits: Record<string, number>): boolean {
    const rpm = limits[tool];
    if (!rpm) return true; // No limit configured for this tool

    const key = tool;
    const now = Date.now();
    const window = this.windows.get(key);

    if (!window || now > window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + 60000 });
      return true;
    }

    if (window.count >= rpm) {
      return false;
    }

    window.count++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Concurrency limiter with queue
// ---------------------------------------------------------------------------

class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly maxConcurrent: number;
  private readonly maxQueueDepth: number;

  constructor(maxConcurrent: number, maxQueueDepth: number) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueDepth = maxQueueDepth;
  }

  get active(): number { return this.activeCount; }
  get queued(): number { return this.queue.length; }

  /** Acquire a slot. Waits in queue if at capacity. */
  acquire(): Promise<void> {
    if (this.maxConcurrent === 0) return Promise.resolve(); // unlimited

    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;
      metrics.activeExecutions.set(this.activeCount);
      metrics.queueDepth.set(this.queue.length);
      return Promise.resolve();
    }

    // Queue the request
    if (this.maxQueueDepth > 0 && this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new Error('Dispatch queue is full'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      metrics.queueDepth.set(this.queue.length);
    });
  }

  /** Release a slot and unblock the next queued request */
  release(): void {
    if (this.maxConcurrent === 0) return;

    const next = this.queue.shift();
    if (next) {
      metrics.queueDepth.set(this.queue.length);
      next.resolve();
    } else {
      this.activeCount = Math.max(0, this.activeCount - 1);
      metrics.activeExecutions.set(this.activeCount);
    }
  }

  /** Drain the queue with an error (used during shutdown) */
  drain(reason: string): void {
    const waiting = this.queue.splice(0);
    for (const waiter of waiting) {
      waiter.reject(new Error(reason));
    }
    metrics.queueDepth.set(0);
  }
}

// ---------------------------------------------------------------------------
// SSE client tracker
// ---------------------------------------------------------------------------

interface SSEClient {
  id: string;
  response: ServerResponse;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// MCPServer class
// ---------------------------------------------------------------------------

export class MCPServer {
  private server: Server | null = null;
  private runtime: ToolRuntime | null = null;
  private artifact: SerializedArtifact | null = null;
  private sessionStore: SessionStore | null = null;
  private oauthManager: OAuthManager;
  private resourceRegistry: ResourceRegistry;
  private promptRegistry: PromptRegistry;
  private rateLimiter: RateLimiter;
  private toolRateLimiter: ToolRateLimiter;
  private concurrencyLimiter: ConcurrencyLimiter;
  private auditLog: AuditLog;
  private sseClients: Map<string, SSEClient> = new Map();
  private config: MCPServerConfig;
  private sseCounter = 0;
  /** Set to true when shutdown is in progress — blocks new requests */
  private shuttingDown = false;
  /** Tracks in-flight request count for graceful drain */
  private inFlightCount = 0;
  /** Resolves when all in-flight requests finish during shutdown */
  private drainResolve: (() => void) | null = null;
  /** Hot-reload debounce timer */
  private hotReloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.oauthManager = new OAuthManager();
    this.resourceRegistry = new ResourceRegistry();
    this.promptRegistry = new PromptRegistry();
    this.rateLimiter = new RateLimiter(config.rateLimitRPM ?? 600);
    this.toolRateLimiter = new ToolRateLimiter();
    this.concurrencyLimiter = new ConcurrencyLimiter(
      config.maxConcurrentExecutions ?? 0,
      config.maxQueueDepth ?? 0,
    );
    this.auditLog = new AuditLog();
  }

  /** Access the resource registry for handler registration */
  get resources(): ResourceRegistry {
    return this.resourceRegistry;
  }

  /** Access the prompt registry for handler registration */
  get prompts(): PromptRegistry {
    return this.promptRegistry;
  }

  /** Access the OAuth manager for client registration */
  get oauth(): OAuthManager {
    return this.oauthManager;
  }

  /**
   * Start the MCP server.
   */
  async start(): Promise<void> {
    log.info({ sourcePath: this.config.sourcePath }, 'Loading toolkit');

    // Load runtime
    const { runtime, artifact } = await loadRuntime(this.config.sourcePath);
    this.runtime = runtime;
    this.artifact = artifact;

    // Initialize session store
    const dbPath = this.config.dbPath ?? 'smallchat.db';
    this.sessionStore = new SessionStore(dbPath);

    // Prune old sessions
    const ttl = this.config.sessionTTLMs ?? 24 * 60 * 60 * 1000;
    this.sessionStore.prune(ttl);

    log.info({
      tools: artifact.stats.toolCount,
      providers: artifact.stats.providerCount,
      sessions: this.sessionStore.count(),
    }, 'Toolkit loaded');

    // Start hot-reload watcher
    if (this.config.enableHotReload) {
      this.startHotReload();
    }

    // Create HTTP server
    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        log.info({
          host: this.config.host,
          port: this.config.port,
          protocol: MCP_PROTOCOL_VERSION,
          endpoints: ['/', '/.well-known/mcp.json', '/sse', '/health', '/ready', '/metrics', '/oauth/token'],
        }, 'smallchat MCP server started');
        resolve();
      });
    });
  }

  /**
   * Reload tool definitions without restarting the process.
   * Flushes the resolution cache and reloads from sourcePath.
   */
  async hotReload(): Promise<void> {
    log.info({ sourcePath: this.config.sourcePath }, 'Hot-reload triggered');
    try {
      const { runtime, artifact } = await loadRuntime(this.config.sourcePath);

      // Flush caches on old runtime before swap
      if (this.runtime) {
        this.runtime.cache.flush();
      }

      this.runtime = runtime;
      this.artifact = artifact;

      // Notify SSE clients
      this.broadcastListChanged('tools');

      log.info({ tools: artifact.stats.toolCount }, 'Hot-reload complete');
    } catch (err) {
      log.error({ err }, 'Hot-reload failed');
    }
  }

  private startHotReload(): void {
    const debounceMs = this.config.hotReloadDebounceMs ?? 500;

    const triggerReload = () => {
      if (this.hotReloadTimer) clearTimeout(this.hotReloadTimer);
      this.hotReloadTimer = setTimeout(() => {
        void this.hotReload();
      }, debounceMs);
    };

    try {
      watchFile(this.config.sourcePath, { interval: 1000 }, triggerReload);
      log.info({ sourcePath: this.config.sourcePath }, 'Hot-reload watcher active');
    } catch (err) {
      log.warn({ err }, 'Failed to start hot-reload watcher');
    }
  }

  /** Stop the server and clean up with graceful drain */
  async stop(): Promise<void> {
    log.info({ inFlight: this.inFlightCount }, 'Graceful shutdown initiated');
    this.shuttingDown = true;

    // Stop accepting new requests; stop hot-reload watcher
    if (this.hotReloadTimer) clearTimeout(this.hotReloadTimer);
    try { unwatchFile(this.config.sourcePath); } catch { /* ignore */ }

    // Drain the dispatch queue
    this.concurrencyLimiter.drain('Server shutting down');

    // Wait for in-flight requests to complete (with timeout)
    const timeoutMs = this.config.gracefulShutdownTimeoutMs ?? 30000;

    if (this.inFlightCount > 0) {
      log.info({ inFlight: this.inFlightCount, timeoutMs }, 'Waiting for in-flight requests to finish');
      await Promise.race([
        new Promise<void>((res) => { this.drainResolve = res; }),
        new Promise<void>((res) => setTimeout(res, timeoutMs)),
      ]);
    }

    // Close SSE connections
    for (const client of this.sseClients.values()) {
      client.response.end();
    }
    this.sseClients.clear();

    // Close session store
    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }

    // Flush tracing and flight recorder
    await Promise.all([flushTracing(), flightRecorder.flush()]);

    log.info('Server stopped');

    // Close HTTP server
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Request router
  // ---------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reqStart = Date.now();

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Reject new requests during shutdown (except health/ready)
    const url = req.url ?? '/';
    if (this.shuttingDown && url !== '/health' && url !== '/ready') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Service unavailable — shutting down' }));
      return;
    }

    // Track in-flight requests for graceful drain
    this.inFlightCount++;
    res.on('finish', () => {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      const method = req.method ?? 'GET';
      const statusCode = String(res.statusCode);
      metrics.httpLatency.observe(Date.now() - reqStart, { method, path: url.split('?')[0] ?? '/', status: statusCode });
      if (this.shuttingDown && this.inFlightCount === 0 && this.drainResolve) {
        this.drainResolve();
      }
    });

    // Static routes
    if (req.method === 'GET') {
      if (url === '/.well-known/mcp.json') return this.handleDiscovery(res);
      if (url === '/health') return this.handleHealth(res);
      if (url === '/ready') return this.handleReady(res);
      if (url === '/metrics' && this.config.enableMetrics) return this.handleMetrics(res);
      if (url === '/debug/flight') return this.handleDebugFlight(res);
      if (url === '/sse') return this.handleSSE(req, res);
    }

    // OAuth token endpoint
    if (req.method === 'POST' && url === '/oauth/token') {
      return this.handleOAuthToken(req, res);
    }

    // JSON-RPC endpoint
    if (req.method === 'POST' && (url === '/' || url === '/rpc')) {
      return this.handleJsonRpc(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ---------------------------------------------------------------------------
  // /.well-known/mcp.json — MCP discovery
  // ---------------------------------------------------------------------------

  private handleDiscovery(res: ServerResponse): void {
    const discovery = {
      mcpVersion: MCP_PROTOCOL_VERSION,
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      capabilities: this.getCapabilities(),
      endpoints: {
        jsonrpc: '/',
        sse: '/sse',
        health: '/health',
        oauth: '/oauth/token',
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discovery, null, 2));
  }

  // ---------------------------------------------------------------------------
  // /health — Health check
  // ---------------------------------------------------------------------------

  private handleHealth(res: ServerResponse): void {
    const isHealthy = !!this.runtime && !!this.artifact && !this.shuttingDown;
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isHealthy ? 'ok' : 'degraded',
      version: SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: this.artifact?.stats.toolCount ?? 0,
      providers: this.artifact?.stats.providerCount ?? 0,
      sessions: this.sessionStore?.count() ?? 0,
      sseClients: this.sseClients.size,
      activeExecutions: this.concurrencyLimiter.active,
      queueDepth: this.concurrencyLimiter.queued,
      cacheHitRate: cacheHitRate(),
      shuttingDown: this.shuttingDown,
    }));
  }

  // ---------------------------------------------------------------------------
  // /ready — Readiness probe (for k8s)
  // ---------------------------------------------------------------------------

  private handleReady(res: ServerResponse): void {
    // Ready when runtime is loaded and not shutting down
    const isReady = !!this.runtime && !!this.artifact && !this.shuttingDown;

    if (isReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', tools: this.artifact?.stats.toolCount ?? 0 }));
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'not_ready',
        reason: this.shuttingDown ? 'shutting_down' : 'runtime_not_loaded',
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // /metrics — Prometheus metrics endpoint
  // ---------------------------------------------------------------------------

  private handleMetrics(res: ServerResponse): void {
    // Update live gauges before rendering
    metrics.sseConnections.set(this.sseClients.size);
    metrics.activeExecutions.set(this.concurrencyLimiter.active);
    metrics.queueDepth.set(this.concurrencyLimiter.queued);

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(metricsRegistry.toPrometheus());
  }

  // ---------------------------------------------------------------------------
  // /debug/flight — Flight recorder data for Debug UI
  // ---------------------------------------------------------------------------

  private handleDebugFlight(res: ServerResponse): void {
    const entries = flightRecorder.recent(200);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
  }

  // ---------------------------------------------------------------------------
  // /sse — Server-Sent Events stream
  // ---------------------------------------------------------------------------

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    const clientId = `sse_${++this.sseCounter}`;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send connected event
    this.sendSSEEvent(res, 'connected', {
      clientId,
      timestamp: Date.now(),
      sessionId,
    });

    // Track client
    this.sseClients.set(clientId, { id: clientId, response: res, sessionId });

    // Keep alive
    const keepAlive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      this.sseClients.delete(clientId);
    });
  }

  // ---------------------------------------------------------------------------
  // /oauth/token — OAuth 2.1 token endpoint
  // ---------------------------------------------------------------------------

  private async handleOAuthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let params: Record<string, string>;

    try {
      // Support both JSON and form-urlencoded
      if (req.headers['content-type']?.includes('application/json')) {
        params = JSON.parse(body);
      } else {
        params = Object.fromEntries(new URLSearchParams(body));
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_request' }));
      return;
    }

    if (params.grant_type === 'client_credentials') {
      const token = this.oauthManager.issueToken(
        params.client_id,
        params.client_secret,
        params.scope?.split(' '),
      );

      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: token.accessToken,
        token_type: token.tokenType,
        expires_in: token.expiresIn,
        scope: token.scope,
        refresh_token: token.refreshToken,
      }));
      return;
    }

    if (params.grant_type === 'refresh_token') {
      const token = this.oauthManager.refreshAccessToken(params.refresh_token);

      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: token.accessToken,
        token_type: token.tokenType,
        expires_in: token.expiresIn,
        scope: token.scope,
        refresh_token: token.refreshToken,
      }));
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC handler
  // ---------------------------------------------------------------------------

  private async handleJsonRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const body = await readBody(req);
    let rpcReq: JsonRpcRequest;

    try {
      rpcReq = JSON.parse(body);
    } catch {
      sendJsonRpc(res, null, undefined, { code: PARSE_ERROR, message: 'Parse error' });
      return;
    }

    if (!rpcReq.jsonrpc || rpcReq.jsonrpc !== '2.0') {
      sendJsonRpc(res, null, undefined, { code: INVALID_REQUEST, message: 'Invalid JSON-RPC version' });
      return;
    }

    const id = rpcReq.id ?? null;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Auth check (if enabled)
    if (this.config.enableAuth) {
      const auth = this.oauthManager.extractBearerToken(req.headers.authorization);
      if (!auth.active && rpcReq.method !== 'initialize') {
        sendJsonRpc(res, id, undefined, { code: -32000, message: 'Authentication required' });
        return;
      }
    }

    // Rate limit check
    if (this.config.enableRateLimit) {
      const clientKey = sessionId ?? req.socket.remoteAddress ?? 'unknown';
      if (!this.rateLimiter.check(clientKey)) {
        sendJsonRpc(res, id, undefined, { code: -32000, message: 'Rate limit exceeded' });
        return;
      }
    }

    // Touch session
    if (sessionId && this.sessionStore) {
      this.sessionStore.touch(sessionId);
    }

    const wantsStream = req.headers.accept?.includes('text/event-stream');

    const rpcSpan = tracer.startSpan('json-rpc', { attributes: { 'rpc.method': rpcReq.method } });
    let success = true;

    try {
      await this.dispatchMethod(rpcReq, id, sessionId, wantsStream ?? false, res);
    } catch (err) {
      success = false;
      rpcSpan.recordException(err);
      rpcSpan.setStatus({ code: SpanStatusCode.ERROR });
      log.error({ err, method: rpcReq.method, sessionId }, 'JSON-RPC handler error');
      sendJsonRpc(res, id, undefined, { code: INTERNAL_ERROR, message: (err as Error).message });
    } finally {
      rpcSpan.end();
    }

    // Audit log
    if (this.config.enableAudit) {
      this.auditLog.log({
        timestamp: new Date().toISOString(),
        method: rpcReq.method,
        sessionId,
        success,
        durationMs: Date.now() - startTime,
      });
    }

    log.debug({ method: rpcReq.method, sessionId, durationMs: Date.now() - startTime, success }, 'JSON-RPC request completed');
  }

  // ---------------------------------------------------------------------------
  // Method dispatch
  // ---------------------------------------------------------------------------

  private async dispatchMethod(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    sessionId: string | undefined,
    wantsStream: boolean,
    res: ServerResponse,
  ): Promise<void> {
    switch (rpcReq.method) {
      // ---- Lifecycle ----
      case 'initialize':
        return this.handleInitialize(rpcReq, id, res);
      case 'ping':
        return this.handlePing(id, res);
      case 'shutdown':
        return this.handleShutdown(id, sessionId, res);
      case 'notifications/initialized':
        // Client acknowledgement — no response needed for notifications
        if (id === null) return;
        sendJsonRpc(res, id, {});
        return;

      // ---- Tools ----
      case 'tools/list':
        return this.handleToolsList(rpcReq, id, res);
      case 'tools/call':
        return this.handleToolsCall(rpcReq, id, wantsStream, res);

      // ---- Resources ----
      case 'resources/list':
        return this.handleResourcesList(rpcReq, id, res);
      case 'resources/read':
        return this.handleResourcesRead(rpcReq, id, res);
      case 'resources/templates/list':
        return this.handleResourcesTemplatesList(id, res);
      case 'resources/subscribe':
        return this.handleResourcesSubscribe(rpcReq, id, sessionId, res);
      case 'resources/unsubscribe':
        return this.handleResourcesUnsubscribe(rpcReq, id, res);

      // ---- Prompts ----
      case 'prompts/list':
        return this.handlePromptsList(rpcReq, id, res);
      case 'prompts/get':
        return this.handlePromptsGet(rpcReq, id, res);

      default:
        sendJsonRpc(res, id, undefined, {
          code: METHOD_NOT_FOUND,
          message: `Unknown method: ${rpcReq.method}`,
        });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods
  // ---------------------------------------------------------------------------

  private handleInitialize(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): void {
    const clientInfo = rpcReq.params?.clientInfo as Record<string, unknown> | undefined;
    const requestedVersion = rpcReq.params?.protocolVersion as string | undefined;

    // Create session
    const session = this.sessionStore!.create({
      protocolVersion: requestedVersion ?? MCP_PROTOCOL_VERSION,
      clientInfo: clientInfo ?? {},
    });

    res.setHeader('Mcp-Session-Id', session.id);

    sendJsonRpc(res, id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: this.getCapabilities(),
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      sessionId: session.id,
    });
  }

  private handlePing(id: string | number | null, res: ServerResponse): void {
    sendJsonRpc(res, id, {});
  }

  private handleShutdown(
    id: string | number | null,
    sessionId: string | undefined,
    res: ServerResponse,
  ): void {
    if (sessionId && this.sessionStore) {
      this.sessionStore.delete(sessionId);
    }
    sendJsonRpc(res, id, { status: 'shutdown' });
  }

  // ---------------------------------------------------------------------------
  // Tools methods
  // ---------------------------------------------------------------------------

  private handleToolsList(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): void {
    if (!this.artifact) {
      sendJsonRpc(res, id, { tools: [] });
      return;
    }

    const allTools = buildToolList(this.artifact);
    const cursor = rpcReq.params?.cursor as string | undefined;

    // Paginate (default page size: 100)
    const pageSize = 100;
    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const page = allTools.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < allTools.length
      ? String(startIndex + pageSize)
      : undefined;

    sendJsonRpc(res, id, { tools: page, nextCursor });
  }

  private async handleToolsCall(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    wantsStream: boolean,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.runtime) {
      sendJsonRpc(res, id, undefined, { code: INTERNAL_ERROR, message: 'Runtime not initialized' });
      return;
    }

    const toolName = rpcReq.params?.name as string;
    const args = (rpcReq.params?.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: 'Missing tool name' });
      return;
    }

    // Per-tool rate limiting
    if (this.config.toolRateLimits) {
      if (!this.toolRateLimiter.check(toolName, this.config.toolRateLimits)) {
        metrics.rateLimitRejections.inc({ client: 'tool:' + toolName });
        sendJsonRpc(res, id, undefined, { code: -32000, message: `Rate limit exceeded for tool: ${toolName}` });
        return;
      }
    }

    // Acquire concurrency slot (may queue)
    try {
      await this.concurrencyLimiter.acquire();
    } catch (err) {
      sendJsonRpc(res, id, undefined, { code: -32000, message: (err as Error).message });
      return;
    }

    if (wantsStream) {
      try {
        return await this.handleToolsCallStreaming(toolName, args, id, res);
      } finally {
        this.concurrencyLimiter.release();
      }
    }

    // Standard JSON-RPC response with OTel tracing + metrics + flight recorder
    const span = tracer.startSpan('tools/call', { attributes: { 'tool.name': toolName } });
    const startMs = Date.now();

    try {
      const result = await this.runtime.dispatch(toolName, args);
      const durationMs = Date.now() - startMs;

      metrics.dispatchTotal.inc({ tool: toolName, status: 'success' });
      metrics.toolLatency.observe(durationMs, { tool: toolName });
      span.setAttribute('tool.duration_ms', durationMs);
      span.setStatus({ code: SpanStatusCode.OK });

      flightRecorder.record({
        intent: toolName,
        args,
        resolvedTool: toolName,
        durationMs,
        success: true,
      });

      sendJsonRpc(res, id, {
        content: formatContent(result),
        isError: result.isError ?? false,
      });
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const errMsg = (err as Error).message;

      metrics.dispatchErrors.inc({ tool: toolName, error_type: (err as Error).name });
      metrics.toolLatency.observe(durationMs, { tool: toolName });
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });

      flightRecorder.record({
        intent: toolName,
        args,
        durationMs,
        success: false,
        error: errMsg,
      });

      sendJsonRpc(res, id, undefined, { code: INTERNAL_ERROR, message: errMsg });
    } finally {
      span.end();
      this.concurrencyLimiter.release();
    }
  }

  private async handleToolsCallStreaming(
    toolName: string,
    args: Record<string, unknown>,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send progress notification: started
    this.sendSSEEvent(res, 'message', {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: id, progress: 0, total: 1, status: 'started', tool: toolName },
    });

    try {
      let chunkIndex = 0;
      for await (const event of this.runtime!.dispatchStream(toolName, args)) {
        switch (event.type) {
          case 'tool-start':
            this.sendSSEEvent(res, 'message', {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken: id,
                progress: 0,
                total: 1,
                status: 'executing',
                tool: event.toolName,
                provider: event.providerId,
                confidence: event.confidence,
              },
            });
            break;

          case 'inference-delta':
            this.sendSSEEvent(res, 'message', {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken: id,
                status: 'streaming',
                delta: event.delta,
                tokenIndex: event.tokenIndex,
              },
            });
            break;

          case 'chunk':
            this.sendSSEEvent(res, 'message', {
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken: id,
                status: 'streaming',
                chunk: chunkIndex++,
                content: event.content,
              },
            });
            break;

          case 'done':
            this.sendSSEEvent(res, 'message', {
              jsonrpc: '2.0',
              id,
              result: {
                content: formatContent(event.result),
                isError: event.result.isError ?? false,
              },
            });
            break;

          case 'error':
            this.sendSSEEvent(res, 'message', {
              jsonrpc: '2.0',
              id,
              error: { code: INTERNAL_ERROR, message: event.error },
            });
            break;
        }
      }
    } catch (err) {
      this.sendSSEEvent(res, 'message', {
        jsonrpc: '2.0',
        id,
        error: { code: INTERNAL_ERROR, message: (err as Error).message },
      });
    }

    res.end();
  }

  // ---------------------------------------------------------------------------
  // Resources methods
  // ---------------------------------------------------------------------------

  private async handleResourcesList(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    const cursor = rpcReq.params?.cursor as string | undefined;
    const result = await this.resourceRegistry.list(cursor);
    sendJsonRpc(res, id, result);
  }

  private async handleResourcesRead(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    const uri = rpcReq.params?.uri as string;
    if (!uri) {
      sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: 'Missing resource URI' });
      return;
    }

    try {
      const content = await this.resourceRegistry.read(uri);
      sendJsonRpc(res, id, { contents: [content] });
    } catch (err) {
      if (err instanceof ResourceNotFoundError) {
        sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: err.message });
      } else {
        sendJsonRpc(res, id, undefined, { code: INTERNAL_ERROR, message: (err as Error).message });
      }
    }
  }

  private async handleResourcesTemplatesList(
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    const templates = await this.resourceRegistry.listTemplates();
    sendJsonRpc(res, id, { resourceTemplates: templates });
  }

  private handleResourcesSubscribe(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    sessionId: string | undefined,
    res: ServerResponse,
  ): void {
    const uri = rpcReq.params?.uri as string;
    if (!uri) {
      sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: 'Missing resource URI' });
      return;
    }

    const subId = this.resourceRegistry.subscribe(uri, (event) => {
      // Notify all SSE clients for this session
      for (const client of this.sseClients.values()) {
        if (!sessionId || client.sessionId === sessionId) {
          this.sendSSEEvent(client.response, 'message', {
            jsonrpc: '2.0',
            method: 'notifications/resources/updated',
            params: { uri: event.uri },
          });
        }
      }
    });

    sendJsonRpc(res, id, { subscriptionId: subId });
  }

  private handleResourcesUnsubscribe(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): void {
    const subId = rpcReq.params?.subscriptionId as string;
    if (!subId) {
      sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: 'Missing subscription ID' });
      return;
    }

    const removed = this.resourceRegistry.unsubscribe(subId);
    sendJsonRpc(res, id, { success: removed });
  }

  // ---------------------------------------------------------------------------
  // Prompts methods
  // ---------------------------------------------------------------------------

  private async handlePromptsList(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    const cursor = rpcReq.params?.cursor as string | undefined;
    const result = await this.promptRegistry.list(cursor);
    sendJsonRpc(res, id, result);
  }

  private async handlePromptsGet(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    const name = rpcReq.params?.name as string;
    if (!name) {
      sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: 'Missing prompt name' });
      return;
    }

    const args = rpcReq.params?.arguments as Record<string, string> | undefined;

    try {
      const result = await this.promptRegistry.get(name, args);
      sendJsonRpc(res, id, result);
    } catch (err) {
      if (err instanceof PromptNotFoundError) {
        sendJsonRpc(res, id, undefined, { code: INVALID_PARAMS, message: err.message });
      } else {
        sendJsonRpc(res, id, undefined, { code: INTERNAL_ERROR, message: (err as Error).message });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Notification broadcasting
  // ---------------------------------------------------------------------------

  /** Broadcast a listChanged notification to all connected SSE clients */
  broadcastListChanged(type: 'tools' | 'resources' | 'prompts'): void {
    const notification = {
      jsonrpc: '2.0',
      method: `notifications/${type}/list_changed`,
    };

    for (const client of this.sseClients.values()) {
      this.sendSSEEvent(client.response, 'message', notification);
    }
  }

  // ---------------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------------

  private getCapabilities(): Record<string, unknown> {
    return {
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {},
    };
  }

  // ---------------------------------------------------------------------------
  // SSE helpers
  // ---------------------------------------------------------------------------

  private sendSSEEvent(res: ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client may have disconnected
    }
  }
}

// ---------------------------------------------------------------------------
// Shared helpers (ported from original serve.ts)
// ---------------------------------------------------------------------------

interface SerializedArtifact {
  version: string;
  stats: { toolCount: number; uniqueSelectorCount: number; providerCount: number; collisionCount: number };
  selectors: Record<string, { canonical: string; parts: string[]; arity: number; vector: number[] }>;
  dispatchTables: Record<string, Record<string, { providerId: string; toolName: string; transportType: string; inputSchema?: Record<string, unknown> }>>;
}

async function loadRuntime(sourcePath: string): Promise<{ runtime: ToolRuntime; artifact: SerializedArtifact }> {
  const embedder = new LocalEmbedder();
  const vectorIndex = new MemoryVectorIndex();

  let artifact: SerializedArtifact;

  if (sourcePath.endsWith('.json') && !isDirectory(sourcePath)) {
    const content = readFileSync(sourcePath, 'utf-8');
    artifact = JSON.parse(content);
  } else {
    const manifests = findManifests(sourcePath);

    if (manifests.length === 0) {
      console.error('No manifests found. Point to a manifest directory or compiled artifact.');
      process.exit(1);
    }

    const compiler = new ToolCompiler(embedder, vectorIndex);
    const result = await compiler.compile(manifests);
    artifact = buildArtifact(result, manifests);
  }

  const runtime = new ToolRuntime(vectorIndex, embedder);

  for (const [providerId, methods] of Object.entries(artifact.dispatchTables)) {
    const toolClass = new ToolClass(providerId);

    for (const [canonical, imp] of Object.entries(methods as Record<string, { providerId: string; toolName: string; transportType: string; inputSchema?: Record<string, unknown> }>)) {
      const selectorData = artifact.selectors[canonical];
      if (!selectorData) continue;

      const vector = new Float32Array(selectorData.vector);
      const selector = runtime.selectorTable.intern(vector, canonical);

      const inputSchema = imp.inputSchema ?? { type: 'object' };

      const proxy = new ToolProxy(
        imp.providerId,
        imp.toolName,
        imp.transportType as 'mcp' | 'rest' | 'local' | 'grpc',
        async () => ({
          name: imp.toolName,
          description: canonical,
          inputSchema: { type: 'object', ...inputSchema },
          arguments: [],
        }),
        { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
      );

      toolClass.addMethod(selector, proxy);
    }

    runtime.registerClass(toolClass);
  }

  return { runtime, artifact };
}

function findManifests(dir: string): ProviderManifest[] {
  const manifests: ProviderManifest[] = [];

  function walk(d: string) {
    try {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        const stat = statSync(full);
        if (stat.isFile() && entry.endsWith('.json')) {
          try {
            manifests.push(JSON.parse(readFileSync(full, 'utf-8')));
          } catch { /* skip invalid */ }
        } else if (stat.isDirectory()) {
          walk(full);
        }
      }
    } catch { /* directory might not exist */ }
  }

  walk(dir);
  return manifests;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function buildArtifact(result: CompilationResult, manifests: ProviderManifest[]): SerializedArtifact {
  // Build tool schema index from manifests
  const schemaIndex: Map<string, Record<string, unknown>> = new Map();
  for (const manifest of manifests) {
    for (const tool of manifest.tools) {
      schemaIndex.set(tool.name, tool.inputSchema as unknown as Record<string, unknown>);
    }
  }

  const selectors: SerializedArtifact['selectors'] = {};
  for (const [key, sel] of result.selectors) {
    selectors[key] = {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      vector: Array.from(sel.vector),
    };
  }

  const dispatchTables: SerializedArtifact['dispatchTables'] = {};
  for (const [providerId, table] of result.dispatchTables) {
    const methods: Record<string, { providerId: string; toolName: string; transportType: string; inputSchema?: Record<string, unknown> }> = {};
    for (const [canonical, imp] of table) {
      methods[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        transportType: imp.transportType,
        inputSchema: schemaIndex.get(imp.toolName),
      };
    }
    dispatchTables[providerId] = methods;
  }

  return {
    version: '0.1.0',
    stats: {
      toolCount: result.toolCount,
      uniqueSelectorCount: result.uniqueSelectorCount,
      providerCount: result.dispatchTables.size,
      collisionCount: result.collisions.length,
    },
    selectors,
    dispatchTables,
  };
}

function buildToolList(artifact: SerializedArtifact): object[] {
  const tools: object[] = [];
  for (const [_providerId, methods] of Object.entries(artifact.dispatchTables)) {
    for (const [canonical, imp] of Object.entries(methods)) {
      const inputSchema = imp.inputSchema ?? { type: 'object', properties: {} };
      tools.push({
        name: imp.toolName,
        description: `${canonical} [${imp.providerId}]`,
        inputSchema,
      });
    }
  }
  return tools;
}

function formatContent(result: ToolResult): Array<{ type: string; text: string }> {
  const text = typeof result.content === 'string'
    ? result.content
    : JSON.stringify(result.content);
  return [{ type: 'text', text }];
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJsonRpc(
  res: ServerResponse,
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
): void {
  const body: JsonRpcResponse = { jsonrpc: '2.0', id };
  if (error) body.error = error;
  else body.result = result;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
