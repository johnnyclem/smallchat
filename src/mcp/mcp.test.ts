/**
 * MCP 2025-11-25 compliance test harness.
 *
 * Tests drive McpRouter directly (no HTTP layer) with an in-memory SQLite
 * session store. A mock broker captures emitted events.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MCPServer } from './index.js';
import { SessionManager } from './session.js';
import { ToolRegistry, ResourceRegistry, PromptRegistry } from './registry.js';
import { SseBroker } from './sse-broker.js';
import { McpRouter } from './router.js';
import { MCP_ERROR } from './types.js';
import type { JsonRpcRequest, McpTool, McpResource, McpPrompt } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRouter(opts?: {
  tools?: McpTool[];
  resources?: McpResource[];
  prompts?: McpPrompt[];
}): { router: McpRouter; sessions: SessionManager; tools: ToolRegistry; resources: ResourceRegistry; prompts: PromptRegistry; broker: SseBroker } {
  const sessions = new SessionManager(':memory:');
  const tools = new ToolRegistry();
  const resources = new ResourceRegistry();
  const prompts = new PromptRegistry();
  const broker = new SseBroker();

  for (const t of opts?.tools ?? []) tools.register(t);
  for (const r of opts?.resources ?? []) resources.register(r);
  for (const p of opts?.prompts ?? []) prompts.register(p);

  const router = new McpRouter(sessions, tools, resources, prompts, broker, {
    serverName: 'test-server',
    serverVersion: '0.0.1',
    sessionTtlMs: 3_600_000, // 1h for tests
  });

  return { router, sessions, tools, resources, prompts, broker };
}

/** Send a JSON-RPC request and return the response. */
async function send(
  router: McpRouter,
  method: string,
  params: Record<string, unknown> = {},
  id: number | string | null = 1,
  sessionId: string | null = null,
) {
  const req: JsonRpcRequest = { jsonrpc: '2.0', method, params };
  if (id !== null) (req as Record<string, unknown>).id = id;
  return router.handle(req, sessionId);
}

/** Initialize a fresh session and return the sessionId. */
async function initSession(router: McpRouter): Promise<string> {
  const res = await send(router, 'initialize', {
    client: { name: 'test-client', version: '1.0' },
    protocol: { versions: ['2025-11-25'] },
    capabilities: { tools: true },
  });
  expect(res).not.toBeNull();
  expect(res!.error).toBeUndefined();
  return (res!.result as Record<string, unknown>).session as unknown as { sessionId: string } extends { sessionId: string } ? string : never;
}

/** Better typed helper for the common init. */
async function init(
  router: McpRouter,
): Promise<string> {
  const res = await send(router, 'initialize', {
    client: { name: 'test-client', version: '1.0' },
    protocol: { versions: ['2025-11-25'] },
    capabilities: { tools: true },
  });
  expect(res?.error).toBeUndefined();
  const session = (res!.result as Record<string, unknown>).session as { sessionId: string };
  return session.sessionId;
}

// ---------------------------------------------------------------------------
// JSON-RPC correctness
// ---------------------------------------------------------------------------

describe('JSON-RPC correctness', () => {
  it('returns -32600 for missing jsonrpc field', async () => {
    const { router } = makeRouter();
    const raw = { id: 1, method: 'initialize', params: {} };
    const res = await router.handle(raw, null);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_REQUEST);
  });

  it('returns -32600 for array params', async () => {
    const { router } = makeRouter();
    const raw = { jsonrpc: '2.0', id: 1, method: 'ping', params: [1, 2, 3] };
    const res = await router.handle(raw, null);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns -32601 for unknown method', async () => {
    const { router } = makeRouter();
    const sessionId = await init(router);
    const res = await send(router, 'nonexistent/method', {}, 1, sessionId);
    expect(res?.error?.code).toBe(MCP_ERROR.METHOD_NOT_FOUND);
  });

  it('echoes back the request id (number)', async () => {
    const { router } = makeRouter();
    const res = await router.handle({ jsonrpc: '2.0', id: 42, method: 'unknown' }, null);
    expect(res?.id).toBe(42);
  });

  it('echoes back the request id (string)', async () => {
    const { router } = makeRouter();
    const res = await router.handle({ jsonrpc: '2.0', id: 'abc-123', method: 'unknown' }, null);
    expect(res?.id).toBe('abc-123');
  });

  it('returns null for notification (no id)', async () => {
    const { router } = makeRouter();
    const raw = { jsonrpc: '2.0', method: 'some/notification' };
    const res = await router.handle(raw, null);
    expect(res).toBeNull();
  });

  it('returns -32600 for non-object input', async () => {
    const { router } = makeRouter();
    const res = await router.handle('not an object', null);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_REQUEST);
  });

  it('returns -32600 for array input (batch unsupported)', async () => {
    const { router } = makeRouter();
    const res = await router.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }], null);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_REQUEST);
  });

  it('always includes jsonrpc 2.0 in response', async () => {
    const { router } = makeRouter();
    const res = await router.handle({ jsonrpc: '2.0', id: 1, method: 'unknown' }, null);
    expect(res?.jsonrpc).toBe('2.0');
  });
});

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('returns session, protocol, features on fresh init', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'initialize', {
      client: { name: 'my-client', version: '2.0' },
      protocol: { versions: ['2025-11-25'] },
      capabilities: { tools: true },
    });
    expect(res?.error).toBeUndefined();
    const result = res!.result as Record<string, unknown>;
    expect((result.session as Record<string, unknown>).state).toBe('new');
    expect((result.protocol as Record<string, unknown>).selectedVersion).toBe('2025-11-25');
    expect((result.features as Record<string, unknown>).apps).toBe(false);
    expect((result.features as Record<string, unknown>).sessions).toBe(true);
    expect((result.auth as Record<string, unknown>).mode).toBe('none');
    expect((result.endpoints as Record<string, unknown>).rpc).toBe('/mcp');
    expect((result.endpoints as Record<string, unknown>).sse).toBe('/mcp/sse');
  });

  it('returns -32000 for unsupported protocol version', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'initialize', {
      client: { name: 'c', version: '1' },
      protocol: { versions: ['1999-01-01'] },
      capabilities: {},
    });
    expect(res?.error?.code).toBe(MCP_ERROR.UNSUPPORTED_VERSION);
    expect((res?.error?.data as Record<string, unknown>)?.supportedVersions).toBeDefined();
  });

  it('returns -32602 for missing client.name', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'initialize', {
      client: { version: '1.0' },
      protocol: { versions: ['2025-11-25'] },
      capabilities: {},
    });
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns -32602 for missing protocol.versions', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'initialize', {
      client: { name: 'c', version: '1' },
      protocol: {},
      capabilities: {},
    });
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('resumes an existing session', async () => {
    const { router } = makeRouter();
    const sessionId = await init(router);

    const res = await send(router, 'initialize', {
      client: { name: 'test-client', version: '1.0' },
      protocol: { versions: ['2025-11-25'] },
      capabilities: { tools: true },
      session: { sessionId, resume: true },
    });
    expect(res?.error).toBeUndefined();
    const result = res!.result as Record<string, unknown>;
    expect((result.session as Record<string, unknown>).state).toBe('resumed');
    expect((result.session as Record<string, unknown>).sessionId).toBe(sessionId);
  });

  it('returns -32001 for resume of unknown session', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'initialize', {
      client: { name: 'c', version: '1' },
      protocol: { versions: ['2025-11-25'] },
      capabilities: {},
      session: { sessionId: 'unknown-id', resume: true },
    });
    expect(res?.error?.code).toBe(MCP_ERROR.SESSION_EXPIRED);
    expect((res?.error?.data as Record<string, unknown>)?.action).toBe('reinitialize');
  });

  it('picks the first matching supported version', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'initialize', {
      client: { name: 'c', version: '1' },
      protocol: { versions: ['1999-01-01', '2025-11-25'] },
      capabilities: {},
    });
    expect(res?.error).toBeUndefined();
    const result = res!.result as Record<string, unknown>;
    expect((result.protocol as Record<string, unknown>).selectedVersion).toBe('2025-11-25');
  });
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe('ping', () => {
  it('returns -32010 when no session', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'ping', {}, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('returns -32010 with wrong session id', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'ping', {}, 1, 'bad-id');
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('returns ok:true after valid init', async () => {
    const { router } = makeRouter();
    const sessionId = await init(router);
    const res = await send(router, 'ping', {}, 2, sessionId);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).ok).toBe(true);
    expect((res!.result as Record<string, unknown>).ts).toBeDefined();
  });

  it('updates lastSeenAt', async () => {
    const { router, sessions } = makeRouter();
    const sessionId = await init(router);
    const before = sessions.get(sessionId)!.lastSeenAt;
    await new Promise((r) => setTimeout(r, 5)); // small delay
    await send(router, 'ping', {}, 2, sessionId);
    const after = sessions.get(sessionId)!.lastSeenAt;
    expect(after >= before).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe('shutdown', () => {
  it('returns -32010 when no session', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'shutdown', {}, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('returns ok:true and closes session', async () => {
    const { router, sessions } = makeRouter();
    const sessionId = await init(router);
    const res = await send(router, 'shutdown', {}, 2, sessionId);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).ok).toBe(true);
    expect(sessions.get(sessionId)!.status).toBe('closed');
  });

  it('subsequent calls return -32011 after shutdown', async () => {
    const { router } = makeRouter();
    const sessionId = await init(router);
    await send(router, 'shutdown', {}, 2, sessionId);
    const res = await send(router, 'ping', {}, 3, sessionId);
    expect(res?.error?.code).toBe(MCP_ERROR.SESSION_CLOSED);
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('tools/list', () => {
  const sampleTools: McpTool[] = [
    { id: 'p:tool-a', name: 'tool_a', title: 'Tool A', description: 'First', inputSchema: { type: 'object' } },
    { id: 'p:tool-b', name: 'tool_b', title: 'Tool B', description: 'Second', inputSchema: { type: 'object' } },
    { id: 'p:tool-c', name: 'tool_c', title: 'Tool C', description: 'Third', inputSchema: { type: 'object' } },
  ];

  it('returns empty list when no tools registered', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'tools/list', {}, 2, sid);
    expect(res?.error).toBeUndefined();
    const result = res!.result as Record<string, unknown>;
    expect(result.tools).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.snapshot).toBeDefined();
  });

  it('returns all tools when within limit', async () => {
    const { router } = makeRouter({ tools: sampleTools });
    const sid = await init(router);
    const res = await send(router, 'tools/list', {}, 2, sid);
    const result = res!.result as Record<string, unknown>;
    expect((result.tools as unknown[]).length).toBe(3);
    expect(result.nextCursor).toBeNull();
  });

  it('paginates with cursor', async () => {
    const { router } = makeRouter({ tools: sampleTools });
    const sid = await init(router);

    // Page 1: limit 2
    const res1 = await send(router, 'tools/list', { limit: 2 }, 2, sid);
    const r1 = res1!.result as Record<string, unknown>;
    expect((r1.tools as unknown[]).length).toBe(2);
    expect(r1.nextCursor).not.toBeNull();

    // Page 2
    const res2 = await send(router, 'tools/list', { cursor: r1.nextCursor, limit: 2 }, 3, sid);
    const r2 = res2!.result as Record<string, unknown>;
    expect((r2.tools as unknown[]).length).toBe(1);
    expect(r2.nextCursor).toBeNull();
  });

  it('returns -32020 for stale cursor after re-register', async () => {
    const { router, tools } = makeRouter({ tools: sampleTools });
    const sid = await init(router);
    const res1 = await send(router, 'tools/list', { limit: 2 }, 2, sid);
    const cursor = (res1!.result as Record<string, unknown>).nextCursor as string;

    // Re-register a tool → version bumped
    tools.register({ id: 'p:tool-d', name: 'tool_d', title: 'D', description: 'D', inputSchema: {} });

    const res2 = await send(router, 'tools/list', { cursor }, 3, sid);
    expect(res2?.error?.code).toBe(MCP_ERROR.INVALID_CURSOR);
    expect((res2?.error?.data as Record<string, unknown>)?.action).toBe('relist');
  });

  it('clamps limit to 200', async () => {
    const { router } = makeRouter({ tools: sampleTools });
    const sid = await init(router);
    const res = await send(router, 'tools/list', { limit: 999 }, 2, sid);
    // Should not error — clamped internally
    expect(res?.error).toBeUndefined();
  });

  it('returns -32602 for invalid limit', async () => {
    const { router } = makeRouter({ tools: sampleTools });
    const sid = await init(router);
    const res = await send(router, 'tools/list', { limit: 0 }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('requires initialized session', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'tools/list', {}, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('includes snapshot in response', async () => {
    const { router } = makeRouter({ tools: sampleTools });
    const sid = await init(router);
    const res = await send(router, 'tools/list', {}, 2, sid);
    expect(typeof (res!.result as Record<string, unknown>).snapshot).toBe('string');
  });

  // ---------------------------------------------------------------------------
  // Compact wire format (TOON-inspired)
  // ---------------------------------------------------------------------------

  // Build a payload large enough that auto-negotiation will choose compact.
  const largeTools: McpTool[] = Array.from({ length: 12 }, (_, i) => ({
    id: `loom:tool-${i}`,
    name: `tool_${i}`,
    title: `Tool ${i}`,
    description: `Tool number ${i} with a deliberately verbose description so packed rows save bytes`,
    inputSchema: { type: 'object' },
  }));

  it('omits compact envelope by default (format absent)', async () => {
    const { router } = makeRouter({ tools: largeTools });
    const sid = await init(router);
    const res = await send(router, 'tools/list', {}, 2, sid);
    const result = res!.result as Record<string, unknown>;
    expect(result.__sc_wire).toBeUndefined();
    expect(Array.isArray(result.tools)).toBe(true);
  });

  it('returns a wrapped envelope when format="compact"', async () => {
    const { router } = makeRouter({ tools: largeTools });
    const sid = await init(router);
    const res = await send(router, 'tools/list', { format: 'compact' }, 2, sid);
    const result = res!.result as Record<string, unknown>;
    expect(result.__sc_wire).toBe(1);
    expect(result.data).toBeDefined();
  });

  it('decoded compact response equals JSON response', async () => {
    const { router } = makeRouter({ tools: largeTools });
    const sid = await init(router);

    const jsonRes = await send(router, 'tools/list', {}, 2, sid);
    const compactRes = await send(router, 'tools/list', { format: 'compact' }, 3, sid);

    const { unwrap } = await import('./wire-format.js');
    const decoded = unwrap(compactRes!.result as never);
    expect(decoded).toEqual(jsonRes!.result);
  });

  it('format="auto" picks compact for a large tools/list and saves >=15% bytes', async () => {
    const { router } = makeRouter({ tools: largeTools });
    const sid = await init(router);

    const jsonRes = await send(router, 'tools/list', { format: 'json' }, 2, sid);
    const autoRes = await send(router, 'tools/list', { format: 'auto' }, 3, sid);

    const result = autoRes!.result as Record<string, unknown>;
    expect(result.__sc_wire).toBe(1);

    const jsonBytes = Buffer.byteLength(JSON.stringify(jsonRes!.result), 'utf8');
    const autoBytes = Buffer.byteLength(JSON.stringify(autoRes!.result), 'utf8');
    const savings = (jsonBytes - autoBytes) / jsonBytes;
    expect(savings).toBeGreaterThanOrEqual(0.15);
  });

  it('format="auto" stays JSON for an empty tools list', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'tools/list', { format: 'auto' }, 2, sid);
    const result = res!.result as Record<string, unknown>;
    expect(result.__sc_wire).toBeUndefined();
    expect(result.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tools/listRanked — token-budgeted, BM25-ranked tool slice
// ---------------------------------------------------------------------------

describe('tools/listRanked', () => {
  const rankingTools: McpTool[] = [
    {
      id: 'loom:search_symbols',
      name: 'loom_search_symbols',
      title: 'Search symbols',
      description: 'Search symbols by name in the indexed code workspace',
      inputSchema: { type: 'object' },
    },
    {
      id: 'loom:find_dead_code',
      name: 'loom_find_dead_code',
      title: 'Find dead code',
      description: 'Identify unreachable symbols in the codebase',
      inputSchema: { type: 'object' },
    },
    {
      id: 'loom:remember',
      name: 'loom_remember',
      title: 'Remember',
      description: 'Store a fact for later sessions',
      inputSchema: { type: 'object' },
    },
  ];

  it('rejects a missing query', async () => {
    const { router } = makeRouter({ tools: rankingTools });
    const sid = await init(router);
    const res = await send(router, 'tools/listRanked', { tokenBudget: 100 }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('rejects a non-positive tokenBudget', async () => {
    const { router } = makeRouter({ tools: rankingTools });
    const sid = await init(router);
    const res = await send(router, 'tools/listRanked', { query: 'x', tokenBudget: 0 }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns highest-scoring tool when budget only fits one', async () => {
    const { router } = makeRouter({ tools: rankingTools });
    const sid = await init(router);
    // Pick a budget tight enough to keep just one or two tools.
    const res = await send(
      router,
      'tools/listRanked',
      { query: 'find a symbol by name in the code', tokenBudget: 60 },
      2,
      sid,
    );
    const result = res!.result as Record<string, unknown>;
    const tools = result.tools as Array<{ id: string }>;
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].id).toBe('loom:search_symbols');
    expect(['budget', 'candidates']).toContain(result.exhausted);
  });

  it('reports excluded tools when the budget is exhausted', async () => {
    const { router } = makeRouter({ tools: rankingTools });
    const sid = await init(router);
    const res = await send(
      router,
      'tools/listRanked',
      { query: 'symbol code', tokenBudget: 50 },
      2,
      sid,
    );
    const result = res!.result as Record<string, unknown>;
    const excluded = result.excluded as Array<{ id: string }>;
    if (result.exhausted === 'budget') {
      expect(excluded.length).toBeGreaterThan(0);
    }
    expect(typeof result.totalTokens).toBe('number');
    expect(result.totalTokens).toBeLessThanOrEqual(50);
  });

  it('honours format="compact"', async () => {
    const { router } = makeRouter({ tools: rankingTools });
    const sid = await init(router);
    const res = await send(
      router,
      'tools/listRanked',
      { query: 'symbol', tokenBudget: 1000, format: 'compact' },
      2,
      sid,
    );
    const result = res!.result as Record<string, unknown>;
    expect(result.__sc_wire).toBe(1);
  });

  it('exhausted="candidates" when budget exceeds the registry size', async () => {
    const { router } = makeRouter({ tools: rankingTools });
    const sid = await init(router);
    const res = await send(
      router,
      'tools/listRanked',
      { query: 'symbol', tokenBudget: 100_000 },
      2,
      sid,
    );
    const result = res!.result as Record<string, unknown>;
    expect(result.exhausted).toBe('candidates');
    expect((result.tools as unknown[]).length).toBe(rankingTools.length);
  });
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

describe('tools/call', () => {
  const tool: McpTool = {
    id: 'test:greet',
    name: 'greet',
    title: 'Greet',
    description: 'Say hello',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  };

  it('requires initialized session', async () => {
    const { router } = makeRouter({ tools: [tool] });
    const res = await send(router, 'tools/call', { toolId: 'test:greet', arguments: {} }, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('returns -32040 for unknown tool', async () => {
    const { router } = makeRouter({ tools: [tool] });
    const sid = await init(router);
    const res = await send(router, 'tools/call', { toolId: 'nope', arguments: {} }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.TOOL_NOT_FOUND);
  });

  it('returns -32602 for missing toolId', async () => {
    const { router } = makeRouter({ tools: [tool] });
    const sid = await init(router);
    const res = await send(router, 'tools/call', { arguments: {} }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns -32602 for array arguments', async () => {
    const { router } = makeRouter({ tools: [tool] });
    const sid = await init(router);
    const res = await send(router, 'tools/call', { toolId: 'test:greet', arguments: [] }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns started status with SSE stream info', async () => {
    const { router } = makeRouter({ tools: [tool] });
    const sid = await init(router);
    const res = await send(router, 'tools/call', { toolId: 'test:greet', arguments: { name: 'world' } }, 2, sid);
    expect(res?.error).toBeUndefined();
    const result = res!.result as Record<string, unknown>;
    expect(result.status).toBe('started');
    expect(result.invocationId).toBeDefined();
    const stream = result.stream as Record<string, unknown>;
    expect(stream.type).toBe('sse');
    expect(stream.sessionId).toBe(sid);
  });
});

// ---------------------------------------------------------------------------
// resources/*
// ---------------------------------------------------------------------------

describe('resources/list', () => {
  it('returns empty list', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'resources/list', {}, 2, sid);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).resources).toEqual([]);
  });

  it('returns registered resources', async () => {
    const resource: McpResource = { id: 'r1', name: 'doc', title: 'Doc', description: 'A doc', mimeType: 'text/plain' };
    const { router } = makeRouter({ resources: [resource] });
    const sid = await init(router);
    const res = await send(router, 'resources/list', {}, 2, sid);
    const result = res!.result as Record<string, unknown>;
    expect((result.resources as unknown[]).length).toBe(1);
  });
});

describe('resources/read', () => {
  it('returns -32050 for unknown resource', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'resources/read', { resourceId: 'nope' }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.RESOURCE_NOT_FOUND);
  });

  it('returns -32602 for missing resourceId', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'resources/read', {}, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns content for existing resource', async () => {
    const resource: McpResource = { id: 'r1', name: 'doc', title: 'Doc', description: 'A doc', mimeType: 'text/plain' };
    const { router } = makeRouter({ resources: [resource] });
    const sid = await init(router);
    const res = await send(router, 'resources/read', { resourceId: 'r1' }, 2, sid);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).resourceId).toBe('r1');
    expect((res!.result as Record<string, unknown>).content).toBeDefined();
  });
});

describe('resources/subscribe', () => {
  it('returns -32050 for unknown resource', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'resources/subscribe', { resourceId: 'nope' }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.RESOURCE_NOT_FOUND);
  });

  it('returns subscriptionId for existing resource', async () => {
    const resource: McpResource = { id: 'r1', name: 'doc', title: 'Doc', description: 'A doc' };
    const { router } = makeRouter({ resources: [resource] });
    const sid = await init(router);
    const res = await send(router, 'resources/subscribe', { resourceId: 'r1' }, 2, sid);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).ok).toBe(true);
    expect(typeof (res!.result as Record<string, unknown>).subscriptionId).toBe('string');
  });

  it('is idempotent — same subscriptionId for duplicate subscribe', async () => {
    const resource: McpResource = { id: 'r1', name: 'doc', title: 'Doc', description: 'A doc' };
    const { router } = makeRouter({ resources: [resource] });
    const sid = await init(router);
    const res1 = await send(router, 'resources/subscribe', { resourceId: 'r1' }, 2, sid);
    const res2 = await send(router, 'resources/subscribe', { resourceId: 'r1' }, 3, sid);
    expect((res1!.result as Record<string, unknown>).subscriptionId).toBe(
      (res2!.result as Record<string, unknown>).subscriptionId,
    );
  });
});

// ---------------------------------------------------------------------------
// prompts/*
// ---------------------------------------------------------------------------

describe('prompts/list', () => {
  it('returns empty list when none registered', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'prompts/list', {}, 2, sid);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).prompts).toEqual([]);
  });

  it('returns registered prompts', async () => {
    const prompt: McpPrompt = { id: 'p1', name: 'greet', title: 'Greet', description: 'Hello prompt' };
    const { router } = makeRouter({ prompts: [prompt] });
    const sid = await init(router);
    const res = await send(router, 'prompts/list', {}, 2, sid);
    expect((res!.result as Record<string, unknown>).prompts as unknown[]).toHaveLength(1);
  });
});

describe('prompts/get', () => {
  it('returns -32060 for unknown prompt', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'prompts/get', { promptId: 'nope' }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.PROMPT_NOT_FOUND);
  });

  it('returns -32602 for missing promptId', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'prompts/get', {}, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });

  it('returns prompt for existing id', async () => {
    const prompt: McpPrompt = { id: 'p1', name: 'greet', title: 'Greet', description: 'Hello', template: 'Hello {{name}}' };
    const { router } = makeRouter({ prompts: [prompt] });
    const sid = await init(router);
    const res = await send(router, 'prompts/get', { promptId: 'p1' }, 2, sid);
    expect(res?.error).toBeUndefined();
    expect((res!.result as Record<string, unknown>).prompt).toBeDefined();
  });
});

describe('prompts/render', () => {
  it('returns -32060 for unknown prompt', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'prompts/render', { promptId: 'nope' }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.PROMPT_NOT_FOUND);
  });

  it('renders a prompt with messages', async () => {
    const prompt: McpPrompt = { id: 'p1', name: 'greet', title: 'Greet', description: 'Hello', template: 'Hello world' };
    const { router } = makeRouter({ prompts: [prompt] });
    const sid = await init(router);
    const res = await send(router, 'prompts/render', { promptId: 'p1', arguments: { name: 'Alice' } }, 2, sid);
    expect(res?.error).toBeUndefined();
    const result = res!.result as Record<string, unknown>;
    expect(result.promptId).toBe('p1');
    expect(result.rendered).toBeDefined();
    expect((result.rendered as Record<string, unknown>).messages).toBeDefined();
  });

  it('returns -32602 for array arguments', async () => {
    const prompt: McpPrompt = { id: 'p1', name: 'greet', title: 'Greet', description: 'Hello' };
    const { router } = makeRouter({ prompts: [prompt] });
    const sid = await init(router);
    const res = await send(router, 'prompts/render', { promptId: 'p1', arguments: [] }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_PARAMS);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('session lifecycle', () => {
  it('creates a session on initialize and stores it', async () => {
    const { router, sessions } = makeRouter();
    const sid = await init(router);
    const session = sessions.get(sid);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(session!.clientName).toBe('test-client');
  });

  it('session is active after init and ping', async () => {
    const { router, sessions } = makeRouter();
    const sid = await init(router);
    await send(router, 'ping', {}, 2, sid);
    expect(sessions.get(sid)!.status).toBe('active');
  });

  it('session is closed after shutdown', async () => {
    const { router, sessions } = makeRouter();
    const sid = await init(router);
    await send(router, 'shutdown', {}, 2, sid);
    expect(sessions.get(sid)!.status).toBe('closed');
  });

  it('TTL-expired session returns -32001', async () => {
    const sessions = new SessionManager(':memory:');
    const tools = new ToolRegistry();
    const resources = new ResourceRegistry();
    const prompts = new PromptRegistry();
    const broker = new SseBroker();
    const router = new McpRouter(sessions, tools, resources, prompts, broker, {
      serverName: 'test',
      serverVersion: '0.0.1',
      sessionTtlMs: 1, // expire immediately
    });

    const res = await router.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          client: { name: 'c', version: '1' },
          protocol: { versions: ['2025-11-25'] },
          capabilities: {},
        },
      },
      null,
    );
    const sid = ((res!.result as Record<string, unknown>).session as { sessionId: string }).sessionId;

    // Wait for TTL to pass
    await new Promise((r) => setTimeout(r, 5));

    const ping = await router.handle({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} }, sid);
    expect(ping?.error?.code).toBe(MCP_ERROR.SESSION_EXPIRED);
  });

  it('two separate inits create two independent sessions', async () => {
    const { router } = makeRouter();
    const sid1 = await init(router);
    const sid2 = await init(router);
    expect(sid1).not.toBe(sid2);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('pre-init tools/list returns -32010', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'tools/list', {}, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('pre-init resources/list returns -32010', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'resources/list', {}, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('pre-init prompts/list returns -32010', async () => {
    const { router } = makeRouter();
    const res = await send(router, 'prompts/list', {}, 1, null);
    expect(res?.error?.code).toBe(MCP_ERROR.NOT_INITIALIZED);
  });

  it('null id in request returns null id in response', async () => {
    const { router } = makeRouter();
    const res = await router.handle({ jsonrpc: '2.0', id: null, method: 'unknown' }, null);
    expect(res?.id).toBeNull();
  });

  it('handles invalid cursor gracefully', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'tools/list', { cursor: 'not-valid-base64url!!!' }, 2, sid);
    expect(res?.error?.code).toBe(MCP_ERROR.INVALID_CURSOR);
  });

  it('handles empty cursor string as no cursor', async () => {
    const { router } = makeRouter();
    const sid = await init(router);
    const res = await send(router, 'tools/list', { cursor: '' }, 2, sid);
    // Empty cursor = first page
    expect(res?.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MCPServer integration
// ---------------------------------------------------------------------------

describe('MCPServer class', () => {
  it('creates server and accepts tool registration', () => {
    const server = new MCPServer({ dbPath: ':memory:' });
    expect(() => {
      server.registerTool({ id: 'p:t', name: 't', title: 'T', description: 'd', inputSchema: {} });
    }).not.toThrow();
    server.close();
  });

  it('createHttpHandler returns a function', () => {
    const server = new MCPServer({ dbPath: ':memory:' });
    const handler = server.createHttpHandler();
    expect(typeof handler).toBe('function');
    server.close();
  });
});
