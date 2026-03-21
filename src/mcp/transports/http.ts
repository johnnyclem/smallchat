/**
 * HTTP transport for MCPServer.
 *
 * Routes:
 *   GET  /.well-known/mcp.json  — discovery
 *   POST /mcp                   — JSON-RPC 2.0
 *   GET  /mcp/sse               — SSE stream (session-bound)
 *   GET  /health                — health check (backward compat)
 *   OPTIONS *                   — CORS preflight
 */

import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import type { McpRouter } from '../router.js';
import type { SseBroker } from '../sse-broker.js';
import type { SessionManager } from '../session.js';
import type { ToolRegistry } from '../registry.js';
import { MCP_PROTOCOL_VERSIONS } from '../types.js';

export interface HttpTransportOptions {
  serverName: string;
  serverVersion: string;
}

export function createHttpHandler(
  router: McpRouter,
  broker: SseBroker,
  sessions: SessionManager,
  tools: ToolRegistry,
  opts: HttpTransportOptions,
): RequestListener {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // CORS — allow any origin for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Session-Id');
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const path = url.split('?')[0];

    // -------------------------------------------------------------------------
    // GET /.well-known/mcp.json — discovery
    // -------------------------------------------------------------------------
    if (req.method === 'GET' && path === '/.well-known/mcp.json') {
      const discovery = {
        name: opts.serverName,
        version: opts.serverVersion,
        protocolVersions: [...MCP_PROTOCOL_VERSIONS],
        endpoints: {
          rpc: '/mcp',
          sse: '/mcp/sse',
          discovery: '/.well-known/mcp.json',
        },
        features: {
          tools: true,
          resources: true,
          prompts: true,
          apps: false,
          sessions: true,
          streaming: {
            sse: true,
            stdio: false,
            progressNotifications: true,
            tokenDeltas: false,
          },
        },
        auth: { mode: 'none' },
        transports: { http: true, stdio: false },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(discovery));
      return;
    }

    // -------------------------------------------------------------------------
    // GET /health — backward compat
    // -------------------------------------------------------------------------
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: tools.size() }));
      return;
    }

    // -------------------------------------------------------------------------
    // GET /mcp/sse — session-bound SSE stream
    // -------------------------------------------------------------------------
    if (req.method === 'GET' && path === '/mcp/sse') {
      const sessionId = extractSessionId(req, url);

      if (!sessionId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'MCP-Session-Id header or ?sessionId query param required' }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session || session.status !== 'active') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired session' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.flushHeaders();

      const cleanup = broker.connect(sessionId, res);

      // Send connected event
      res.write(`: connected sessionId=${sessionId}\n\n`);

      // Keep-alive every 15s
      const keepAlive = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          clearInterval(keepAlive);
        }
      }, 15_000);
      if (typeof keepAlive.unref === 'function') keepAlive.unref();

      req.on('close', () => {
        clearInterval(keepAlive);
        cleanup();
      });

      return;
    }

    // -------------------------------------------------------------------------
    // POST /mcp — JSON-RPC 2.0
    // -------------------------------------------------------------------------
    if (req.method === 'POST' && path === '/mcp') {
      const body = await readBody(req);
      let parsed: unknown;

      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
        return;
      }

      const sessionId = extractSessionId(req, url);
      const rpcRes = await router.handle(parsed, sessionId);

      if (rpcRes === null) {
        // Notification: no response body
        res.writeHead(204);
        res.end();
        return;
      }

      // Echo back the sessionId if it came from initialize
      const result = rpcRes.result as Record<string, unknown> | undefined;
      const newSessionId =
        result?.session &&
        typeof result.session === 'object' &&
        (result.session as Record<string, unknown>).sessionId;

      if (newSessionId && typeof newSessionId === 'string') {
        res.setHeader('MCP-Session-Id', newSessionId);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpcRes));
      return;
    }

    // -------------------------------------------------------------------------
    // 404 fallthrough
    // -------------------------------------------------------------------------
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSessionId(req: IncomingMessage, url: string): string | null {
  // Prefer header
  const header = req.headers['mcp-session-id'];
  if (header && typeof header === 'string') return header;

  // Fall back to query param
  const qIdx = url.indexOf('?');
  if (qIdx !== -1) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const sid = params.get('sessionId');
    if (sid) return sid;
  }

  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
