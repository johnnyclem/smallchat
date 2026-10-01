/**
 * `smallchat serve` conformance: the official SDK client against the
 * SDK-based server, end to end (compile → serve → call) over stdio and
 * Streamable HTTP, with a real fixture upstream MCP server.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ResourceUpdatedNotificationSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { MCPServer, type HttpServeOptions } from './server.js';
import { MCP_PROTOCOL_VERSIONS } from './types.js';
import { introspectMcpConfigFile } from './client.js';
import { runConformance } from './conformance.js';
import { AuditLog } from './audit-log.js';
import { RESOLUTION_META_KEY } from './results.js';
import { ensureTokenFile } from './http-guard.js';
import { registerLocalHandler, unregisterLocalHandler } from './transport.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { buildArtifact } from '../artifact/format.js';
import { writeArtifact } from '../artifact/io.js';
import type { ProviderManifest } from '../core/types.js';
// @ts-expect-error — plain .mjs fixture, no type declarations
import { createFixtureServer, FIXTURE_TOOLS, fixtureEvents } from './__fixtures__/upstream-server.mjs';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/upstream-server.mjs', import.meta.url));
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const VITE_NODE = join(REPO, 'node_modules', 'vite-node', 'vite-node.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc4-serve-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Compile manifests the way `smallchat compile --embedder hash` does. */
async function compileManifests(manifests: ProviderManifest[], dir = tmp()): Promise<string> {
  const embedder = new HashEmbedder(64);
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex(), { allowDuplicates: true }).compile(manifests);
  const path = join(dir, 'tools.toolkit.json');
  await writeArtifact(path, buildArtifact(result, manifests, embedder.fingerprint));
  return path;
}

/** Introspect the fixture upstream from an MCP config (launch spec, env names only). */
async function introspectFixture(serverIds: string[] = ['fixture']): Promise<ProviderManifest[]> {
  const dir = tmp();
  const cfg = join(dir, '.mcp.json');
  const mcpServers = Object.fromEntries(serverIds.map(id => [
    id,
    { command: process.execPath, args: [FIXTURE], env: { FIXTURE_SECRET: 'value-that-must-not-be-stored' } },
  ]));
  writeFileSync(cfg, JSON.stringify({ mcpServers }));
  return introspectMcpConfigFile(cfg);
}

let fixtureArtifact: string;
let twoProviderArtifact: string;

beforeAll(async () => {
  fixtureArtifact = await compileManifests(await introspectFixture());
  twoProviderArtifact = await compileManifests(await introspectFixture(['fixture', 'second']));
}, 60_000);

const running: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop();
});

async function serveHttp(
  config: ConstructorParameters<typeof MCPServer>[0] = {},
  http: Partial<HttpServeOptions> = {},
): Promise<{ server: MCPServer; url: string }> {
  const server = new MCPServer({
    sourcePath: fixtureArtifact,
    log: () => {},
    upstream: { env: { FIXTURE_SECRET: 'from-serve-env' }, stderr: 'ignore' },
    ...config,
  });
  running.push(server);
  const { url } = await server.startHttp({ port: 0, token: TOKEN, ...http });
  return { server, url };
}

async function connectHttp(url: string, token: string | null = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), token
    ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
    : undefined));
  running.push({ stop: () => client.close() });
  return client;
}

function text(result: CallToolResult): string {
  return result.content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
}

function raw(
  url: string,
  init: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({
      host: target.hostname,
      port: target.port,
      path: init.path ?? target.pathname,
      method: init.method ?? 'POST',
      headers: init.headers,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

/** The fixture tools served over Streamable HTTP by the SDK, in-process. */
async function httpUpstream(): Promise<{ manifest: ProviderManifest }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const upstream = createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { transports.set(id, transport!); },
      });
      await createFixtureServer('remote-upstream').connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  running.push({
    stop: async () => {
      upstream.closeAllConnections();
      await new Promise<void>(r => upstream.close(() => r()));
    },
  });
  const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
  return {
    manifest: {
      id: 'remote',
      name: 'Remote fixture',
      transportType: 'mcp',
      launch: { transport: 'streamable-http', url },
      tools: FIXTURE_TOOLS.map((t: ProviderManifest['tools'][number]) => ({ ...t, providerId: 'remote', transportType: 'mcp' })),
    },
  };
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const AUTH = { authorization: `Bearer ${TOKEN}` };
const INIT = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
});

// ---------------------------------------------------------------------------

describe('serve is an exact aggregator over the SDK (SC-SURF-01, 05, 07, 08, 19)', () => {
  it('lists every upstream tool as <provider>__<tool> with its full upstream definition', async () => {
    const { url } = await serveHttp({ sourcePath: twoProviderArtifact });
    const client = await connectHttp(url);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);

    expect(names).toContain('fixture__echo');
    expect(names).toContain('second__echo');
    expect(names).toContain('smallchat_resolve');
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,128}$/);

    const echo = tools.find(t => t.name === 'fixture__echo')!;
    const upstreamEcho = FIXTURE_TOOLS.find((t: { name: string }) => t.name === 'echo');
    expect(echo.title).toBe('Echo');
    expect(echo.description).toBe(upstreamEcho.description);
    expect(echo.inputSchema).toEqual(upstreamEcho.inputSchema);
    expect(echo.annotations).toEqual(upstreamEcho.annotations);
    const add = tools.find(t => t.name === 'second__add')!;
    expect(add.outputSchema).toEqual(FIXTURE_TOOLS.find((t: { name: string }) => t.name === 'add').outputSchema);
  });

  it('forwards tools/call by exact name to the upstream server and passes its result through', async () => {
    const { url } = await serveHttp();
    const client = await connectHttp(url);

    const echo = await client.callTool({ name: 'fixture__echo', arguments: { text: 'hi there' } }) as CallToolResult;
    expect(echo.isError).toBeFalsy();
    expect(echo.content).toEqual([{ type: 'text', text: 'hi there' }]);
    const proof = echo._meta?.[RESOLUTION_META_KEY] as Record<string, unknown>;
    expect(proof).toMatchObject({ toolId: 'fixture/echo', ran: 'fixture/echo', decision: 'exact-id', outcome: 'resolved' });
    expect(proof.callDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.proofDigest).toMatch(/^[0-9a-f]{64}$/);

    const add = await client.callTool({ name: 'fixture__add', arguments: { a: 2, b: 3 } }) as CallToolResult;
    expect(add.structuredContent).toEqual({ sum: 5 });

    const pixel = await client.callTool({ name: 'fixture__pixel', arguments: {} }) as CallToolResult;
    expect(pixel.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  it('starts stdio upstreams with the named env vars from serve\'s environment; the artifact holds names only', async () => {
    expect(readFileSync(fixtureArtifact, 'utf-8')).not.toContain('value-that-must-not-be-stored');
    const { url } = await serveHttp();
    const client = await connectHttp(url);
    const probe = await client.callTool({ name: 'fixture__env_probe', arguments: {} }) as CallToolResult;
    expect(text(probe)).toBe('secret:set');
  });

  it('reports why a call failed: upstream tool errors and invalid arguments (SC-SURF-19)', async () => {
    const { url } = await serveHttp();
    const client = await connectHttp(url);

    const fail = await client.callTool({ name: 'fixture__fail', arguments: {} }) as CallToolResult;
    expect(fail.isError).toBe(true);
    expect(text(fail)).toContain('the disk is full');

    const invalid = await client.callTool({ name: 'fixture__echo', arguments: { text: 7 } }) as CallToolResult;
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toContain('Invalid arguments for fixture/echo; the tool was not called.');
    expect(text(invalid)).toMatch(/text.*must be string/);
    expect((invalid._meta?.[RESOLUTION_META_KEY] as { ran: string | null }).ran).toBeNull();
  });

  it('never resolves a tools/call name: unknown names are an isError result with close names (SC-SURF-05)', async () => {
    const { url } = await serveHttp();
    const client = await connectHttp(url);

    const bare = await client.callTool({ name: 'echo', arguments: { text: 'x' } }) as CallToolResult;
    expect(bare.isError).toBe(true);
    expect(text(bare)).toContain('Unknown tool "echo"; nothing was executed.');
    expect(text(bare)).toContain('fixture__echo');

    const typo = await client.callTool({ name: 'fixture__ecoh', arguments: { text: 'x' } }) as CallToolResult;
    expect(typo.isError).toBe(true);
    expect(text(typo)).toContain('fixture__echo');

    const intent = await client.callTool({ name: 'repeat my words back to me', arguments: {} }) as CallToolResult;
    expect(intent.isError).toBe(true);
    expect(text(intent)).toContain('smallchat_resolve');
  });

  it('reaches a Streamable HTTP upstream through its launch URL', async () => {
    const upstream = await httpUpstream();
    const { url } = await serveHttp({ sourcePath: await compileManifests([upstream.manifest]) });
    const client = await connectHttp(url);
    const add = await client.callTool({ name: 'remote__add', arguments: { a: 40, b: 2 } }) as CallToolResult;
    expect(add.isError).toBeFalsy();
    expect(add.structuredContent).toEqual({ sum: 42 });
  });

  it('forwards progress from the upstream and cancels the upstream call when the client cancels', async () => {
    const upstream = await httpUpstream();
    const { server, url } = await serveHttp({ sourcePath: await compileManifests([upstream.manifest]) });
    const client = await connectHttp(url);

    const progress: string[] = [];
    const controller = new AbortController();
    const call = client.callTool({ name: 'remote__sleep', arguments: { ms: 30_000 } }, undefined, {
      signal: controller.signal,
      onprogress: p => { progress.push(p.message ?? String(p.progress)); },
    });
    await new Promise(r => setTimeout(r, 300));
    controller.abort('user changed their mind');
    await expect(call).rejects.toThrow();
    await new Promise(r => setTimeout(r, 200));

    expect(progress).toEqual(['sleeping']);
    expect(fixtureEvents).toContain('sleep:cancelled');
    expect(server.audit.recent().find(e => e.method === 'tools/call')).toMatchObject({ outcome: 'error', error: 'cancelled by the client' });
  });

  it('reports an unreachable upstream as an isError result and retries on the next call', async () => {
    const tool = { name: 'ping', description: 'Ping the upstream', inputSchema: { type: 'object', properties: {} } as never, transportType: 'mcp' as const };
    const manifests: ProviderManifest[] = [
      { id: 'broken', name: 'Broken', transportType: 'mcp', launch: { transport: 'stdio', command: join(tmp(), 'no-such-server'), args: [], env: [] }, tools: [{ ...tool, providerId: 'broken' }] },
      { id: 'nolaunch', name: 'No launch spec', transportType: 'mcp', tools: [{ ...tool, providerId: 'nolaunch' }] },
    ];
    const { url } = await serveHttp({ sourcePath: await compileManifests(manifests) });
    const client = await connectHttp(url);

    for (let i = 0; i < 2; i++) {
      const broken = await client.callTool({ name: 'broken__ping', arguments: {} }) as CallToolResult;
      expect(broken.isError).toBe(true);
      expect(text(broken)).toContain('Upstream "broken" could not run ping');
    }
    const noLaunch = await client.callTool({ name: 'nolaunch__ping', arguments: {} }) as CallToolResult;
    expect(noLaunch.isError).toBe(true);
    expect(text(noLaunch)).toContain('has no launch spec');
  });

  it('negotiates only the protocol versions the SDK supports (SC-SURF-24)', async () => {
    expect(MCP_PROTOCOL_VERSIONS).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    const { url } = await serveHttp();
    for (const version of ['2025-11-25', '2025-06-18', '2024-11-05']) {
      const res = await raw(url, {
        headers: { ...AUTH, ...JSON_HEADERS },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'v', version: '1' } } }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain(`"protocolVersion":"${version}"`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('tools/call runs exactly the listed tool (moved from SC-INF-14)', () => {
  it('executes the listed name, refuses ids, bare names and phrases, and reports invalid arguments', async () => {
    const manifests: ProviderManifest[] = [
      {
        id: 'github',
        name: 'GitHub',
        transportType: 'local',
        tools: [
          { name: 'get_issue', description: 'Retrieve the full details of a single issue including comments, labels, assignees and linked pull requests', inputSchema: { type: 'object', properties: { number: { type: 'integer' } }, required: ['number'] } as never, providerId: 'github', transportType: 'local' },
          { name: 'search_code', description: 'Search code across repositories', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } as never, providerId: 'github', transportType: 'local' },
        ],
      },
      {
        id: 'gitlab',
        name: 'GitLab',
        transportType: 'local',
        tools: [
          { name: 'search_code', description: 'Find text in GitLab project files', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } as never, providerId: 'gitlab', transportType: 'local' },
        ],
      },
    ];
    const calls: unknown[] = [];
    registerLocalHandler('get_issue', async (args) => {
      calls.push(args);
      return { content: { title: 'Bug' } };
    });
    try {
      const { url } = await serveHttp({ sourcePath: await compileManifests(manifests) });
      const client = await connectHttp(url);
      const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

      const ok = await call('github__get_issue', { number: 7 });
      expect(ok.isError).toBeFalsy();
      expect(ok.structuredContent).toEqual({ title: 'Bug' });
      expect(calls).toEqual([{ number: 7 }]);

      // Canonical ids, bare upstream names and phrases are not tool names.
      for (const name of ['github/get_issue', 'get_issue', 'get issue']) {
        const miss = await call(name, { number: 9 });
        expect(miss.isError).toBe(true);
        expect(text(miss)).toContain('github__get_issue');
      }
      const shared = await call('search_code', { query: 'x' });
      expect(shared.isError).toBe(true);
      expect(text(shared)).toContain('github__search_code');
      expect(text(shared)).toContain('gitlab__search_code');

      // Invalid arguments are reported to the model; the tool does not run.
      const invalid = await call('github__get_issue', { number: 'seven' });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain('argument "number" must be integer');
      expect(calls).toHaveLength(1);
    } finally {
      unregisterLocalHandler('get_issue');
    }
  });
});

// ---------------------------------------------------------------------------

describe('smallchat_resolve proposes and never executes', () => {
  const manifests: ProviderManifest[] = [{
    id: 'files',
    name: 'Files',
    transportType: 'local',
    tools: [
      { name: 'delete_file', description: 'Delete a file from disk permanently', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as never, providerId: 'files', transportType: 'local', annotations: { destructiveHint: true } },
      { name: 'list_dir', description: 'List the entries of a directory', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } as never, providerId: 'files', transportType: 'local' },
    ],
  }];

  it('returns the tool id, MCP name, tier, candidates and proof digest, and runs nothing', async () => {
    const ran: string[] = [];
    registerLocalHandler('delete_file', async () => { ran.push('delete_file'); return { content: 'deleted' }; });
    registerLocalHandler('list_dir', async () => { ran.push('list_dir'); return { content: ['a', 'b'] }; });
    try {
      const { url } = await serveHttp({ sourcePath: await compileManifests(manifests) });
      const client = await connectHttp(url);

      const result = await client.callTool({
        name: 'smallchat_resolve',
        arguments: { intent: 'delete_file: Delete a file from disk permanently', args: { path: '/tmp/x' } },
      }) as CallToolResult;
      expect(result.isError).toBeFalsy();
      const proposal = result.structuredContent as Record<string, unknown>;
      expect(proposal).toMatchObject({ outcome: 'resolved', toolId: 'files/delete_file', name: 'files__delete_file' });
      expect(proposal.proofDigest).toMatch(/^[0-9a-f]{64}$/);
      expect((proposal.candidates as Array<{ name: string }>)[0].name).toBe('files__delete_file');
      expect(text(result)).toContain('Nothing was executed');
      expect(result._meta?.[RESOLUTION_META_KEY]).toMatchObject({ toolId: 'files/delete_file', ran: null });
      expect(ran).toEqual([]);

      // The client runs the proposal by its exact name.
      const run = await client.callTool({ name: proposal.name as string, arguments: { path: '/tmp/x' } }) as CallToolResult;
      expect(run.isError).toBeFalsy();
      expect(ran).toEqual(['delete_file']);
    } finally {
      unregisterLocalHandler('delete_file');
      unregisterLocalHandler('list_dir');
    }
  });

  it('can be turned off', async () => {
    const { url } = await serveHttp({ resolveTool: false });
    const client = await connectHttp(url);
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).not.toContain('smallchat_resolve');
  });
});

// ---------------------------------------------------------------------------

describe('serve --provider serves one provider under its upstream names (OpenAPPA batteries)', () => {
  it('lists upstream names verbatim and calls them exactly', async () => {
    const { url } = await serveHttp({ sourcePath: twoProviderArtifact, provider: 'second' });
    const client = await connectHttp(url);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['add', 'echo', 'env_probe', 'fail', 'pixel', 'sleep', 'smallchat_resolve']);

    const echo = await client.callTool({ name: 'echo', arguments: { text: 'verbatim' } }) as CallToolResult;
    expect(echo.content).toEqual([{ type: 'text', text: 'verbatim' }]);
    expect((echo._meta?.[RESOLUTION_META_KEY] as { ran: string }).ran).toBe('second/echo');

    const aggregate = await client.callTool({ name: 'second__echo', arguments: { text: 'x' } }) as CallToolResult;
    expect(aggregate.isError).toBe(true);
  });

  it('refuses an unknown provider at startup', async () => {
    const server = new MCPServer({ sourcePath: fixtureArtifact, provider: 'nope', log: () => {} });
    await expect(server.load()).rejects.toThrow('Provider "nope" is not in');
  });
});

// ---------------------------------------------------------------------------

describe('Streamable HTTP is guarded and never crashes (SC-SURF-04, 08, 09, 12)', () => {
  it('passes the shared conformance checks (the ones doctor --mcp runs)', async () => {
    const { url } = await serveHttp();
    const checks = await runConformance({ kind: 'http', url, token: TOKEN }, { call: { name: 'fixture__echo', arguments: { text: 'conformance' } } });
    expect(checks.filter(c => !c.pass)).toEqual([]);
    expect(checks.map(c => c.name)).toEqual(expect.arrayContaining([
      'initialize', 'protocol version', 'tools/list', 'unknown tool is refused', 'tools/call fixture__echo',
      'notification is accepted (202)', 'missing bearer token is refused', 'foreign Origin is refused',
      'foreign Host is refused', 'text/plain body is refused', 'null body is refused', 'unknown session is refused',
    ]));
  });

  it('refuses foreign Host and Origin headers before anything else (DNS rebinding, CSRF)', async () => {
    const { url } = await serveHttp();
    const evilHost = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS, host: 'attacker.example:3001' }, body: INIT });
    expect(evilHost.status).toBe(403);
    const evilOrigin = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS, origin: 'http://evil.example' }, body: INIT });
    expect(evilOrigin.status).toBe(403);
    expect(evilOrigin.headers['access-control-allow-origin']).toBeUndefined();
    const localhost = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS, host: `localhost:${new URL(url).port}` }, body: INIT });
    expect(localhost.status).toBe(200);
  });

  it('serves an explicitly allowed Origin with CORS headers', async () => {
    const { url } = await serveHttp({}, { allowedOrigins: ['http://app.example'] });
    const res = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS, origin: 'http://app.example' }, body: INIT });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://app.example');
  });

  it('requires the bearer token, including for initialize, and creates no session without it', async () => {
    const { server, url } = await serveHttp();
    const missing = await raw(url, { headers: JSON_HEADERS, body: INIT });
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toContain('Bearer');
    const wrong = await raw(url, { headers: { ...JSON_HEADERS, authorization: 'Bearer nope' }, body: INIT });
    expect(wrong.status).toBe(401);
    const sse = await raw(url, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(sse.status).toBe(401);
    expect(server.audit.recent().filter(e => e.outcome === 'rejected' && e.httpStatus === 401)).toHaveLength(3);
    await expect(connectHttp(url, null)).rejects.toThrow();
  });

  it('can serve without a token only when asked to (--http-insecure)', async () => {
    const { url } = await serveHttp({}, { token: null });
    const client = await connectHttp(url, null);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('answers malformed bodies with 4xx errors and keeps serving', async () => {
    const { url } = await serveHttp({}, { maxBodyBytes: 1024 });
    const post = (body: string, headers: Record<string, string> = {}) => raw(url, { headers: { ...AUTH, ...JSON_HEADERS, ...headers }, body });

    expect((await post('null')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    expect((await post('[1,2]')).status).toBe(400);
    expect((await post('42')).status).toBe(400);
    const parse = await post('{not json');
    expect(parse.status).toBe(400);
    expect(JSON.parse(parse.body).error.code).toBe(-32700);
    expect((await post(INIT, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(2048) } }))).status).toBe(413);
    expect((await raw(url, { path: '/', headers: { ...AUTH, ...JSON_HEADERS }, body: INIT })).status).toBe(404);
    expect((await raw(url, { path: '/oauth/token', headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' })).status).toBe(404);
    expect((await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).status).toBe(400);
    expect((await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), { 'mcp-session-id': 'forged' })).status).toBe(404);

    // Still serving.
    const client = await connectHttp(url);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('survives a client that disconnects mid-body', async () => {
    const { server, url } = await serveHttp();
    const target = new URL(url);
    await new Promise<void>(resolvePromise => {
      const req = httpRequest({
        host: target.hostname, port: target.port, path: target.pathname, method: 'POST',
        headers: { ...AUTH, ...JSON_HEADERS, 'content-length': '100000' },
      });
      req.on('error', () => resolvePromise());
      req.write('{"jsonrpc":"2.0","id":1,"method":"initi');
      setTimeout(() => { req.destroy(); resolvePromise(); }, 50);
    });
    await new Promise(r => setTimeout(r, 50));
    const client = await connectHttp(url);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(server.audit.recent().some(e => e.outcome === 'rejected' && e.error?.includes('disconnected'))).toBe(true);
  });

  it('caps concurrent sessions and closes them on DELETE', async () => {
    const { url } = await serveHttp({}, { maxSessions: 1 });
    const first = await connectHttp(url);
    const second = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS }, body: INIT });
    expect(second.status).toBe(503);
    await (first.transport as StreamableHTTPClientTransport).terminateSession();
    await first.close();
    await connectHttp(url);
  });

  it('rate-limits per issued session, and per address for anything else', async () => {
    const { server, url } = await serveHttp({}, { rateLimitRPM: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS, 'mcp-session-id': `forged-${i}` }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'ping' }) });
      expect(res.status).toBe(404);
    }
    const limited = await raw(url, { headers: { ...AUTH, ...JSON_HEADERS, 'mcp-session-id': 'forged-99' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) });
    expect(limited.status).toBe(429);
    expect(server.audit.recent().some(e => e.httpStatus === 429 && e.outcome === 'rejected')).toBe(true);
  });

  it('refuses a wildcard bind without explicit allowed hosts', async () => {
    const server = new MCPServer({ sourcePath: fixtureArtifact, log: () => {} });
    running.push(server);
    await server.load();
    expect(() => server.createHttpHandler({ port: 0, host: '0.0.0.0', token: TOKEN })).toThrow('--allowed-host');
  });
});

// ---------------------------------------------------------------------------

describe('audit log records real outcomes (SC-SURF-27)', () => {
  it('records successes, tool errors, unknown tools and rejections, with tool id and call digest', async () => {
    const file = join(tmp(), 'audit.jsonl');
    const { server, url } = await serveHttp({ auditLog: new AuditLog({ file }) });
    await raw(url, { headers: JSON_HEADERS, body: INIT });
    const client = await connectHttp(url);
    await client.callTool({ name: 'fixture__echo', arguments: { text: 'a' } });
    await client.callTool({ name: 'fixture__fail', arguments: {} });
    await client.callTool({ name: 'nope', arguments: {} });

    const entries = server.audit.recent();
    expect(entries[0]).toMatchObject({ transport: 'http', method: 'http', outcome: 'rejected', httpStatus: 401 });
    expect(entries.find(e => e.method === 'initialize')).toMatchObject({ outcome: 'ok' });
    const calls = entries.filter(e => e.method === 'tools/call');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ outcome: 'ok', toolName: 'fixture__echo', toolId: 'fixture/echo' });
    expect(calls[0].callDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[1]).toMatchObject({ outcome: 'error', toolName: 'fixture__fail', toolId: 'fixture/fail' });
    expect(calls[2]).toMatchObject({ outcome: 'error', toolName: 'nope' });
    expect(calls[2].toolId).toBeUndefined();

    const lines = readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(entries.length);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf-8')).not.toContain('"text"');
  });
});

// ---------------------------------------------------------------------------

describe('resource subscriptions belong to their session (SC-SURF-29)', () => {
  it('notifies only the subscribing session and is released when the session closes', async () => {
    const { server, url } = await serveHttp();
    server.resources.registerHandler({
      providerId: 'test',
      list: async () => ({ resources: [{ uri: 'test://foo', name: 'foo', providerId: 'test' }] }),
      read: async uri => ({ uri, mimeType: 'text/plain', text: 'foo' }),
    });
    const a = await connectHttp(url);
    const b = await connectHttp(url);
    const seenA: string[] = [];
    const seenB: string[] = [];
    a.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { seenA.push(n.params.uri); });
    b.setNotificationHandler(ResourceUpdatedNotificationSchema, n => { seenB.push(n.params.uri); });

    // Open the standalone SSE streams notifications travel on.
    await a.subscribeResource({ uri: 'test://foo' });
    await a.subscribeResource({ uri: 'test://foo' }); // idempotent
    expect(server.resources.subscriptionCount()).toBe(1);
    await new Promise(r => setTimeout(r, 100));

    server.resources.notifyChange({ type: 'updated', uri: 'test://foo', timestamp: new Date().toISOString() });
    await new Promise(r => setTimeout(r, 200));
    expect(seenA).toEqual(['test://foo']);
    expect(seenB).toEqual([]);

    await (a.transport as StreamableHTTPClientTransport).terminateSession();
    await a.close();
    await new Promise(r => setTimeout(r, 50));
    expect(server.resources.subscriptionCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('programmatic tools and MCP Apps views', () => {
  it('registerApp stamps the tool with _meta.ui and serves the view', async () => {
    const { server, url } = await serveHttp();
    server.registerApp({
      tool: { name: 'weather_view', title: 'Weather', description: 'shows weather', inputSchema: { type: 'object' } },
      uiContent: '<html><body>weather</body></html>',
      executor: async () => ({ content: 'sunny', isError: false }),
    });
    expect(server.uiResources.getUriForTool('weather_view')).toBe('ui://smallchat/weather_view');

    const client = await connectHttp(url);
    const tool = (await client.listTools()).tools.find(t => t.name === 'weather_view')!;
    expect(tool._meta).toMatchObject({ ui: { resourceUri: 'ui://smallchat/weather_view' } });
    const view = await client.readResource({ uri: 'ui://smallchat/weather_view' });
    expect(view.contents[0]).toMatchObject({ mimeType: 'text/html;profile=mcp-app', text: expect.stringContaining('weather') });
    expect(text(await client.callTool({ name: 'weather_view', arguments: {} }) as CallToolResult)).toBe('sunny');
  });

  it('refuses a programmatic tool whose name the artifact already serves', async () => {
    const { server } = await serveHttp();
    expect(() => server.registerTool({ name: 'fixture__echo', inputSchema: { type: 'object' } })).toThrow('already served');
    expect(() => server.registerTool({ name: 'smallchat_resolve', inputSchema: { type: 'object' } })).toThrow('already served');
  });

  it('serves programmatic tools without an artifact', async () => {
    const server = new MCPServer({ log: () => {} });
    running.push(server);
    server.registerTool({ name: 'ping_tool', inputSchema: { type: 'object' } }, async () => ({ content: 'pong' }));
    const { url } = await server.startHttp({ port: 0, token: TOKEN });
    const client = await connectHttp(url);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['ping_tool']);
  });
});

// ---------------------------------------------------------------------------

describe('bearer token file', () => {
  it('is generated with mode 0600 and reused; a world-readable file is refused', () => {
    const path = join(tmp(), 'nested', 'serve-token');
    const first = ensureTokenFile(path);
    expect(first.created).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ensureTokenFile(path)).toEqual({ token: first.token, created: false });

    const loose = join(tmp(), 'loose-token');
    writeFileSync(loose, 'x'.repeat(40), { mode: 0o644 });
    expect(() => ensureTokenFile(loose)).toThrow('chmod 600');
  });
});

// ---------------------------------------------------------------------------

describe('stdio: compile → serve → call through the CLI', () => {
  it('passes the conformance checks and calls the fixture upstream', async () => {
    const checks = await runConformance(
      {
        kind: 'stdio',
        command: process.execPath,
        args: [VITE_NODE, '--root', REPO, CLI, '--', 'serve', '--source', fixtureArtifact],
        env: { FIXTURE_SECRET: 'from-cli-env' },
        cwd: tmp(),
      },
      { call: { name: 'fixture__env_probe' }, timeoutMs: 30_000 },
    );
    expect(checks.filter(c => !c.pass)).toEqual([]);
    expect(checks.find(c => c.name === 'tools/call fixture__env_probe')?.detail).toBe('secret:set');
  }, 60_000);

  it('serves the SDK client over stdio and exits when the client goes away', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [VITE_NODE, '--root', REPO, CLI, '--', 'serve', '--source', fixtureArtifact, '--provider', 'fixture'],
      env: { ...getDefaultEnvironment() },
      cwd: tmp(),
      stderr: 'ignore',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    const echo = await client.callTool({ name: 'echo', arguments: { text: 'over stdio' } }) as CallToolResult;
    expect(echo.content).toEqual([{ type: 'text', text: 'over stdio' }]);
    const pid = transport.pid!;
    await client.close();
    await new Promise(r => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);
});
