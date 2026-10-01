/**
 * MCP conformance checks for `smallchat serve` — shared by the test suite
 * and `smallchat doctor --mcp`.
 *
 * Every check talks to the server the way a real host does: the official
 * SDK Client over stdio or Streamable HTTP, plus raw HTTP requests for the
 * transport-level negatives. Each step has a timeout, so a server that
 * hangs (e.g. never answers a notification) fails instead of passing.
 */

import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, SUPPORTED_PROTOCOL_VERSIONS, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { RESOLVE_TOOL_NAME } from './tool-names.js';
import { PACKAGE_VERSION } from '../core/version.js';

export type ConformanceTarget =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; token?: string };

export interface ConformanceOptions {
  /** Per-step timeout (default 10 s) */
  timeoutMs?: number;
  /** Also call this tool end to end; it must succeed */
  call?: { name: string; arguments?: Record<string, unknown> };
  /** Where a stdio server's stderr goes (default 'ignore') */
  stderr?: 'inherit' | 'ignore';
}

export interface ConformanceCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** Tool names MCP 2025-11-25 recommends: 1–128 of [A-Za-z0-9_.-]. */
const SPEC_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const PROBE_TOOL = '__smallchat_conformance_unknown__';

/** Run every check against `target`. Never throws; failures are checks. */
export async function runConformance(
  target: ConformanceTarget,
  options: ConformanceOptions = {},
): Promise<ConformanceCheck[]> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const checks: ConformanceCheck[] = [];
  const check = async (name: string, step: () => Promise<string>): Promise<boolean> => {
    try {
      const detail = await withTimeout(step(), timeoutMs, name);
      checks.push({ name, pass: true, detail });
      return true;
    } catch (err) {
      checks.push({ name, pass: false, detail: (err as Error).message });
      return false;
    }
  };

  let negotiated: string | undefined;
  const transport = target.kind === 'stdio'
    ? new StdioClientTransport({
      command: target.command,
      args: target.args ?? [],
      env: { ...getDefaultEnvironment(), ...target.env },
      ...(target.cwd ? { cwd: target.cwd } : {}),
      stderr: options.stderr ?? 'ignore',
    })
    : new StreamableHTTPClientTransport(new URL(target.url), target.token
      ? { requestInit: { headers: { Authorization: `Bearer ${target.token}` } } }
      : undefined);
  const setVersion = (transport as { setProtocolVersion?: (v: string) => void }).setProtocolVersion?.bind(transport);
  (transport as { setProtocolVersion?: (v: string) => void }).setProtocolVersion = (version: string) => {
    negotiated = version;
    setVersion?.(version);
  };

  const client = new Client({ name: 'smallchat-conformance', version: PACKAGE_VERSION }, { capabilities: {} });

  const connected = await check('initialize', async () => {
    await client.connect(transport, { timeout: timeoutMs });
    const info = client.getServerVersion();
    return `${info?.name ?? '?'} ${info?.version ?? '?'}`;
  });
  if (!connected) {
    await client.close().catch(() => {});
    if (target.kind === 'http') checks.push(...await httpNegatives(target, timeoutMs));
    return checks;
  }

  await check('protocol version', async () => {
    if (target.kind === 'stdio' && negotiated === undefined) {
      // stdio transports have no version hook; the SDK client already
      // rejected an unsupported version during connect.
      return 'negotiated by the SDK client';
    }
    if (!negotiated || !SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated)) {
      throw new Error(`negotiated ${negotiated ?? 'nothing'}; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`);
    }
    return negotiated;
  });

  await check('ping', async () => {
    await client.ping({ timeout: timeoutMs });
    return 'ok';
  });

  const tools: Tool[] = [];
  await check('tools/list', async () => {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const names = new Set<string>();
    for (const tool of tools) {
      if (!SPEC_TOOL_NAME.test(tool.name)) throw new Error(`tool name "${tool.name}" is not 1-128 of [A-Za-z0-9_.-]`);
      if (names.has(tool.name)) throw new Error(`tool name "${tool.name}" is listed twice`);
      names.add(tool.name);
      if (tool.inputSchema?.type !== 'object') throw new Error(`${tool.name}: inputSchema.type must be "object"`);
    }
    return `${tools.length} tools`;
  });

  await check('unknown tool is refused', async () => {
    let result: CallToolResult;
    try {
      result = await client.callTool({ name: PROBE_TOOL, arguments: {} }, undefined, { timeout: timeoutMs }) as CallToolResult;
    } catch (err) {
      if (err instanceof McpError && err.code === -32602) return 'JSON-RPC -32602';
      throw err;
    }
    if (result.isError !== true) throw new Error('an unknown tool name returned a success result');
    const text = result.content.find(c => c.type === 'text');
    return text && 'text' in text ? `isError: ${text.text.slice(0, 80)}` : 'isError result';
  });

  if (tools.some(t => t.name === RESOLVE_TOOL_NAME)) {
    await check(`${RESOLVE_TOOL_NAME} proposes without executing`, async () => {
      const result = await client.callTool(
        { name: RESOLVE_TOOL_NAME, arguments: { intent: 'conformance probe' } },
        undefined,
        { timeout: timeoutMs },
      ) as CallToolResult;
      const proposal = result.structuredContent as { outcome?: string; proofDigest?: string } | undefined;
      if (result.isError) throw new Error('returned isError');
      if (!proposal || !['resolved', 'needs-disambiguation', 'unresolved'].includes(proposal.outcome ?? '')) {
        throw new Error('structuredContent has no outcome');
      }
      if (!/^[0-9a-f]{64}$/.test(proposal.proofDigest ?? '')) throw new Error('structuredContent has no proofDigest');
      return `outcome ${proposal.outcome}`;
    });
  }

  if (options.call) {
    const { name, arguments: args } = options.call;
    await check(`tools/call ${name}`, async () => {
      const result = await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: timeoutMs }) as CallToolResult;
      const text = result.content.find(c => c.type === 'text');
      const shown = text && 'text' in text ? text.text.slice(0, 80) : `${result.content.length} content block(s)`;
      if (result.isError) throw new Error(`isError: ${shown}`);
      return shown;
    });
  }

  if (target.kind === 'http') {
    const http = transport as StreamableHTTPClientTransport;
    await check('notification is accepted (202)', async () => {
      const res = await rawRequest(target.url, {
        method: 'POST',
        headers: {
          ...authHeader(target),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(http.sessionId ? { 'mcp-session-id': http.sessionId } : {}),
          ...(negotiated ? { 'mcp-protocol-version': negotiated } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'none', reason: 'conformance' } }),
      }, timeoutMs);
      if (res.status !== 202) throw new Error(`HTTP ${res.status}`);
      return 'HTTP 202';
    });
    checks.push(...await httpNegatives(target, timeoutMs));
  }

  await check('close', async () => {
    await client.close();
    return 'ok';
  });

  return checks;
}

/** Requests a conformant, guarded HTTP server must refuse. */
async function httpNegatives(target: { url: string; token?: string }, timeoutMs: number): Promise<ConformanceCheck[]> {
  const checks: ConformanceCheck[] = [];
  const init = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'conformance', version: '1' } },
  });
  const json = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  const expect = async (name: string, status: number, init: RawRequest) => {
    try {
      const res = await rawRequest(target.url, init, timeoutMs);
      checks.push({ name, pass: res.status === status, detail: `HTTP ${res.status}${res.status === status ? '' : ` (expected ${status})`}` });
    } catch (err) {
      checks.push({ name, pass: false, detail: (err as Error).message });
    }
  };

  if (target.token) {
    await expect('missing bearer token is refused', 401, { method: 'POST', headers: json, body: init });
  } else {
    checks.push({ name: 'missing bearer token is refused', pass: true, detail: 'skipped: no token given (insecure server?)' });
  }
  await expect('foreign Origin is refused', 403, { method: 'POST', headers: { ...authHeader(target), ...json, origin: 'http://evil.example' }, body: init });
  await expect('foreign Host is refused', 403, { method: 'POST', headers: { ...authHeader(target), ...json, host: 'evil.example' }, body: init });
  await expect('text/plain body is refused', 415, { method: 'POST', headers: { ...authHeader(target), accept: json.accept, 'content-type': 'text/plain' }, body: init });
  await expect('null body is refused', 400, { method: 'POST', headers: { ...authHeader(target), ...json }, body: 'null' });
  await expect('unknown session is refused', 404, {
    method: 'POST',
    headers: { ...authHeader(target), ...json, 'mcp-session-id': 'no-such-session' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  return checks;
}

function authHeader(target: { token?: string }): Record<string, string> {
  return target.token ? { authorization: `Bearer ${target.token}` } : {};
}

interface RawRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A raw HTTP request (node:http, so Host can be set), answering status and body. */
function rawRequest(url: string, init: RawRequest, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method, headers: init.headers, timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no response within ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(init.body);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
