/**
 * ChannelServer — stdio MCP server that acts as a Claude Code channel.
 *
 * Design decision: We add a new "smallchat channel" CLI command that runs a
 * stdio MCP server (for Claude Code to spawn as a subprocess), with an optional
 * HTTP bridge for receiving webhook events and serving SSE for outbound visibility.
 *
 * Justification: Claude Code spawns channel servers over stdio. The existing
 * "smallchat serve" is HTTP-based with sessions, OAuth, etc. — too heavy for
 * a channel subprocess. A dedicated stdio server is simpler, correct, and
 * keeps the existing serve command backward-compatible.
 *
 * Protocol:
 *   stdin/stdout  — JSON-RPC 2.0 (newline-delimited) with MCP host (Claude Code)
 *   HTTP bridge   — optional local HTTP server for inbound webhooks + SSE outbound
 */

import { createInterface, type Interface } from 'node:readline';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type {
  ChannelEvent,
  ChannelServerConfig,
  PermissionRequest,
  PermissionVerdict,
} from './types.js';
import { ClaudeCodeChannelAdapter } from './adapter.js';
import { SenderGate } from './sender-gate.js';
import { filterMetaKeys, validatePayloadSize, parsePermissionReply } from './utils.js';

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
  private sseClients: Set<ServerResponse> = new Set();
  private initialized = false;
  private nextId = 1;
  private pendingPermissions: Map<string, PermissionRequest> = new Map();

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
  }

  /**
   * Start the stdio MCP server (and optional HTTP bridge).
   */
  async start(): Promise<void> {
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
      for (const client of this.sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      this.sseClients.clear();
      this.httpServer.close();
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

    // Filter meta keys
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

    // Emit MCP notification over stdio
    this.sendNotification('notifications/claude/channel', {
      channel: cleanEvent.channel,
      content: cleanEvent.content,
      meta: cleanEvent.meta,
    });

    // Broadcast to SSE clients
    this.broadcastSSE('channel-event', cleanEvent);

    this.emit('event-injected', cleanEvent);
    return true;
  }

  /**
   * Send a permission verdict back to the host.
   */
  sendPermissionVerdict(verdict: PermissionVerdict): void {
    this.sendNotification('notifications/claude/channel/permission', verdict);
    this.pendingPermissions.delete(verdict.request_id);
    this.emit('permission-verdict', verdict);
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
        version: '0.1.0',
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

    // Broadcast to SSE clients for remote approval
    this.broadcastSSE('permission-request', request);
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

  private async startHttpBridge(): Promise<void> {
    const port = this.config.httpBridgePort ?? 3002;
    const host = this.config.httpBridgeHost ?? '127.0.0.1';

    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

    return new Promise((resolve) => {
      this.httpServer!.listen(port, host, () => {
        // Write to stderr so it doesn't interfere with stdio JSON-RPC
        process.stderr.write(
          `Channel HTTP bridge listening on http://${host}:${port}\n` +
          `  POST /event       Inject channel event\n` +
          `  POST /permission  Submit permission verdict\n` +
          `  GET  /sse         SSE event stream\n` +
          `  GET  /health      Health check\n`,
        );
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Channel-Secret');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    // Shared secret check
    if (this.config.httpBridgeSecret) {
      const provided = req.headers['x-channel-secret'] as string
        ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');

      if (provided !== this.config.httpBridgeSecret) {
        // SSE and health don't require auth
        if (url !== '/sse' && url !== '/health') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }
    }

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        channel: this.config.channelName,
        twoWay: !!this.config.twoWay,
        permissionRelay: !!this.config.permissionRelay,
        senderGating: this.senderGate.enabled,
        sseClients: this.sseClients.size,
        pendingPermissions: this.pendingPermissions.size,
      }));
      return;
    }

    if (req.method === 'GET' && url === '/sse') {
      return this.handleSSEConnection(req, res);
    }

    if (req.method === 'POST' && url === '/event') {
      return this.handleEventPost(req, res);
    }

    if (req.method === 'POST' && url === '/permission') {
      return this.handlePermissionPost(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async handleEventPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const event: ChannelEvent = {
      channel: (payload.channel as string) || this.config.channelName,
      content: payload.content as string,
      meta: payload.meta as Record<string, string> | undefined,
      sender: payload.sender as string | undefined,
      timestamp: (payload.timestamp as string) || new Date().toISOString(),
    };

    if (!event.content || typeof event.content !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid "content" field' }));
      return;
    }

    const ok = this.injectEvent(event);

    if (!ok) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Event rejected (sender gating or payload size)' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, channel: event.channel }));
  }

  private async handlePermissionPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.config.permissionRelay) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Permission relay not enabled' }));
      return;
    }

    // Require sender gating for permission relay
    if (!this.senderGate.enabled) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Permission relay requires sender gating to be enabled' }));
      return;
    }

    const body = await readBody(req);
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

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
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Invalid permission verdict',
        hint: 'Use {"message":"yes abcde"} or {"request_id":"abcde","behavior":"allow"}',
      }));
      return;
    }

    // Verify the request_id exists
    if (!this.pendingPermissions.has(verdict.request_id)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No pending permission request: ${verdict.request_id}` }));
      return;
    }

    this.sendPermissionVerdict(verdict);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...verdict }));
  }

  private handleSSEConnection(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ channel: this.config.channelName, timestamp: Date.now() })}\n\n`);

    this.sseClients.add(res);

    // Keep-alive
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15000);

    _req.on('close', () => {
      clearInterval(keepAlive);
      this.sseClients.delete(res);
    });
  }

  private broadcastSSE(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(payload); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 256 * 1024; // 256KB hard limit for HTTP body

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}
