/**
 * ChannelServer — stdio MCP server that acts as a Claude Code channel.
 *
 * Design decision: We add a new "smallchat channel" CLI command that runs a
 * stdio MCP server (for Claude Code to spawn as a subprocess), with an optional
 * HTTP bridge for receiving webhook events and serving SSE for outbound visibility.
 *
 * Justification: Claude Code spawns channel servers over stdio, and a channel
 * speaks the claude/channel extension (notifications, permission relay)
 * rather than serving a compiled toolkit as "smallchat serve" does, so it
 * gets its own small stdio server.
 *
 * Protocol:
 *   stdin/stdout  — JSON-RPC 2.0 (newline-delimited) with MCP host (Claude Code)
 *   HTTP bridge   — optional local HTTP server for inbound webhooks + SSE outbound
 *
 * HTTP bridge security: every request except GET /health must present a
 * credential (`X-Channel-Secret: <secret>` or `Authorization: Bearer
 * <secret>`), and the bridge will not start without one. The credential
 * decides who the sender is: the shared secret authenticates as
 * httpBridgeSecretIdentity ("bridge"), each per-sender token as its
 * identity. Body `sender` and `channel` fields are ignored — events carry
 * the authenticated identity and the configured channel name. Permission
 * verdicts are accepted only from identities in permissionApprovers, and
 * each verdict is reported with its approver. The Host header must name an
 * allowed host (DNS rebinding), a request with an Origin must match
 * httpBridgeCorsOrigin, and POST bodies must be JSON objects within the
 * size limit; anything else gets a 4xx and never reaches Claude Code.
 */

import { createInterface, type Interface } from 'node:readline';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  ChannelEvent,
  ChannelServerConfig,
  PermissionRequest,
  PermissionVerdict,
  RecordedPermissionVerdict,
} from './types.js';
import { ClaudeCodeChannelAdapter } from './adapter.js';
import { SenderGate } from './sender-gate.js';
import { filterMetaKeys, validatePayloadSize, parsePermissionReply } from './utils.js';
import { PACKAGE_VERSION } from '../core/version.js';
import {
  ClientAbortedError,
  HttpRejection,
  defaultAllowedHostnames,
  hostAllowed,
  isJsonContentType,
  readBody,
} from '../mcp/http-guard.js';

/** Identity of requests that present the shared bridge secret, unless configured. */
export const DEFAULT_BRIDGE_SECRET_IDENTITY = 'bridge';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// JSON-RPC types (stdio protocol)
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// ChannelServer
// ---------------------------------------------------------------------------

export class ChannelServer extends EventEmitter {
  private config: ChannelServerConfig;
  private adapter: ClaudeCodeChannelAdapter;
  private senderGate: SenderGate;
  private rl: Interface | null = null;
  private httpServer: Server | null = null;
  /** Open /sse streams and the identity each one authenticated as */
  private sseClients: Map<ServerResponse, string> = new Map();
  private initialized = false;
  private nextId = 1;
  private pendingPermissions: Map<string, PermissionRequest> = new Map();
  /** SHA-256 of each bridge credential, with the identity it authenticates */
  private credentials: Array<{ identity: string; digest: Buffer }> = [];
  private approvers: Set<string>;
  private allowedHosts: string[] = [];

  constructor(config: ChannelServerConfig) {
    super();
    this.config = config;
    this.adapter = new ClaudeCodeChannelAdapter({
      maxPayloadBytes: config.maxPayloadSize,
    });
    this.senderGate = new SenderGate({
      allowlist: config.senderAllowlist,
      allowlistFile: config.senderAllowlistFile,
    });
    this.approvers = new Set((config.permissionApprovers ?? []).map(normalizeIdentity).filter(Boolean));
  }

  /**
   * Start the stdio MCP server (and optional HTTP bridge).
   */
  async start(): Promise<void> {
    // Refuse an unauthenticated bridge before touching stdio.
    if (this.config.httpBridge) this.prepareHttpBridge();

    // Set up stdio JSON-RPC reader
    this.rl = createInterface({ input: process.stdin, terminal: false });
    this.rl.on('line', (line) => this.handleStdioLine(line));

    // Handle stdin close
    process.stdin.on('end', () => {
      this.shutdown();
    });

    // Start HTTP bridge if configured
    if (this.config.httpBridge) {
      await this.startHttpBridge();
    }

    this.emit('ready');
  }

  /**
   * Shut down the server and clean up.
   */
  shutdown(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.httpServer) {
      // Close SSE clients
      for (const client of this.sseClients.keys()) {
        try { client.end(); } catch { /* ignore */ }
      }
      this.sseClients.clear();
      this.httpServer.close();
      this.httpServer.closeAllConnections();
      this.httpServer = null;
    }

    this.senderGate.destroy();
    this.emit('shutdown');
  }

  /**
   * Inject an inbound channel event (from HTTP bridge or programmatic use).
   * Validates sender gating and payload size, then emits the MCP notification.
   */
  injectEvent(event: ChannelEvent): boolean {
    // Sender gating
    if (this.senderGate.enabled && !this.senderGate.check(event.sender)) {
      this.emit('sender-rejected', event.sender);
      return false;
    }

    // Payload size check
    const sizeCheck = validatePayloadSize(
      event.content,
      this.config.maxPayloadSize,
    );
    if (!sizeCheck.valid) {
      this.emit('payload-too-large', sizeCheck);
      return false;
    }

    // Filter meta keys (reserved ones included: a body cannot set sender)
    const filteredMeta = filterMetaKeys(event.meta);

    const cleanEvent: ChannelEvent = {
      channel: event.channel || this.config.channelName,
      content: event.content,
      meta: filteredMeta,
      sender: event.sender,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    // Ingest into adapter
    this.adapter.ingest(cleanEvent);

    // Emit MCP notification over stdio. meta.sender is stamped here with the
    // event's sender — for bridge events the identity of the credential that
    // posted it — so Claude Code sees who posted, not who the body claims.
    this.sendNotification('notifications/claude/channel', {
      channel: cleanEvent.channel,
      content: cleanEvent.content,
      meta: cleanEvent.sender ? { ...cleanEvent.meta, sender: cleanEvent.sender } : cleanEvent.meta,
    });

    // Broadcast to SSE clients
    this.broadcastSSE('channel-event', cleanEvent);

    this.emit('event-injected', cleanEvent);
    return true;
  }

  /**
   * Send a permission verdict back to the host. `approver` is who decided;
   * it is part of the `permission-verdict` event, never of the notification.
   */
  sendPermissionVerdict(verdict: PermissionVerdict, approver?: string): void {
    this.sendNotification('notifications/claude/channel/permission', {
      request_id: verdict.request_id,
      behavior: verdict.behavior,
    });
    this.pendingPermissions.delete(verdict.request_id);
    const recorded: RecordedPermissionVerdict = {
      request_id: verdict.request_id,
      behavior: verdict.behavior,
      ...(approver !== undefined ? { approver } : {}),
    };
    this.emit('permission-verdict', recorded);
  }

  /** The bridge's bound address once it listens (useful with httpBridgePort: 0). */
  get httpBridgeAddress(): { host: string; port: number } | null {
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string') return null;
    return { host: (address as AddressInfo).address, port: (address as AddressInfo).port };
  }

  /**
   * Get the adapter for message serialization.
   */
  getAdapter(): ClaudeCodeChannelAdapter {
    return this.adapter;
  }

  /**
   * Get the sender gate for programmatic access.
   */
  getSenderGate(): SenderGate {
    return this.senderGate;
  }

  // ---------------------------------------------------------------------------
  // Stdio JSON-RPC handling
  // ---------------------------------------------------------------------------

  private handleStdioLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // Skip non-JSON lines
    }

    if (msg.jsonrpc !== '2.0') return;

    // Is it a request (has id + method)?
    if (msg.id !== undefined && msg.method) {
      this.handleRequest(msg);
      return;
    }

    // Is it a notification (has method, no id)?
    if (msg.method && msg.id === undefined) {
      this.handleNotification(msg);
      return;
    }

    // Otherwise it's a response to something we sent — ignore for now
  }

  private handleRequest(msg: JsonRpcMessage): void {
    const id = msg.id!;
    const method = msg.method!;
    const params = msg.params ?? {};

    switch (method) {
      case 'initialize':
        this.handleInitialize(id, params);
        break;

      case 'ping':
        this.sendResponse(id, {});
        break;

      case 'tools/list':
        this.handleToolsList(id);
        break;

      case 'tools/call':
        this.handleToolsCall(id, params);
        break;

      default:
        this.sendError(id, -32601, `Unknown method: ${method}`);
    }
  }

  private handleNotification(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const params = msg.params ?? {};

    switch (method) {
      case 'notifications/initialized':
        this.initialized = true;
        this.emit('initialized');
        break;

      case 'notifications/claude/channel/permission_request':
        this.handlePermissionRequest(params);
        break;

      default:
        // Unknown notification — ignore
        break;
    }
  }

  private handleInitialize(id: number | string, params: Record<string, unknown>): void {
    const capabilities: Record<string, unknown> = {
      tools: {},
      experimental: {
        'claude/channel': {},
        ...(this.config.permissionRelay
          ? { 'claude/channel/permission': {} }
          : {}),
      },
    };

    this.sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities,
      serverInfo: {
        name: `smallchat-channel-${this.config.channelName}`,
        version: PACKAGE_VERSION,
      },
      ...(this.config.instructions
        ? { instructions: this.config.instructions }
        : {}),
    });
  }

  private handleToolsList(id: number | string): void {
    const tools: object[] = [];

    if (this.config.twoWay) {
      const replyName = this.config.replyToolName ?? 'reply';
      tools.push({
        name: replyName,
        description: `Send a reply message to the ${this.config.channelName} channel`,
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to send',
            },
          },
          required: ['message'],
        },
      });
    }

    this.sendResponse(id, { tools });
  }

  private handleToolsCall(id: number | string, params: Record<string, unknown>): void {
    const toolName = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const replyName = this.config.replyToolName ?? 'reply';

    if (toolName === replyName && this.config.twoWay) {
      const message = args.message as string;
      if (!message) {
        this.sendError(id, -32602, 'Missing required argument: message');
        return;
      }

      // Broadcast reply to SSE clients and emit event
      const replyEvent = {
        type: 'reply' as const,
        channel: this.config.channelName,
        message,
        timestamp: new Date().toISOString(),
      };

      this.broadcastSSE('channel-reply', replyEvent);
      this.emit('reply', replyEvent);

      this.sendResponse(id, {
        content: [{ type: 'text', text: `Reply sent to ${this.config.channelName}` }],
      });
      return;
    }

    this.sendError(id, -32601, `Unknown tool: ${toolName}`);
  }

  private handlePermissionRequest(params: Record<string, unknown>): void {
    if (!this.config.permissionRelay) return;

    const request = this.adapter.parsePermissionRequest(params);
    if (!request) return;

    this.pendingPermissions.set(request.request_id, request);

    // Stream to approvers only: the request carries the pending tool call.
    this.broadcastSSE('permission-request', request, identity => this.isApprover(identity));
    this.emit('permission-request', request);
  }

  // ---------------------------------------------------------------------------
  // Stdio JSON-RPC output
  // ---------------------------------------------------------------------------

  private sendResponse(id: number | string, result: unknown): void {
    this.writeStdio({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: number | string, code: number, message: string): void {
    this.writeStdio({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeStdio({ jsonrpc: '2.0', method, params } as JsonRpcMessage);
  }

  private writeStdio(msg: JsonRpcMessage): void {
    try {
      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch {
      // stdout may be closed
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP bridge
  // ---------------------------------------------------------------------------

  /**
   * Check and index the bridge configuration: at least one credential, no
   * token shared by two identities, and a Host allowlist. Throws otherwise.
   */
  private prepareHttpBridge(): void {
    const entries: Array<[string, string]> = [];
    if (this.config.httpBridgeSecret) {
      entries.push([this.config.httpBridgeSecretIdentity ?? DEFAULT_BRIDGE_SECRET_IDENTITY, this.config.httpBridgeSecret]);
    }
    for (const [identity, token] of Object.entries(this.config.httpBridgeTokens ?? {})) {
      if (!identity.trim() || typeof token !== 'string' || token === '') {
        throw new Error(`httpBridgeTokens: identity "${identity}" needs a non-empty token`);
      }
      entries.push([identity, token]);
    }
    if (entries.length === 0) {
      throw new Error(
        'The channel HTTP bridge needs a secret: set SMALLCHAT_CHANNEL_SECRET or --http-bridge-secret-file ' +
        '(httpBridgeSecret), or per-sender tokens (httpBridgeTokens). It will not run unauthenticated.',
      );
    }
    const seen = new Map<string, string>();
    this.credentials = entries.map(([identity, token]) => {
      const digest = createHash('sha256').update(token).digest();
      const other = seen.get(digest.toString('hex'));
      if (other !== undefined) {
        throw new Error(`HTTP bridge identities "${other}" and "${identity}" share a token; each credential must identify one sender`);
      }
      seen.set(digest.toString('hex'), identity);
      return { identity, digest };
    });

    const host = this.config.httpBridgeHost ?? '127.0.0.1';
    const allowedHosts = this.config.httpBridgeAllowedHosts ?? defaultAllowedHostnames(host);
    if (!allowedHosts) {
      throw new Error(`The HTTP bridge binds ${host}; set httpBridgeAllowedHosts (--http-bridge-allowed-host) to the hostnames clients use`);
    }
    this.allowedHosts = allowedHosts.map(h => h.toLowerCase());
  }

  private async startHttpBridge(): Promise<void> {
    const port = this.config.httpBridgePort ?? 3002;
    const host = this.config.httpBridgeHost ?? '127.0.0.1';

    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch(err => this.failRequest(res, err));
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(port, host, () => {
        this.httpServer!.off('error', reject);
        const bound = this.httpBridgeAddress?.port ?? port;
        // Write to stderr so it doesn't interfere with stdio JSON-RPC
        process.stderr.write(
          `Channel HTTP bridge listening on http://${host}:${bound} (credential required)\n` +
          `  POST /event       Inject channel event\n` +
          `  POST /permission  Submit permission verdict (approvers only)\n` +
          `  GET  /sse         SSE event stream\n` +
          `  GET  /health      Health check\n`,
        );
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS — off by default; opt in via config.httpBridgeCorsOrigin.
    const corsOrigin = this.config.httpBridgeCorsOrigin;
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Channel-Secret');
      if (corsOrigin !== '*') res.setHeader('Vary', 'Origin');
    }

    // DNS rebinding: a page whose own hostname resolves to 127.0.0.1 still
    // sends its hostname in Host.
    if (!hostAllowed(req.headers.host, this.allowedHosts)) {
      return sendJson(res, 403, { error: 'Host not allowed' });
    }
    // Browsers always send Origin on cross-site requests.
    const origin = req.headers.origin;
    if (origin !== undefined && corsOrigin !== '*' && origin !== corsOrigin) {
      return sendJson(res, 403, { error: 'Origin not allowed' });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (req.method === 'GET' && url === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        channel: this.config.channelName,
        twoWay: !!this.config.twoWay,
        permissionRelay: !!this.config.permissionRelay,
        senderGating: this.senderGate.enabled,
        sseClients: this.sseClients.size,
        pendingPermissions: this.pendingPermissions.size,
      });
    }

    // Everything else needs a credential. /sse included: it streams channel
    // events and pending tool-approval requests.
    const identity = this.authenticate(req);
    if (identity === null) {
      req.resume();
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (req.method === 'GET' && url === '/sse') {
      return this.handleSSEConnection(req, res, identity);
    }

    if (req.method === 'POST' && url === '/event') {
      return this.handleEventPost(req, res, identity);
    }

    if (req.method === 'POST' && url === '/permission') {
      return this.handlePermissionPost(req, res, identity);
    }

    req.resume();
    sendJson(res, 404, { error: 'Not found' });
  }

  /**
   * The identity of the credential a request presents, or null. Every
   * configured credential is compared (SHA-256 digests, constant time), so
   * timing reveals neither the secret nor which identity matched.
   */
  private authenticate(req: IncomingMessage): string | null {
    const header = req.headers['x-channel-secret'];
    const provided = typeof header === 'string' && header !== ''
      ? header
      : /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!provided) return null;
    const digest = createHash('sha256').update(provided).digest();
    let identity: string | null = null;
    for (const credential of this.credentials) {
      if (timingSafeEqual(digest, credential.digest) && identity === null) identity = credential.identity;
    }
    return identity;
  }

  /** Read a POST body as a JSON object; throws HttpRejection (4xx) otherwise. */
  private async readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!isJsonContentType(req.headers['content-type'])) {
      req.resume();
      throw new HttpRejection(415, 'Content-Type must be application/json');
    }
    const body = await readBody(req, this.config.httpBridgeMaxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf-8'));
    } catch {
      throw new HttpRejection(400, 'Invalid JSON');
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new HttpRejection(400, 'Body must be a JSON object');
    }
    return payload as Record<string, unknown>;
  }

  private async handleEventPost(req: IncomingMessage, res: ServerResponse, identity: string): Promise<void> {
    const payload = await this.readJsonObject(req);

    if (typeof payload.content !== 'string' || !payload.content) {
      return sendJson(res, 400, { error: 'Missing or invalid "content" field' });
    }
    const meta = payload.meta;
    if (meta !== undefined && meta !== null && (typeof meta !== 'object' || Array.isArray(meta))) {
      return sendJson(res, 400, { error: '"meta" must be an object of string values' });
    }

    // Provenance comes from the server: the configured channel name and the
    // authenticated identity. Body "channel" and "sender" are ignored.
    const event: ChannelEvent = {
      channel: this.config.channelName,
      content: payload.content,
      meta: meta as Record<string, string> | undefined,
      sender: identity,
      timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
    };

    if (!validatePayloadSize(event.content, this.config.maxPayloadSize).valid) {
      this.emit('payload-too-large', validatePayloadSize(event.content, this.config.maxPayloadSize));
      return sendJson(res, 413, { error: 'Event content exceeds maxPayloadSize' });
    }
    if (!this.injectEvent(event)) {
      return sendJson(res, 403, { error: `Sender "${identity}" is not allowed to post to this channel` });
    }

    sendJson(res, 200, { ok: true, channel: event.channel, sender: identity });
  }

  private async handlePermissionPost(req: IncomingMessage, res: ServerResponse, identity: string): Promise<void> {
    if (!this.config.permissionRelay) {
      req.resume();
      return sendJson(res, 400, { error: 'Permission relay not enabled' });
    }

    // Only allowlisted approvers decide tool executions.
    if (this.approvers.size === 0) {
      req.resume();
      return sendJson(res, 403, { error: 'No permission approvers are configured (permissionApprovers / --permission-approvers)' });
    }
    if (!this.isApprover(identity)) {
      req.resume();
      this.emit('approver-rejected', identity);
      return sendJson(res, 403, { error: `"${identity}" is not a permission approver` });
    }

    const payload = await this.readJsonObject(req);

    // Support two formats:
    // 1. { "message": "yes abcde" } — natural reply format
    // 2. { "request_id": "abcde", "behavior": "allow"|"deny" } — explicit format

    let verdict: PermissionVerdict | null = null;

    if (typeof payload.message === 'string') {
      const parsed = parsePermissionReply(payload.message);
      if (parsed) {
        verdict = { request_id: parsed.requestId, behavior: parsed.behavior };
      }
    } else if (typeof payload.request_id === 'string' && typeof payload.behavior === 'string') {
      const behavior = payload.behavior.toLowerCase();
      if (behavior === 'allow' || behavior === 'deny') {
        verdict = { request_id: payload.request_id, behavior };
      }
    }

    if (!verdict) {
      return sendJson(res, 400, {
        error: 'Invalid permission verdict',
        hint: 'Use {"message":"yes abcde"} or {"request_id":"abcde","behavior":"allow"}',
      });
    }

    // Verify the request_id exists
    if (!this.pendingPermissions.has(verdict.request_id)) {
      return sendJson(res, 404, { error: `No pending permission request: ${verdict.request_id}` });
    }

    this.sendPermissionVerdict(verdict, identity);

    sendJson(res, 200, { ok: true, ...verdict, approver: identity });
  }

  /** Answer a request whose handler threw; never let it reach the process. */
  private failRequest(res: ServerResponse, err: unknown): void {
    if (err instanceof ClientAbortedError) {
      res.destroy();
      return;
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpRejection) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    this.emit('bridge-error', err);
    sendJson(res, 500, { error: 'Internal error' });
  }

  /** Whether an authenticated identity is in permissionApprovers. */
  private isApprover(identity: string): boolean {
    return this.approvers.has(normalizeIdentity(identity));
  }

  /**
   * GET /sse — every authenticated identity receives channel events and
   * replies (the channel's traffic, whoever posted it); permission requests
   * go only to approvers.
   */
  private handleSSEConnection(_req: IncomingMessage, res: ServerResponse, identity: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ channel: this.config.channelName, timestamp: Date.now() })}\n\n`);

    this.sseClients.set(res, identity);

    // Keep-alive
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15000);

    _req.on('close', () => {
      clearInterval(keepAlive);
      this.sseClients.delete(res);
    });
  }

  /** Write an SSE event to every open stream, or to those whose identity `to` accepts. */
  private broadcastSSE(event: string, data: unknown, to?: (identity: string) => boolean): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [client, identity] of this.sseClients) {
      if (to && !to(identity)) continue;
      try { client.write(payload); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function normalizeIdentity(identity: string): string {
  return identity.toLowerCase().trim();
}
