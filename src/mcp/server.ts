/**
 * MCPServer — `smallchat serve`: an exact MCP aggregator built on the
 * official SDK (@modelcontextprotocol/sdk).
 *
 * It serves the tools of a compiled artifact and forwards every
 * tools/call, by exact name, to the upstream MCP server that owns the
 * tool (see UpstreamPool). Nothing is resolved fuzzily on the call path:
 *
 *   - Aggregate mode (default) lists `<providerId>__<toolName>`; with
 *     `provider` it lists one provider's tools under their upstream names,
 *     verbatim (see tool-names.ts). Each tool carries its upstream title,
 *     description, inputSchema, outputSchema and annotations.
 *   - tools/call runs exactly the named tool through runtime.dispatchById
 *     (arguments validated against inputSchema first). An unknown name is
 *     an isError result listing close names; nothing runs.
 *   - Semantic resolution is the separate `smallchat_resolve` tool: it
 *     returns a proposal (tool id, MCP name, tier, candidates, proof
 *     digest) and never executes.
 *   - Results carry a compact proof under _meta['dev.smallchat/resolution'].
 *
 * Transports: stdio (startStdio) or Streamable HTTP on a single endpoint
 * (startHttp / createHttpHandler), with Host/Origin validation, a bearer
 * token, JSON-only bodies and a body cap in front of the SDK transport
 * (see http-guard.ts). Protocol versions are negotiated by the SDK
 * (MCP_PROTOCOL_VERSIONS). Authorization is a bearer token only; acting
 * as an OAuth 2.1 resource server is future work.
 *
 * Programmatic tools and MCP Apps views (registerTool / registerApp), and
 * the resource and prompt registries, are served alongside the artifact.
 */

import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type JSONRPCMessage,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolRuntime, RuntimeOptions } from '../runtime/runtime.js';
import type { ToolResult } from '../core/types.js';
import type { ResolutionOutcome } from '../core/proof.js';
import type { McpTool, McpUiResourceMeta } from './types.js';
import { UIResourceRegistry, type UIContentProvider } from './ui-resources.js';
import { ResourceRegistry, ResourceNotFoundError } from './resources.js';
import { PromptRegistry, PromptNotFoundError } from './prompts.js';
import { RateLimiter } from './rate-limiter.js';
import { AuditLog, type AuditEntry } from './audit-log.js';
import { loadRuntime } from './artifact.js';
import { UpstreamPool, withUpstreamCallContext, type UpstreamPoolOptions } from './upstream.js';
import {
  buildToolTable,
  closeMatches,
  RESOLVE_TOOL_NAME,
  type ToolTable,
} from './tool-names.js';
import { compactResolution, errorResult, RESOLUTION_META_KEY, toCallToolResult } from './results.js';
import {
  bearerMatches,
  ClientAbortedError,
  DEFAULT_MAX_BODY_BYTES,
  defaultAllowedHostnames,
  hostAllowed,
  HttpRejection,
  isInitializeBody,
  isJsonContentType,
  originAllowed,
  parseJsonRpcBody,
  readBody,
} from './http-guard.js';
import { filterContentWithRtk } from '../transport/rtk-transport.js';
import type { RtkConfig } from '../transport/types.js';

export const SERVER_NAME = 'smallchat';
export const SERVER_VERSION = '1.0.0';

/** The single Streamable HTTP endpoint path. */
export const MCP_HTTP_PATH = '/mcp';

const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /**
   * Compiled artifact (.json/.db) or a directory of manifests. Optional:
   * without it the server serves only programmatically registered tools.
   */
  sourcePath?: string;
  /**
   * When `sourcePath` is a manifest directory: keep near-duplicate tools
   * instead of failing to compile (same as `compile --allow-duplicates`).
   */
  allowDuplicates?: boolean;
  /**
   * Runtime options — the dispatch policy smallchat_resolve and
   * dispatchById apply (requireLLMForSubHighDispatch, strict, intentPins,
   * treatUnannotatedAsDestructive, thresholds, argumentCoercion) and an
   * optional LLM verifier.
   */
  runtimeOptions?: RuntimeOptions;
  /**
   * Serve only this provider, with upstream tool names verbatim.
   * Default: every provider, as `<providerId>__<toolName>`.
   */
  provider?: string;
  /** List the smallchat_resolve meta-tool (default true when an artifact is loaded) */
  resolveTool?: boolean;
  /** Upstream MCP client options (timeouts, environment, stderr, headers) */
  upstream?: UpstreamPoolOptions;
  /**
   * RTK (Rust Token Killer) output compression for successful text results.
   * Requires rtk to be installed: https://github.com/johnnyclem-rdc/rtk
   */
  rtkConfig?: RtkConfig;
  /** Audit log (default: an in-memory AuditLog; see `audit`) */
  auditLog?: AuditLog;
  /** Operator messages (default: stderr — stdout is the stdio protocol channel) */
  log?: (line: string) => void;
}

export interface HttpServeOptions {
  /** Port to listen on (0 = any free port) */
  port: number;
  /** Address to bind (default 127.0.0.1) */
  host?: string;
  /**
   * Bearer token every request must carry (`Authorization: Bearer <token>`),
   * or null to serve without one (`--http-insecure`).
   */
  token: string | null;
  /**
   * Hostnames (port-agnostic) accepted in Host. Default: the loopback
   * names for a loopback bind, the bind address otherwise; required for
   * a wildcard bind.
   */
  allowedHosts?: string[];
  /** Origins accepted from browsers (exact match; default none) */
  allowedOrigins?: string[];
  /** Maximum POST body (default 4 MiB) */
  maxBodyBytes?: number;
  /** Requests per minute per session (or per address before a session); off when unset */
  rateLimitRPM?: number;
  /** Concurrent sessions (default 100) */
  maxSessions?: number;
  /** Close sessions idle this long (default 30 min) */
  sessionIdleTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Programmatic tool registration (MCP Apps)
// ---------------------------------------------------------------------------

/** Server-side executor for a programmatically registered tool. */
export type McpToolExecutor = (
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/**
 * McpApp — a tool + its associated MCP Apps interactive view.
 *
 * Passed to MCPServer.registerApp() to atomically register both the tool
 * and its ui:// resource in a single call.
 */
export interface McpApp {
  tool: McpTool;
  /** HTML content for the view (string or async loader for lazy loading) */
  uiContent: UIContentProvider;
  /** Optional custom uri; defaults to ui://<serverName>/<toolName> */
  uiUri?: string;
  /** CSP/permission metadata for the sandboxed iframe */
  uiOptions?: {
    description?: string;
    meta?: McpUiResourceMeta;
  };
  /** Optional server-side executor invoked on tools/call */
  executor?: McpToolExecutor;
}

// ---------------------------------------------------------------------------
// smallchat_resolve
// ---------------------------------------------------------------------------

/** What smallchat_resolve returns (its structuredContent). */
export interface ResolveProposal {
  outcome: ResolutionOutcome;
  intent: string;
  /** Canonical tool id proposed (only when outcome is 'resolved') */
  toolId: string | null;
  /** Name to call it by on this server */
  name: string | null;
  tier: string;
  confidence: number | null;
  reason: string | null;
  candidates: Array<{ toolId: string; name: string | null; score: number; tier: string }>;
  proofDigest: string;
  /** With outcome 'throttled' (RuntimeOptions.rateLimiter): when to ask again */
  retryAfterMs?: number;
}

const RESOLVE_TOOL: Tool = {
  name: RESOLVE_TOOL_NAME,
  title: 'Resolve an intent to a tool',
  description:
    'Propose the tool on this server that matches a natural-language intent. Returns the tool name, ' +
    'canonical id, confidence tier, ranked candidates and a proof digest. It never runs anything: ' +
    'call the proposed tool by name to execute it.',
  inputSchema: {
    type: 'object',
    properties: {
      intent: { type: 'string', minLength: 1, description: 'What you want to do, in plain language' },
      args: { type: 'object', description: 'The arguments you intend to pass, if known (used to choose among overloads)' },
    },
    required: ['intent'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: ['resolved', 'needs-disambiguation', 'unresolved', 'throttled'] },
      intent: { type: 'string' },
      toolId: { type: ['string', 'null'] },
      name: { type: ['string', 'null'] },
      tier: { type: 'string' },
      confidence: { type: ['number', 'null'] },
      reason: { type: ['string', 'null'] },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            toolId: { type: 'string' },
            name: { type: ['string', 'null'] },
            score: { type: 'number' },
            tier: { type: 'string' },
          },
          required: ['toolId', 'name', 'score', 'tier'],
        },
      },
      proofDigest: { type: 'string' },
      retryAfterMs: { type: 'number', minimum: 0 },
    },
    required: ['outcome', 'intent', 'toolId', 'name', 'tier', 'candidates', 'proofDigest'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

interface Connection {
  id: string;
  kind: 'stdio' | 'http';
  sdk: McpServer;
  transport: Transport;
  /** HTTP session id (assigned at initialize) */
  sessionId?: string;
  remoteAddress?: string;
  /** resources/subscribe: uri → registry subscription id */
  subscriptions: Map<string, string>;
  /** tools/call details for the audit entry, keyed by JSON-RPC request id */
  callDetails: Map<string | number, Pick<AuditEntry, 'toolName' | 'toolId' | 'callDigest'> & { isError?: boolean }>;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// MCPServer
// ---------------------------------------------------------------------------

export class MCPServer {
  private readonly config: MCPServerConfig;
  private readonly log: (line: string) => void;
  private runtime: ToolRuntime | null = null;
  private upstreams: UpstreamPool | null = null;
  private table: ToolTable | null = null;
  private loading: Promise<void> | null = null;

  private readonly connections = new Map<string, Connection>();
  /** HTTP sessions by Mcp-Session-Id */
  private readonly sessions = new Map<string, Connection>();
  private httpServer: HttpServer | null = null;
  private httpOptions: HttpServeOptions | null = null;
  private rateLimiter: RateLimiter | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stdioClosed: Promise<void> | null = null;
  private stopped = false;

  private readonly resourceRegistry = new ResourceRegistry();
  private readonly promptRegistry = new PromptRegistry();
  private readonly auditLog: AuditLog;
  /** Registry for MCP Apps ui:// resources */
  readonly uiResources = new UIResourceRegistry(SERVER_NAME);
  /** Programmatically registered tools (beyond the compiled artifact), keyed by name */
  private readonly registeredTools = new Map<string, { tool: McpTool; executor?: McpToolExecutor }>();

  constructor(config: MCPServerConfig = {}) {
    this.config = config;
    this.log = config.log ?? (line => process.stderr.write(`${line}\n`));
    this.auditLog = config.auditLog ?? new AuditLog();
  }

  get resources(): ResourceRegistry { return this.resourceRegistry; }
  get prompts(): PromptRegistry { return this.promptRegistry; }
  get audit(): AuditLog { return this.auditLog; }
  /** The name table of the loaded artifact (null before load()). */
  get toolTable(): ToolTable | null { return this.table; }
  /** The runtime serving the artifact (null before load() or without an artifact). */
  get toolRuntime(): ToolRuntime | null { return this.runtime; }

  // -------------------------------------------------------------------------
  // Programmatic registration
  // -------------------------------------------------------------------------

  /**
   * Register a tool directly on the server, in addition to the artifact's.
   * The optional executor handles tools/call; without one, calls return an
   * isError result. A name that is already served is refused.
   */
  registerTool(tool: McpTool, executor?: McpToolExecutor): void {
    if (tool.name === RESOLVE_TOOL_NAME || this.table?.byName.has(tool.name)) {
      throw new Error(`Tool name "${tool.name}" is already served`);
    }
    const isNew = !this.registeredTools.has(tool.name);
    this.registeredTools.set(tool.name, { tool, executor });
    if (isNew) this.broadcastListChanged('tools');
  }

  /**
   * Register a tool together with its MCP Apps interactive view: the
   * McpTool (with _meta.ui populated) and its ui:// HTML resource.
   */
  registerApp(app: McpApp): void {
    const uri = this.uiResources.register(app.tool.name, app.uiContent, {
      description: app.uiOptions?.description,
      meta: app.uiOptions?.meta,
      customUri: app.uiUri,
    });

    const toolWithMeta: McpTool = {
      ...app.tool,
      _meta: {
        ...app.tool._meta,
        ui: {
          resourceUri: uri,
          visibility: app.uiOptions?.meta ? ['model', 'app'] : undefined,
        },
      },
    };

    this.registerTool(toolWithMeta, app.executor);
    this.broadcastListChanged('resources');
  }

  /**
   * Register a standalone ui:// resource (without registering a tool).
   * Returns the canonical ui:// URI assigned to this resource.
   */
  registerUIResource(
    toolName: string,
    content: UIContentProvider,
    options?: { description?: string; meta?: McpUiResourceMeta; customUri?: string },
  ): string {
    return this.uiResources.register(toolName, content, options);
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  /**
   * Load the artifact and build the tool name table. Idempotent; the
   * start methods call it. Rejects on any load error (pre-1.0 artifact,
   * embedder mismatch, unknown provider, name clash).
   */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    if (!this.config.sourcePath) return;
    const { runtime, artifact, upstreams } = await loadRuntime(this.config.sourcePath, {
      compilerOptions: { allowDuplicates: this.config.allowDuplicates },
      runtimeOptions: this.config.runtimeOptions,
      providers: this.config.provider !== undefined ? [this.config.provider] : undefined,
      upstream: { log: this.log, ...this.config.upstream },
    });
    const table = buildToolTable(artifact, { provider: this.config.provider });

    const clash = table.entries.find(e => this.registeredTools.has(e.name) || (this.resolveToolEnabled() && e.name === RESOLVE_TOOL_NAME));
    if (clash) {
      await upstreams.close();
      throw new Error(
        `Tool name "${clash.name}" (${clash.toolId}) is already served` +
        (clash.name === RESOLVE_TOOL_NAME ? '; disable the resolve tool (--no-resolve-tool) to serve it' : ''),
      );
    }

    this.runtime = runtime;
    this.upstreams = upstreams;
    this.table = table;

    const mode = this.config.provider !== undefined ? `provider ${this.config.provider}, upstream names` : 'aggregate names <provider>__<tool>';
    this.log(`  ${table.entries.length} tools across ${this.config.provider !== undefined ? 1 : artifact.stats.providerCount} provider(s) (${mode})`);
    for (const skipped of table.skipped) {
      this.log(`  not served: ${skipped.toolId} — ${skipped.reason}`);
    }
    if (this.config.rtkConfig && this.config.rtkConfig.enabled !== false) {
      const level = this.config.rtkConfig.filterLevel ?? 'default';
      const threshold = this.config.rtkConfig.filterThresholdBytes ?? 512;
      this.log(`  RTK compression enabled (level=${level}, threshold=${threshold}B)`);
    }
  }

  private resolveToolEnabled(): boolean {
    return (this.config.resolveTool ?? true) && this.config.sourcePath !== undefined;
  }

  /** Exactly what tools/list returns. */
  listTools(): Tool[] {
    const tools: Tool[] = [];
    for (const { name, tool } of this.table?.entries ?? []) {
      tools.push({
        name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema as Tool['inputSchema'],
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema as Tool['outputSchema'] } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      });
    }
    if (this.resolveToolEnabled() && this.runtime) tools.push(RESOLVE_TOOL);
    for (const { tool } of this.registeredTools.values()) {
      tools.push({
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as Tool['inputSchema'],
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema as Tool['outputSchema'] } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
        ...(tool._meta !== undefined ? { _meta: tool._meta } : {}),
      });
    }
    return tools;
  }

  // -------------------------------------------------------------------------
  // Transports
  // -------------------------------------------------------------------------

  /**
   * Serve one client over stdio (default: this process's stdin/stdout).
   * Resolves once connected; `closed()` resolves when the client goes away.
   */
  async startStdio(stdin: Readable = process.stdin, stdout: Writable = process.stdout): Promise<void> {
    await this.load();
    const transport = new StdioServerTransport(stdin, stdout);
    let onClosed!: () => void;
    this.stdioClosed = new Promise<void>(resolve => { onClosed = resolve; });
    const connection = await this.connect(transport, 'stdio');
    const previous = transport.onclose;
    transport.onclose = () => {
      previous?.();
      this.connections.delete(connection.id);
      this.releaseSubscriptions(connection);
      onClosed();
    };
    // StdioServerTransport does not notice the end of stdin, or a client
    // that went away while we were writing, by itself.
    stdin.once('end', () => { void transport.close(); });
    stdout.on('error', () => { void transport.close(); });
  }

  /** Resolves when the stdio client disconnects (after startStdio). */
  closed(): Promise<void> {
    return this.stdioClosed ?? Promise.resolve();
  }

  /** Serve Streamable HTTP on `MCP_HTTP_PATH`. Resolves with the endpoint URL. */
  async startHttp(options: HttpServeOptions): Promise<{ url: string }> {
    await this.load();
    const handler = this.createHttpHandler(options);
    const host = options.host ?? '127.0.0.1';
    this.httpServer = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(options.port, host, () => {
        this.httpServer!.off('error', reject);
        resolve();
      });
    });
    const address = this.httpServer.address() as AddressInfo;
    const shownHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return { url: `http://${shownHost}:${address.port}${MCP_HTTP_PATH}` };
  }

  /**
   * A Node request listener serving MCP Streamable HTTP at MCP_HTTP_PATH,
   * for embedding in an existing http.Server. Call load() first.
   */
  createHttpHandler(options: HttpServeOptions): RequestListener {
    const allowedHosts = (options.allowedHosts ?? defaultAllowedHostnames(options.host ?? '127.0.0.1'))?.map(h => h.toLowerCase());
    if (!allowedHosts) {
      throw new Error(
        `Binding ${options.host} accepts any Host header; pass the hostnames clients use (--allowed-host) ` +
        'so DNS-rebinding requests can be refused',
      );
    }
    this.httpOptions = { ...options, allowedHosts };
    this.rateLimiter = options.rateLimitRPM ? new RateLimiter(options.rateLimitRPM) : null;
    if (!this.idleTimer) {
      const idleMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_MS;
      this.idleTimer = setInterval(() => this.closeIdleSessions(idleMs), Math.min(idleMs, 60_000));
      this.idleTimer.unref();
    }
    return (req, res) => {
      this.handleHttp(req, res).catch(err => {
        // handleHttp answers every error itself; this is the last resort.
        this.log(`http: ${(err as Error).message}`);
        if (!res.headersSent) sendRpcError(res, 500, ErrorCode.InternalError, 'Internal error');
        else res.destroy();
      });
    };
  }

  /** Stop serving: close every session and upstream client. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const connection of [...this.connections.values()]) {
      await this.closeConnection(connection);
    }
    await this.upstreams?.close();
    if (this.httpServer) {
      const server = this.httpServer;
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  /** Tell every connected client that a list changed. */
  broadcastListChanged(type: 'tools' | 'resources' | 'prompts'): void {
    for (const connection of this.connections.values()) {
      if (!connection.sdk.isConnected()) continue;
      const server = connection.sdk.server;
      const send = type === 'tools'
        ? server.sendToolListChanged()
        : type === 'resources'
          ? server.sendResourceListChanged()
          : server.sendPromptListChanged();
      // A client that went away just misses the notification.
      send.catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const options = this.httpOptions!;
    const started = Date.now();
    const remoteAddress = req.socket.remoteAddress;
    const reject = (status: number, message: string, code: number = -32000, headers: Record<string, string> = {}) => {
      this.audit.log({
        timestamp: new Date().toISOString(), transport: 'http', method: 'http', remoteAddress,
        outcome: 'rejected', httpStatus: status, errorCode: code, error: message, durationMs: Date.now() - started,
      });
      sendRpcError(res, status, code, message, headers);
    };

    const path = (req.url ?? '/').split('?')[0];
    if (path !== MCP_HTTP_PATH) {
      reject(404, `Not found: the MCP endpoint is ${MCP_HTTP_PATH}`);
      return;
    }
    if (!hostAllowed(req.headers.host, options.allowedHosts!)) {
      reject(403, `Forbidden: Host "${req.headers.host ?? ''}" is not allowed`);
      return;
    }
    const origin = req.headers.origin;
    if (!originAllowed(origin, options.allowedOrigins ?? [])) {
      reject(403, `Forbidden: Origin "${origin}" is not allowed`);
      return;
    }
    if (origin !== undefined) setCorsHeaders(res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (options.token !== null && !bearerMatches(req.headers.authorization, options.token)) {
      reject(401, 'Unauthorized: a valid bearer token is required', -32000, {
        'WWW-Authenticate': 'Bearer realm="smallchat", error="invalid_token"',
      });
      return;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (this.rateLimiter) {
      // Only a session the server issued keys its own bucket; anything else
      // shares its peer address's.
      const key = session ? `session:${session.sessionId}` : `addr:${remoteAddress ?? 'unknown'}`;
      if (!this.rateLimiter.check(key)) {
        reject(429, 'Too Many Requests: rate limit exceeded', -32000, { 'Retry-After': '60' });
        return;
      }
    }

    if (sessionId && !session) {
      reject(404, 'Session not found', -32001);
      return;
    }

    if (req.method === 'POST') {
      if (!isJsonContentType(req.headers['content-type'])) {
        reject(415, 'Unsupported Media Type: Content-Type must be application/json');
        return;
      }
      let body: unknown;
      try {
        body = parseJsonRpcBody(await readBody(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES));
      } catch (err) {
        if (err instanceof ClientAbortedError) {
          this.audit.log({
            timestamp: new Date().toISOString(), transport: 'http', method: 'http', remoteAddress, sessionId,
            outcome: 'rejected', error: err.message, durationMs: Date.now() - started,
          });
          res.destroy();
          return;
        }
        if (err instanceof HttpRejection) {
          reject(err.status, err.message, err.rpcCode, err.status === 413 ? { Connection: 'close' } : {});
          return;
        }
        throw err;
      }

      let target = session;
      if (!target) {
        if (!isInitializeBody(body)) {
          reject(400, 'Bad Request: Mcp-Session-Id header is required');
          return;
        }
        if (this.sessions.size + this.pendingSessions >= (options.maxSessions ?? DEFAULT_MAX_SESSIONS)) {
          reject(503, 'Service Unavailable: too many sessions');
          return;
        }
        target = await this.newHttpSession(remoteAddress);
      }
      target.lastSeen = Date.now();
      await (target.transport as StreamableHTTPServerTransport).handleRequest(req, res, body);
      if (!session && !target.sessionId) {
        // initialize failed before a session id was issued
        await this.closeConnection(target);
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!session) {
        reject(400, 'Bad Request: Mcp-Session-Id header is required');
        return;
      }
      session.lastSeen = Date.now();
      await (session.transport as StreamableHTTPServerTransport).handleRequest(req, res);
      return;
    }

    reject(405, 'Method Not Allowed', -32000, { Allow: 'GET, POST, DELETE, OPTIONS' });
  }

  private pendingSessions = 0;

  private async newHttpSession(remoteAddress: string | undefined): Promise<Connection> {
    this.pendingSessions++;
    try {
      let connection!: Connection;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          connection.sessionId = id;
          this.sessions.set(id, connection);
        },
        onsessionclosed: (id) => {
          const closed = this.sessions.get(id);
          if (closed) void this.closeConnection(closed);
        },
      });
      connection = await this.connect(transport, 'http', remoteAddress);
      const previous = transport.onclose;
      transport.onclose = () => {
        previous?.();
        void this.closeConnection(connection);
      };
      return connection;
    } finally {
      this.pendingSessions--;
    }
  }

  private closeIdleSessions(idleMs: number): void {
    const cutoff = Date.now() - idleMs;
    for (const connection of this.sessions.values()) {
      if (connection.lastSeen < cutoff) void this.closeConnection(connection);
    }
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  /** Connect a fresh SDK server for one client over `transport`. */
  private async connect(transport: Transport, kind: 'stdio' | 'http', remoteAddress?: string): Promise<Connection> {
    const sdk = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
          prompts: { listChanged: true },
        },
        instructions: this.instructions(),
      },
    );
    const connection: Connection = {
      id: randomUUID(),
      kind,
      sdk,
      transport,
      remoteAddress,
      subscriptions: new Map(),
      callDetails: new Map(),
      lastSeen: Date.now(),
    };
    this.installHandlers(connection);
    await sdk.connect(transport);
    this.auditTransport(connection);
    this.connections.set(connection.id, connection);
    return connection;
  }

  private async closeConnection(connection: Connection): Promise<void> {
    if (!this.connections.delete(connection.id)) return;
    if (connection.sessionId) this.sessions.delete(connection.sessionId);
    this.releaseSubscriptions(connection);
    try {
      await connection.sdk.close();
    } catch {
      // already closed
    }
  }

  private releaseSubscriptions(connection: Connection): void {
    for (const subscriptionId of connection.subscriptions.values()) {
      this.resourceRegistry.unsubscribe(subscriptionId);
    }
    connection.subscriptions.clear();
  }

  /**
   * Record every JSON-RPC request with its real outcome, observed where
   * messages cross the transport.
   */
  private auditTransport(connection: Connection): void {
    const transport = connection.transport;
    const pending = new Map<string | number, { method: string; started: number }>();
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ('method' in message && 'id' in message) {
        pending.set(message.id, { method: message.method, started: Date.now() });
      } else if ('method' in message && message.method === 'notifications/cancelled') {
        // A cancelled request gets no response; record it as cancelled.
        const requestId = (message.params as { requestId?: string | number } | undefined)?.requestId;
        const request = requestId !== undefined ? pending.get(requestId) : undefined;
        if (request && requestId !== undefined) {
          pending.delete(requestId);
          this.recordRequest(connection, request, requestId, { outcome: 'error', error: 'cancelled by the client' });
        }
      }
      onmessage?.(message, extra);
    };
    const send = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage, options) => {
      if (!('method' in message) && 'id' in message && message.id !== undefined) {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          const error = 'error' in message ? message.error : undefined;
          this.recordRequest(connection, request, message.id, error
            ? { outcome: 'error', errorCode: error.code, error: error.message }
            : { outcome: 'ok' });
        }
      }
      return send(message, options);
    };
  }

  /** Audit one JSON-RPC request (with tools/call details, when recorded). */
  private recordRequest(
    connection: Connection,
    request: { method: string; started: number },
    requestId: string | number,
    result: Pick<AuditEntry, 'outcome' | 'errorCode' | 'error'>,
  ): void {
    const details = connection.callDetails.get(requestId);
    connection.callDetails.delete(requestId);
    this.audit.log({
      timestamp: new Date().toISOString(),
      transport: connection.kind,
      method: request.method,
      requestId,
      ...(connection.sessionId ? { sessionId: connection.sessionId } : {}),
      ...(connection.remoteAddress ? { remoteAddress: connection.remoteAddress } : {}),
      ...result,
      ...(result.outcome === 'ok' && details?.isError ? { outcome: 'error' as const } : {}),
      ...(details?.toolName !== undefined ? { toolName: details.toolName } : {}),
      ...(details?.toolId !== undefined ? { toolId: details.toolId } : {}),
      ...(details?.callDigest !== undefined ? { callDigest: details.callDigest } : {}),
      durationMs: Date.now() - request.started,
    });
  }

  private instructions(): string | undefined {
    if (!this.table) return undefined;
    const naming = this.table.mode === 'aggregate'
      ? 'Tools are named <provider>__<tool> and run exactly the named upstream tool.'
      : `Tools are the upstream tools of provider "${this.table.mode.provider}", under their own names.`;
    const resolve = this.resolveToolEnabled()
      ? ` ${RESOLVE_TOOL_NAME} proposes a tool for a plain-language intent without running it.`
      : '';
    return `${naming}${resolve}`;
  }

  // -------------------------------------------------------------------------
  // MCP handlers
  // -------------------------------------------------------------------------

  private installHandlers(connection: Connection): void {
    // Tools are served through the low-level handlers: upstream schemas
    // are JSON Schema documents, passed through verbatim.
    const server = connection.sdk.server;

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => this.callTool(request, extra, connection));

    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      const cursor = request.params?.cursor;
      const result = await this.resourceRegistry.list(cursor);
      // ui:// resources are appended to the first page only.
      const ui = cursor ? [] : this.uiResources.list();
      return { ...result, resources: [...result.resources, ...ui] };
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      if (uri.startsWith('ui://')) {
        const content = await this.uiResources.read(uri);
        if (!content) throw new McpError(-32002, `Resource not found: ${uri}`, { uri });
        return { contents: [content] };
      }
      try {
        return { contents: [await this.resourceRegistry.read(uri)] };
      } catch (err) {
        if (err instanceof ResourceNotFoundError) throw new McpError(-32002, err.message, { uri });
        throw err;
      }
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: await this.resourceRegistry.listTemplates(),
    }));
    server.setRequestHandler(SubscribeRequestSchema, (request) => {
      const uri = request.params.uri;
      if (!connection.subscriptions.has(uri)) {
        const subscriptionId = this.resourceRegistry.subscribe(uri, (event) => {
          void connection.sdk.server.sendResourceUpdated({ uri: event.uri }).catch(() => {});
        });
        connection.subscriptions.set(uri, subscriptionId);
      }
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      const subscriptionId = connection.subscriptions.get(request.params.uri);
      if (subscriptionId) {
        this.resourceRegistry.unsubscribe(subscriptionId);
        connection.subscriptions.delete(request.params.uri);
      }
      return {};
    });

    server.setRequestHandler(ListPromptsRequestSchema, async (request) => this.promptRegistry.list(request.params?.cursor));
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      try {
        return await this.promptRegistry.get(request.params.name, request.params.arguments) as never;
      } catch (err) {
        if (err instanceof PromptNotFoundError) throw new McpError(ErrorCode.InvalidParams, err.message);
        throw err;
      }
    });
  }

  private async callTool(
    request: CallToolRequest,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    connection: Connection,
  ): Promise<CallToolResult> {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const details: Pick<AuditEntry, 'toolName' | 'toolId' | 'callDigest'> & { isError?: boolean } = { toolName: name };
    connection.callDetails.set(extra.requestId, details);

    let result: CallToolResult;
    if (this.resolveToolEnabled() && this.runtime && name === RESOLVE_TOOL_NAME) {
      result = await this.resolveIntent(args);
    } else if (this.registeredTools.has(name)) {
      const { executor } = this.registeredTools.get(name)!;
      result = executor
        ? toCallToolResult(await executor(args))
        : errorResult(`Tool "${name}" has no server-side implementation; nothing was executed.`);
    } else {
      const entry = this.table?.byName.get(name);
      if (!entry || !this.runtime) {
        result = this.unknownTool(name);
      } else {
        const progressToken = request.params._meta?.progressToken;
        const onprogress = progressToken === undefined
          ? undefined
          : (progress: { progress: number; total?: number; message?: string }) => {
            void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
          };
        const runtime = this.runtime;
        try {
          const ran: ToolResult = await withUpstreamCallContext(
            { signal: extra.signal, ...(onprogress ? { onprogress } : {}) },
            () => runtime.dispatchById(entry.toolId, args),
          );
          const proof = ran.metadata?.proof as { ran?: string | null; callDigest?: string | null } | undefined;
          if (proof?.ran) details.toolId = proof.ran;
          if (proof?.callDigest) details.callDigest = proof.callDigest;
          result = await this.applyRtk(toCallToolResult(ran));
        } catch (err) {
          result = errorResult(`${entry.name} failed: ${(err as Error).message}`);
        }
      }
    }
    details.isError = result.isError === true;
    return result;
  }

  private unknownTool(name: string): CallToolResult {
    const names = this.listTools().map(t => t.name);
    const close = closeMatches(name, names);
    const hint = close.length > 0 ? ` Close names: ${close.join(', ')}.` : '';
    const resolve = this.resolveToolEnabled() && this.runtime
      ? ` To find a tool from a description, call ${RESOLVE_TOOL_NAME}.`
      : '';
    return errorResult(`Unknown tool "${name}"; nothing was executed.${hint}${resolve}`);
  }

  private async resolveIntent(args: Record<string, unknown>): Promise<CallToolResult> {
    const intent = args.intent;
    if (typeof intent !== 'string' || intent.trim().length === 0) {
      return errorResult(`${RESOLVE_TOOL_NAME} needs an "intent" string.`);
    }
    const callArgs = args.args;
    if (callArgs !== undefined && (typeof callArgs !== 'object' || callArgs === null || Array.isArray(callArgs))) {
      return errorResult(`${RESOLVE_TOOL_NAME}: "args" must be an object.`);
    }

    const resolution = await this.runtime!.resolve(intent, callArgs ? { args: callArgs as Record<string, unknown> } : undefined);
    const nameOf = (toolId: string) => this.table?.byToolId.get(toolId)?.name ?? null;
    const proposal: ResolveProposal = {
      outcome: resolution.outcome,
      intent,
      toolId: resolution.chosen ?? null,
      name: resolution.chosen ? nameOf(resolution.chosen) : null,
      tier: resolution.tier,
      confidence: resolution.confidence ?? null,
      reason: resolution.reason ?? null,
      candidates: resolution.candidates.slice(0, 5).map(c => ({ toolId: c.toolId, name: nameOf(c.toolId), score: c.score, tier: c.tier })),
      proofDigest: resolution.proof.proofDigest,
      ...(resolution.retryAfterMs !== undefined ? { retryAfterMs: resolution.retryAfterMs } : {}),
    };

    const summary = proposal.outcome === 'resolved'
      ? `Proposed ${proposal.name ?? proposal.toolId} (${proposal.toolId}, tier ${proposal.tier}). Nothing was executed; call ${proposal.name ?? proposal.toolId} to run it.`
      : `No single tool proposed (${proposal.outcome}${proposal.reason ? `: ${proposal.reason}` : ''}). Nothing was executed.` +
        (proposal.candidates.length > 0 ? ` Candidates: ${proposal.candidates.map(c => c.name ?? c.toolId).join(', ')}.` : '');

    return {
      content: [{ type: 'text', text: `${summary}\n${JSON.stringify(proposal)}` }],
      structuredContent: proposal as unknown as Record<string, unknown>,
      _meta: { [RESOLUTION_META_KEY]: compactResolution(resolution.proof) },
    };
  }

  private async applyRtk(result: CallToolResult): Promise<CallToolResult> {
    const config = this.config.rtkConfig;
    if (!config || config.enabled === false || result.isError) return result;
    let savedTotal = 0;
    let filtered = false;
    const content = await Promise.all(result.content.map(async block => {
      if (block.type !== 'text') return block;
      const { compressed, savedPct, enabled } = await filterContentWithRtk(block.text, config);
      if (!enabled) return block;
      filtered = true;
      savedTotal = Math.max(savedTotal, savedPct);
      return { ...block, text: compressed };
    }));
    if (!filtered) return result;
    return { ...result, content, _meta: { ...result._meta, 'dev.smallchat/rtk': { savedPct: savedTotal } } };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setCorsHeaders(res: ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}
