/**
 * MCPServer — production-grade MCP server for the CLI `serve` command.
 *
 * Composes extracted modules rather than inlining concerns:
 *   - artifact.ts    — compiled tool loading & serialization
 *   - session-store  — SQLite session persistence
 *   - oauth          — OAuth 2.1 token management
 *   - resources      — resource registry & handlers
 *   - prompts        — prompt registry & templates
 *   - rate-limiter   — per-client sliding-window rate limiting
 *   - audit-log      — in-memory request audit trail
 *
 * HTTP routing and JSON-RPC dispatch live here as the thin
 * orchestration layer that wires everything together.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import type { ToolRuntime } from '../runtime/runtime.js';
import { SessionStore, type MCPSession } from './session-store.js';
import { OAuthManager } from './oauth.js';
import { ResourceRegistry, ResourceNotFoundError } from './resources.js';
import { PromptRegistry, PromptNotFoundError } from './prompts.js';
import { RateLimiter } from './rate-limiter.js';
import { AuditLog } from './audit-log.js';
import {
  loadRuntime,
  buildToolList,
  formatContent,
  type SerializedArtifact,
} from './artifact.js';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'smallchat';
const SERVER_VERSION = '0.4.0';

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
}

// ---------------------------------------------------------------------------
// JSON-RPC types (minimal, used only for request/response shaping)
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
  private readonly sessionStore: SessionStore;
  private readonly oauthManager: OAuthManager;
  private readonly resourceRegistry: ResourceRegistry;
  private readonly promptRegistry: PromptRegistry;
  private readonly rateLimiter: RateLimiter;
  private readonly auditLog: AuditLog;
  private readonly sseClients = new Map<string, SSEClient>();
  private readonly config: MCPServerConfig;
  private sseCounter = 0;

  constructor(config: MCPServerConfig) {
    this.config = config;
    this.oauthManager = new OAuthManager();
    this.resourceRegistry = new ResourceRegistry();
    this.promptRegistry = new PromptRegistry();
    this.rateLimiter = new RateLimiter(config.rateLimitRPM ?? 600);
    this.auditLog = new AuditLog();
    this.sessionStore = new SessionStore(config.dbPath ?? 'smallchat.db');
  }

  get resources(): ResourceRegistry { return this.resourceRegistry; }
  get prompts(): PromptRegistry { return this.promptRegistry; }
  get oauth(): OAuthManager { return this.oauthManager; }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const { runtime, artifact } = await loadRuntime(this.config.sourcePath);
    this.runtime = runtime;
    this.artifact = artifact;

    const ttl = this.config.sessionTTLMs ?? 24 * 60 * 60 * 1000;
    this.sessionStore.prune(ttl);

    console.log(`  ${artifact.stats.toolCount} tools across ${artifact.stats.providerCount} providers`);
    console.log(`  ${this.sessionStore.count()} active sessions`);

    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        console.log(`\nsmallchat MCP server listening on http://${this.config.host}:${this.config.port}`);
        console.log(`  POST /                    JSON-RPC 2.0 (all MCP methods)`);
        console.log(`  GET  /.well-known/mcp.json  Discovery endpoint`);
        console.log(`  GET  /sse                 SSE event stream`);
        console.log(`  GET  /health              Health check`);
        console.log(`  POST /oauth/token         OAuth 2.1 token endpoint`);
        console.log(`\nMCP Protocol Version: ${MCP_PROTOCOL_VERSION}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients.values()) {
      client.response.end();
    }
    this.sseClients.clear();
    this.sessionStore.close();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // -------------------------------------------------------------------------
  // HTTP request router
  // -------------------------------------------------------------------------

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (req.method === 'GET') {
      if (url === '/.well-known/mcp.json') return this.handleDiscovery(res);
      if (url === '/health')               return this.handleHealth(res);
      if (url === '/sse')                  return this.handleSSE(req, res);
    }

    if (req.method === 'POST' && url === '/oauth/token') {
      return this.handleOAuthToken(req, res);
    }

    if (req.method === 'POST' && (url === '/' || url === '/rpc')) {
      return this.handleJsonRpc(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // -------------------------------------------------------------------------
  // GET endpoints
  // -------------------------------------------------------------------------

  private handleDiscovery(res: ServerResponse): void {
    sendJson(res, 200, {
      mcpVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: getCapabilities(),
      endpoints: { jsonrpc: '/', sse: '/sse', health: '/health', oauth: '/oauth/token' },
    });
  }

  private handleHealth(res: ServerResponse): void {
    sendJson(res, 200, {
      status: 'ok',
      version: SERVER_VERSION,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: this.artifact?.stats.toolCount ?? 0,
      providers: this.artifact?.stats.providerCount ?? 0,
      sessions: this.sessionStore.count(),
      sseClients: this.sseClients.size,
    });
  }

  private handleSSE(req: IncomingMessage, res: ServerResponse): void {
    const clientId = `sse_${++this.sseCounter}`;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    sendSSE(res, 'connected', { clientId, timestamp: Date.now(), sessionId });
    this.sseClients.set(clientId, { id: clientId, response: res, sessionId });

    const keepAlive = setInterval(() => { res.write(': keepalive\n\n'); }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      this.sseClients.delete(clientId);
    });
  }

  // -------------------------------------------------------------------------
  // POST /oauth/token
  // -------------------------------------------------------------------------

  private async handleOAuthToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let params: Record<string, string>;

    try {
      params = req.headers['content-type']?.includes('application/json')
        ? JSON.parse(body)
        : Object.fromEntries(new URLSearchParams(body));
    } catch {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }

    if (params.grant_type === 'client_credentials') {
      const token = this.oauthManager.issueToken(params.client_id, params.client_secret, params.scope?.split(' '));
      if (!token) { sendJson(res, 401, { error: 'invalid_client' }); return; }
      sendJson(res, 200, { access_token: token.accessToken, token_type: token.tokenType, expires_in: token.expiresIn, scope: token.scope, refresh_token: token.refreshToken });
      return;
    }

    if (params.grant_type === 'refresh_token') {
      const token = this.oauthManager.refreshAccessToken(params.refresh_token);
      if (!token) { sendJson(res, 401, { error: 'invalid_grant' }); return; }
      sendJson(res, 200, { access_token: token.accessToken, token_type: token.tokenType, expires_in: token.expiresIn, scope: token.scope, refresh_token: token.refreshToken });
      return;
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  // -------------------------------------------------------------------------
  // POST / — JSON-RPC 2.0
  // -------------------------------------------------------------------------

  private async handleJsonRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const body = await readBody(req);
    let rpcReq: JsonRpcRequest;

    try {
      rpcReq = JSON.parse(body);
    } catch {
      sendRpcError(res, null, PARSE_ERROR, 'Parse error');
      return;
    }

    if (rpcReq.jsonrpc !== '2.0') {
      sendRpcError(res, null, INVALID_REQUEST, 'Invalid JSON-RPC version');
      return;
    }

    const id = rpcReq.id ?? null;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Auth guard
    if (this.config.enableAuth) {
      const auth = this.oauthManager.extractBearerToken(req.headers.authorization);
      if (!auth.active && rpcReq.method !== 'initialize') {
        sendRpcError(res, id, -32000, 'Authentication required');
        return;
      }
    }

    // Rate limit guard
    if (this.config.enableRateLimit) {
      const clientKey = sessionId ?? req.socket.remoteAddress ?? 'unknown';
      if (!this.rateLimiter.check(clientKey)) {
        sendRpcError(res, id, -32000, 'Rate limit exceeded');
        return;
      }
    }

    // Touch session
    if (sessionId) this.sessionStore.touch(sessionId);

    const wantsStream = req.headers.accept?.includes('text/event-stream');

    try {
      await this.dispatch(rpcReq, id, sessionId, wantsStream ?? false, res);
    } catch (err) {
      sendRpcError(res, id, INTERNAL_ERROR, (err as Error).message);
    }

    // Audit trail
    if (this.config.enableAudit) {
      this.auditLog.log({
        timestamp: new Date().toISOString(),
        method: rpcReq.method,
        sessionId,
        success: true,
        durationMs: Date.now() - startTime,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Method dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    sessionId: string | undefined,
    wantsStream: boolean,
    res: ServerResponse,
  ): Promise<void> {
    switch (rpcReq.method) {
      case 'initialize':              return this.rpcInitialize(rpcReq, id, res);
      case 'ping':                    return void sendRpcOk(res, id, {});
      case 'shutdown':                return this.rpcShutdown(id, sessionId, res);
      case 'notifications/initialized':
        if (id === null) return;
        return void sendRpcOk(res, id, {});

      case 'tools/list':              return this.rpcToolsList(rpcReq, id, res);
      case 'tools/call':              return this.rpcToolsCall(rpcReq, id, wantsStream, res);

      case 'resources/list':          return this.rpcResourcesList(rpcReq, id, res);
      case 'resources/read':          return this.rpcResourcesRead(rpcReq, id, res);
      case 'resources/templates/list':return this.rpcResourcesTemplatesList(id, res);
      case 'resources/subscribe':     return this.rpcResourcesSubscribe(rpcReq, id, sessionId, res);
      case 'resources/unsubscribe':   return this.rpcResourcesUnsubscribe(rpcReq, id, res);

      case 'prompts/list':            return this.rpcPromptsList(rpcReq, id, res);
      case 'prompts/get':             return this.rpcPromptsGet(rpcReq, id, res);

      default:
        sendRpcError(res, id, METHOD_NOT_FOUND, `Unknown method: ${rpcReq.method}`);
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  private rpcInitialize(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): void {
    const clientInfo = rpcReq.params?.clientInfo as Record<string, unknown> | undefined;
    const requestedVersion = rpcReq.params?.protocolVersion as string | undefined;

    const session = this.sessionStore.create({
      protocolVersion: requestedVersion ?? MCP_PROTOCOL_VERSION,
      clientInfo: clientInfo ?? {},
    });

    res.setHeader('Mcp-Session-Id', session.id);
    sendRpcOk(res, id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: getCapabilities(),
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      sessionId: session.id,
    });
  }

  private rpcShutdown(id: string | number | null, sessionId: string | undefined, res: ServerResponse): void {
    if (sessionId) this.sessionStore.delete(sessionId);
    sendRpcOk(res, id, { status: 'shutdown' });
  }

  // ---- Tools --------------------------------------------------------------

  private rpcToolsList(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): void {
    if (!this.artifact) { sendRpcOk(res, id, { tools: [] }); return; }

    const allTools = buildToolList(this.artifact);
    const cursor = rpcReq.params?.cursor as string | undefined;
    const pageSize = 100;
    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const page = allTools.slice(startIndex, startIndex + pageSize);
    const nextCursor = startIndex + pageSize < allTools.length ? String(startIndex + pageSize) : undefined;

    sendRpcOk(res, id, { tools: page, nextCursor });
  }

  private async rpcToolsCall(
    rpcReq: JsonRpcRequest,
    id: string | number | null,
    wantsStream: boolean,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.runtime) {
      sendRpcError(res, id, INTERNAL_ERROR, 'Runtime not initialized');
      return;
    }

    const toolName = rpcReq.params?.name as string;
    const args = (rpcReq.params?.arguments ?? {}) as Record<string, unknown>;

    if (!toolName) {
      sendRpcError(res, id, INVALID_PARAMS, 'Missing tool name');
      return;
    }

    if (wantsStream) {
      return this.rpcToolsCallStreaming(toolName, args, id, res);
    }

    try {
      const result = await this.runtime.dispatch(toolName, args);
      const response: Record<string, unknown> = {
        content: formatContent(result),
        isError: result.isError ?? false,
      };
      // 0.4.0: Surface refinement protocol as a distinct result type
      if (result.refinement) {
        response.refinement = result.refinement;
      }
      // 0.4.0: Include confidence tier in response metadata
      if (result.metadata?.tier) {
        response.confidence = result.metadata.tier;
      }
      sendRpcOk(res, id, response);
    } catch (err) {
      sendRpcError(res, id, INTERNAL_ERROR, (err as Error).message);
    }
  }

  private async rpcToolsCallStreaming(
    toolName: string,
    args: Record<string, unknown>,
    id: string | number | null,
    res: ServerResponse,
  ): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

    sendSSE(res, 'message', {
      jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: id, progress: 0, total: 1, status: 'started', tool: toolName },
    });

    try {
      let chunkIndex = 0;
      for await (const event of this.runtime!.dispatchStream(toolName, args)) {
        switch (event.type) {
          case 'tool-start':
            sendSSE(res, 'message', {
              jsonrpc: '2.0', method: 'notifications/progress',
              params: { progressToken: id, progress: 0, total: 1, status: 'executing', tool: event.toolName, provider: event.providerId, confidence: event.confidence },
            });
            break;
          case 'inference-delta':
            sendSSE(res, 'message', {
              jsonrpc: '2.0', method: 'notifications/progress',
              params: { progressToken: id, status: 'streaming', delta: event.delta, tokenIndex: event.tokenIndex },
            });
            break;
          case 'chunk':
            sendSSE(res, 'message', {
              jsonrpc: '2.0', method: 'notifications/progress',
              params: { progressToken: id, status: 'streaming', chunk: chunkIndex++, content: event.content },
            });
            break;
          case 'done':
            sendSSE(res, 'message', {
              jsonrpc: '2.0', id, result: { content: formatContent(event.result), isError: event.result.isError ?? false },
            });
            break;
          case 'error':
            sendSSE(res, 'message', {
              jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: event.error },
            });
            break;
        }
      }
    } catch (err) {
      sendSSE(res, 'message', {
        jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: (err as Error).message },
      });
    }

    res.end();
  }

  // ---- Resources ----------------------------------------------------------

  private async rpcResourcesList(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): Promise<void> {
    const cursor = rpcReq.params?.cursor as string | undefined;
    const result = await this.resourceRegistry.list(cursor);
    sendRpcOk(res, id, result);
  }

  private async rpcResourcesRead(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): Promise<void> {
    const uri = rpcReq.params?.uri as string;
    if (!uri) { sendRpcError(res, id, INVALID_PARAMS, 'Missing resource URI'); return; }

    try {
      const content = await this.resourceRegistry.read(uri);
      sendRpcOk(res, id, { contents: [content] });
    } catch (err) {
      if (err instanceof ResourceNotFoundError) {
        sendRpcError(res, id, INVALID_PARAMS, err.message);
      } else {
        sendRpcError(res, id, INTERNAL_ERROR, (err as Error).message);
      }
    }
  }

  private async rpcResourcesTemplatesList(id: string | number | null, res: ServerResponse): Promise<void> {
    const templates = await this.resourceRegistry.listTemplates();
    sendRpcOk(res, id, { resourceTemplates: templates });
  }

  private rpcResourcesSubscribe(
    rpcReq: JsonRpcRequest, id: string | number | null,
    sessionId: string | undefined, res: ServerResponse,
  ): void {
    const uri = rpcReq.params?.uri as string;
    if (!uri) { sendRpcError(res, id, INVALID_PARAMS, 'Missing resource URI'); return; }

    const subId = this.resourceRegistry.subscribe(uri, (event) => {
      for (const client of this.sseClients.values()) {
        if (!sessionId || client.sessionId === sessionId) {
          sendSSE(client.response, 'message', {
            jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: event.uri },
          });
        }
      }
    });

    sendRpcOk(res, id, { subscriptionId: subId });
  }

  private rpcResourcesUnsubscribe(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): void {
    const subId = rpcReq.params?.subscriptionId as string;
    if (!subId) { sendRpcError(res, id, INVALID_PARAMS, 'Missing subscription ID'); return; }
    sendRpcOk(res, id, { success: this.resourceRegistry.unsubscribe(subId) });
  }

  // ---- Prompts ------------------------------------------------------------

  private async rpcPromptsList(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): Promise<void> {
    const cursor = rpcReq.params?.cursor as string | undefined;
    const result = await this.promptRegistry.list(cursor);
    sendRpcOk(res, id, result);
  }

  private async rpcPromptsGet(rpcReq: JsonRpcRequest, id: string | number | null, res: ServerResponse): Promise<void> {
    const name = rpcReq.params?.name as string;
    if (!name) { sendRpcError(res, id, INVALID_PARAMS, 'Missing prompt name'); return; }

    const args = rpcReq.params?.arguments as Record<string, string> | undefined;

    try {
      const result = await this.promptRegistry.get(name, args);
      sendRpcOk(res, id, result);
    } catch (err) {
      if (err instanceof PromptNotFoundError) {
        sendRpcError(res, id, INVALID_PARAMS, err.message);
      } else {
        sendRpcError(res, id, INTERNAL_ERROR, (err as Error).message);
      }
    }
  }

  // ---- Notifications ------------------------------------------------------

  broadcastListChanged(type: 'tools' | 'resources' | 'prompts'): void {
    const notification = { jsonrpc: '2.0', method: `notifications/${type}/list_changed` };
    for (const client of this.sseClients.values()) {
      sendSSE(client.response, 'message', notification);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (no class state needed)
// ---------------------------------------------------------------------------

function getCapabilities(): Record<string, unknown> {
  return {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true },
    logging: {},
  };
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, status === 200 ? 2 : undefined));
}

function sendRpcOk(res: ServerResponse, id: string | number | null, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result } satisfies JsonRpcResponse);
}

function sendRpcError(res: ServerResponse, id: string | number | null, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } } satisfies JsonRpcResponse);
}

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client may have disconnected
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
