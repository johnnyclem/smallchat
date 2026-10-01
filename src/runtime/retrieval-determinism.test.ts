/**
 * Feature: retrieval correctness and determinism.
 *
 * Each "SC-INF-*" scenario reproduces an audit finding; it failed before
 * the fix. Scores are made deterministic with a scripted embedder: each
 * intent is a fixed unit vector and each tool vector sits at an exact cosine
 * from it.
 */

import { describe, it, expect } from 'vitest';
import { ToolRuntime } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { intentKey } from '../core/selector-table.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { WorkerVectorIndex } from '../embedding/worker-vector-index.js';
import type { EmbeddingWorkerBridge } from '../embedding/worker-embedder.js';
import type { ResolutionProof } from '../core/proof.js';
import type {
  DispatchEvent,
  Embedder,
  InferenceDelta,
  LLMClient,
  ToolIMP,
  ToolResult,
  ToolSchema,
  ToolTransport,
} from '../core/types.js';

// ---------------------------------------------------------------------------
// Scripted geometry
// ---------------------------------------------------------------------------

const DIMS = 16;

function axis(i: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
}

/** A unit vector at exactly `cosine` from e_from, completed along ±e_other. */
function toward(from: number, cosine: number, other: number, sign = 1): Float32Array {
  const v = new Float32Array(DIMS);
  v[from] = cosine;
  v[other] = sign * Math.sqrt(1 - cosine * cosine);
  return v;
}

/** Normalize a raw vector. */
function unit(values: Record<number, number>): Float32Array {
  const v = new Float32Array(DIMS);
  let n = 0;
  for (const [i, x] of Object.entries(values)) { v[Number(i)] = x; n += x * x; }
  for (let i = 0; i < DIMS; i++) v[i] /= Math.sqrt(n);
  return v;
}

/** Embedder with a fixed vector per text; unknown texts get the last axis. */
class ScriptedEmbedder implements Embedder {
  readonly dimensions = DIMS;
  readonly calls: string[] = [];
  constructor(private readonly table: Record<string, Float32Array>) {}
  async embed(text: string): Promise<Float32Array> {
    this.calls.push(text);
    return this.table[text] ?? axis(DIMS - 1);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

function localIMP(
  providerId: string,
  toolName: string,
  ran: string[],
  extra: Partial<ToolIMP> = {},
): ToolIMP {
  return {
    providerId,
    toolName,
    transportType: 'local',
    schema: null,
    schemaLoader: async () => ({ name: toolName, description: toolName.replace(/_/g, ' '), inputSchema: { type: 'object' }, arguments: [] }),
    execute: async () => {
      ran.push(`${providerId}/${toolName}`);
      return { content: `${toolName}:ran` };
    },
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
    ...extra,
  };
}

interface ToolSpec {
  provider: string;
  name: string;
  vector: Float32Array;
  imp?: Partial<ToolIMP>;
}

function build(intents: Record<string, Float32Array>, tools: ToolSpec[], options: RuntimeOptions = {}) {
  const embedder = new ScriptedEmbedder(intents);
  const index = new MemoryVectorIndex();
  const runtime = new ToolRuntime(index, embedder, options);
  const ran: string[] = [];
  const classes = new Map<string, ToolClass>();
  for (const t of tools) {
    let cls = classes.get(t.provider);
    if (!cls) { cls = new ToolClass(t.provider); classes.set(t.provider, cls); }
    cls.addMethod(runtime.selectorTable.register(t.vector, `${t.provider}.${t.name}`), localIMP(t.provider, t.name, ran, t.imp));
  }
  for (const cls of classes.values()) runtime.registerClass(cls);
  return { runtime, embedder, ran, index, classes };
}

const approve: LLMClient = { microCheck: async () => true };

function proofOf(result: ToolResult): ResolutionProof {
  return result.metadata!.proof as ResolutionProof;
}

// ---------------------------------------------------------------------------
// SC-INF-03 — canonicalize() erased negation and non-ASCII text, yet keyed
// the cache, interning and the semantic map
// ---------------------------------------------------------------------------

describe('SC-INF-03: identity keys on normalized full text, not canonicalize()', () => {
  it('a negated intent is embedded on its own and never served from the positive one\'s cache entry', async () => {
    const { runtime, embedder, ran } = build(
      { 'delete the logs': axis(0), 'do not delete the logs': axis(5) },
      [{ provider: 'ops', name: 'delete_logs', vector: toward(0, 0.9, 1) }],
    );

    const first = await runtime.dispatch('delete the logs', {});
    expect(first.isError).toBeFalsy();
    expect(ran).toEqual(['ops/delete_logs']);

    const second = await runtime.dispatch('do not delete the logs', {});
    expect(embedder.calls).toContain('do not delete the logs');
    expect(proofOf(second).decision).not.toBe('cache');
    expect(ran).toEqual(['ops/delete_logs']); // nothing else ran
    expect(second.isError).toBe(true);
  });

  it('two different non-Latin intents never share a cache entry', async () => {
    const { runtime, ran } = build(
      { '删除所有文件': axis(0), '查找航班': axis(2) },
      [
        { provider: 'fs', name: 'delete_all_files', vector: toward(0, 0.9, 1) },
        { provider: 'travel', name: 'search_flights', vector: toward(2, 0.9, 3) },
      ],
    );

    await runtime.dispatch('删除所有文件', {});
    const flights = await runtime.dispatch('查找航班', {});
    expect(flights.metadata?.toolId).toBe('travel/search_flights');
    expect(ran).toEqual(['fs/delete_all_files', 'travel/search_flights']);
  });

  it('a learned exact preference applies only to the same normalized text', async () => {
    const { runtime } = build(
      { 'delete the logs': axis(0), 'do not delete the logs': axis(5), 'Delete  the LOGS ': axis(0) },
      [{ provider: 'ops', name: 'delete_logs', vector: toward(0, 0.5, 1) }],
    );
    await runtime.reinforceRefinement('delete the logs', 'ops.delete_logs');

    const negated = await runtime.resolve('do not delete the logs');
    expect(negated.proof.decision).not.toBe('learned-exact');
    expect(negated.chosen).toBeUndefined();

    const sameText = await runtime.resolve('Delete  the LOGS ');
    expect(sameText.proof.decision).toBe('learned-exact');
    expect(sameText.chosen).toBe('ops/delete_logs');
  });

  it('intentKey keeps negation and non-ASCII text, and folds only case, NFC form and whitespace', () => {
    expect(intentKey('do not delete the logs')).not.toBe(intentKey('delete the logs'));
    expect(intentKey('查找航班')).not.toBe(intentKey('删除所有文件'));
    expect(intentKey('  Delete   the LOGS\n')).toBe(intentKey('delete the logs'));
    expect(intentKey('café')).toBe(intentKey('café'));
    expect(intentKey('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// SC-INF-13 — resolution depended on process history
// ---------------------------------------------------------------------------

describe('SC-INF-13: resolution does not depend on what the process saw earlier', () => {
  // A = e0, B at cosine 0.982 from A. archive_email is closer to A,
  // delete_email is closer to B; both are HIGH for their own intent.
  const A = axis(0);
  const B = unit({ 0: 0.982, 1: Math.sqrt(1 - 0.982 * 0.982) });
  const tools = (): ToolSpec[] => [
    { provider: 'mail', name: 'archive_email', vector: unit({ 0: 0.9, 1: -Math.sqrt(1 - 0.81) }) },
    { provider: 'mail', name: 'delete_email', vector: unit({ 0: 0.86, 1: Math.sqrt(1 - 0.86 * 0.86) }) },
  ];
  const intents = { 'archive the newsletter email': A, 'delete the newsletter email': B };

  it('an earlier, similar intent does not hand its vector to a later one', async () => {
    const fresh = build(intents, tools());
    const freshResult = await fresh.runtime.resolve('delete the newsletter email');
    expect(freshResult.chosen).toBe('mail/delete_email');

    const warmed = build(intents, tools());
    await warmed.runtime.dispatch('archive the newsletter email', {});
    const afterA = await warmed.runtime.dispatch('delete the newsletter email', {});
    expect(afterA.metadata?.toolId).toBe('mail/delete_email');
    expect(warmed.ran).toEqual(['mail/archive_email', 'mail/delete_email']);
  });

  it('earlier intents never crowd tools out of the candidate list', async () => {
    const intentsTable: Record<string, Float32Array> = { 'find tickets': axis(0) };
    for (let j = 1; j <= 13; j++) {
      intentsTable[`noise plus ${j}`] = toward(0, 0.9, j, 1);
      intentsTable[`noise minus ${j}`] = toward(0, 0.9, j, -1);
    }
    const { runtime } = build(intentsTable, [
      { provider: 'tickets', name: 'search_tickets', vector: toward(0, 0.65, 14) },
    ]);

    for (const text of Object.keys(intentsTable)) {
      if (text !== 'find tickets') await runtime.dispatch(text, {});
    }
    const r = await runtime.resolve('find tickets');
    expect(r.candidates.map(c => c.toolId)).toContain('tickets/search_tickets');
  });

  it('runtime intents never enter the tool vector index or the selector table', async () => {
    const { runtime, index } = build(
      { 'search docs': axis(0), 'list things': axis(2) },
      [{ provider: 'kb', name: 'search_docs', vector: toward(0, 0.9, 1) }],
    );
    await runtime.dispatch('search docs', {});
    await runtime.dispatch('list things', {});
    await runtime.resolve('something else entirely', { learn: true });
    expect(index.size()).toBe(1);
    expect(runtime.selectorTable.size).toBe(1);
  });

  it('a tool registered after an identical-looking intent is a tool, and reachable', async () => {
    const { runtime, ran } = build({ 'search docs': axis(0) }, []);
    const before = await runtime.dispatch('search docs', {});
    expect(before.isError).toBe(true);

    const sel = await runtime.selectorTable.intern(toward(0, 0.95, 1), 'search:docs');
    expect(sel.provenance).toBe('tool');
    const kb = new ToolClass('kb');
    kb.addMethod(sel, localIMP('kb', 'search_docs', ran));
    runtime.registerClass(kb);

    const after = await runtime.dispatch('search docs', {});
    expect(after.metadata?.toolId).toBe('kb/search_docs');
  });
});

// ---------------------------------------------------------------------------
// SC-INF-07 — swizzle / registerClass left stale cache and index entries
// ---------------------------------------------------------------------------

describe('SC-INF-07: registry changes invalidate cached resolutions and the dispatch index', () => {
  const intents = { 'check my balance': axis(0) };

  it('swizzle replaces the implementation hot intents execute', async () => {
    const { runtime, ran, classes } = build(intents, [
      { provider: 'bank', name: 'check_balance', vector: toward(0, 0.9, 1) },
    ]);
    await runtime.dispatch('check my balance', {});
    expect(ran).toEqual(['bank/check_balance']);

    const cls = classes.get('bank')!;
    const selector = runtime.selectorTable.get('bank.check_balance')!;
    runtime.swizzle(cls, selector, {
      ...localIMP('bank', 'check_balance', ran),
      execute: async () => { ran.push('stub'); return { content: 'maintenance' }; },
    });

    const result = await runtime.dispatch('check my balance', {});
    expect(result.content).toBe('maintenance');
    expect(ran).toEqual(['bank/check_balance', 'stub']);
  });

  it('re-registering a class replaces it: one owner, the new IMP, a usable tool id', async () => {
    const { runtime, ran } = build(intents, [
      { provider: 'bank', name: 'check_balance', vector: toward(0, 0.9, 1) },
    ]);
    await runtime.dispatch('check my balance', {});

    const replacement = new ToolClass('bank');
    replacement.addMethod(runtime.selectorTable.get('bank.check_balance')!, {
      ...localIMP('bank', 'check_balance', ran),
      execute: async () => { ran.push('v2'); return { content: 'v2' }; },
    });
    runtime.registerClass(replacement);

    expect(runtime.context.classesForSelector('bank.check_balance')).toEqual([replacement]);
    expect(runtime.getTool('bank/check_balance')).toBeDefined();
    const result = await runtime.dispatch('check my balance', {});
    expect(result.content).toBe('v2');
    expect((await runtime.dispatchById('bank/check_balance', {})).content).toBe('v2');
  });

  it('a better tool registered later wins over a cached resolution', async () => {
    const { runtime, ran } = build(intents, [
      { provider: 'legacy', name: 'balance', vector: toward(0, 0.86, 1) },
    ]);
    await runtime.dispatch('check my balance', {});

    const bank = new ToolClass('bank');
    bank.addMethod(runtime.selectorTable.register(toward(0, 0.99, 2), 'bank.check_balance'), localIMP('bank', 'check_balance', ran));
    runtime.registerClass(bank);

    const result = await runtime.dispatch('check my balance', {});
    expect(result.metadata?.toolId).toBe('bank/check_balance');
  });

  it('unregisterClass removes a provider and its cached resolutions', async () => {
    const { runtime } = build(intents, [
      { provider: 'bank', name: 'check_balance', vector: toward(0, 0.9, 1) },
    ]);
    await runtime.dispatch('check my balance', {});
    expect(runtime.unregisterClass('bank')).toBe(true);
    expect(runtime.getTool('bank/check_balance')).toBeUndefined();
    const result = await runtime.dispatch('check my balance', {});
    expect(result.isError).toBe(true);
    expect(result.metadata?.outcome).toBe('unresolved');
  });
});

// ---------------------------------------------------------------------------
// SC-INF-06 — the observer blacklisted correct tools from ordinary workflows
// ---------------------------------------------------------------------------

describe('SC-INF-06: no implicit corrections; negative examples only from explicit feedback', () => {
  const intents = { 'search issues about login': axis(0), 'open issue 42': axis(2) };
  const tools = (): ToolSpec[] => [
    { provider: 'gh', name: 'search_issues', vector: toward(0, 0.8, 1) },
    { provider: 'gh', name: 'search_prs', vector: toward(0, 0.78, 3) },
    { provider: 'gh', name: 'read_issue', vector: toward(2, 0.8, 4) },
  ];

  it('a search → open workflow does not blacklist the search tool', async () => {
    const { runtime } = build(intents, tools(), { llmClient: approve });
    expect((await runtime.dispatch('search issues about login', {})).metadata?.toolId).toBe('gh/search_issues');
    expect((await runtime.dispatch('open issue 42', {})).metadata?.toolId).toBe('gh/read_issue');

    const again = await runtime.dispatch('search issues about login', {});
    expect(again.metadata?.toolId).toBe('gh/search_issues');
    expect(runtime.observer.getNegativeExamples()).toHaveLength(0);
  });

  it('caller-side argument errors are not negative examples', async () => {
    const { runtime, ran } = build({ 'search issues about login': axis(0) }, [{
      provider: 'gh',
      name: 'search_issues',
      vector: toward(0, 0.9, 1),
      imp: {
        schemaLoader: async (): Promise<ToolSchema> => ({
          name: 'search_issues',
          description: 'search issues',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
          arguments: [],
        }),
      },
    }]);
    const bad = await runtime.dispatch('search issues about login', {});
    expect(bad.metadata?.outcome).toBe('invalid-arguments');
    const good = await runtime.dispatch('search issues about login', { q: 'login' });
    expect(good.metadata?.toolId).toBe('gh/search_issues');
    expect(ran).toEqual(['gh/search_issues']);
  });

  it('explicit feedback excludes a tool for that intent (and only that intent)', async () => {
    const { runtime } = build(intents, tools(), { llmClient: approve });
    runtime.feedback({ intent: 'search issues about login', toolId: 'gh/search_issues', correct: false });

    const r = await runtime.resolve('search issues about login');
    expect(r.chosen).toBe('gh/search_prs');
    expect(r.proof.candidates.find(c => c.toolId === 'gh/search_issues')?.excluded).toBe('negative-example');

    runtime.feedback({ intent: 'search issues about login', toolId: 'gh/search_issues', correct: true });
    expect((await runtime.resolve('search issues about login')).chosen).toBe('gh/search_issues');
  });

  it('implicit correction detection is available as an opt-in', async () => {
    const { runtime } = build(intents, tools(), { llmClient: approve, observerOptions: { implicitCorrections: true } });
    await runtime.dispatch('search issues about login', {});
    await runtime.dispatch('open issue 42', {});
    expect(runtime.observer.getNegativeExamples()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-10 — the default rate limiter denied service globally
// ---------------------------------------------------------------------------

describe('SC-INF-10: rate limiting is opt-in, per principal, and returns a typed result', () => {
  it('a default runtime resolves any number of distinct intents', async () => {
    const { runtime } = build({}, [{ provider: 'p', name: 't', vector: toward(DIMS - 1, 0.9, 1) }]);
    for (let i = 0; i < 120; i++) {
      const r = await runtime.resolve(`distinct intent number ${i}`);
      expect(r.outcome).toBe('resolved');
    }
  });

  it('an opted-in limiter throttles one principal without affecting another, and never throws', async () => {
    const { runtime, ran } = build({}, [{ provider: 'p', name: 't', vector: toward(DIMS - 1, 0.9, 1) }], {
      rateLimiter: { maxNovelIntents: 3 },
    });
    for (let i = 0; i < 3; i++) {
      expect((await runtime.resolve(`a ${i}`, { principal: 'alice' })).outcome).toBe('resolved');
    }
    const throttled = await runtime.resolve('a 4', { principal: 'alice' });
    expect(throttled.outcome).toBe('throttled');
    expect(throttled.proof.decision).toBe('rate-limited');

    const viaDispatch = await runtime.dispatch('a 5', {}, { principal: 'alice' });
    expect(viaDispatch.isError).toBe(true);
    expect(viaDispatch.metadata?.outcome).toBe('throttled');

    expect((await runtime.resolve('b 1', { principal: 'bob' })).outcome).toBe('resolved');
    expect(ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-12 — LOW-tier decomposition depth and fan-out
// ---------------------------------------------------------------------------

describe('SC-INF-12: decomposition is bounded in depth and fan-out', () => {
  const lowTool = (): ToolSpec[] => [{ provider: 'p', name: 'vague', vector: toward(DIMS - 1, 0.65, 14) }];

  it('a model that returns the intent itself is not followed', async () => {
    let calls = 0;
    const llm: LLMClient = {
      decompose: async ({ intent }) => { calls++; return { subIntents: [{ intent }], strategy: 'sequential' }; },
    };
    const { runtime } = build({}, lowTool(), { llmClient: llm });
    const result = await runtime.dispatch('do the vague thing', {});
    expect(calls).toBe(1);
    expect(result.metadata?.decomposed).toBeUndefined();
  });

  it('defaults to depth 2', async () => {
    let calls = 0;
    const llm: LLMClient = {
      decompose: async ({ intent }) => {
        calls++;
        return { subIntents: [{ intent: `${intent} / a` }, { intent: `${intent} / b` }], strategy: 'sequential' };
      },
    };
    const { runtime } = build({}, lowTool(), { llmClient: llm });
    await runtime.dispatch('do the vague thing', {});
    expect(calls).toBe(3); // depth 0 once, depth 1 twice, depth 2 never
  });

  it('caps the total number of sub-dispatches per request', async () => {
    let calls = 0;
    const llm: LLMClient = {
      decompose: async ({ intent }) => {
        calls++;
        return { subIntents: Array.from({ length: 10 }, (_, k) => ({ intent: `${intent} / ${k}` })), strategy: 'sequential' };
      },
    };
    const { runtime } = build({}, lowTool(), { llmClient: llm, maxDecompositionDepth: 1, maxSubDispatches: 4 });
    const result = await runtime.dispatch('do the vague thing', {});
    expect(calls).toBe(1);
    const results = (result.content as { results: Array<{ intent: string }> }).results;
    expect(results).toHaveLength(10);
    expect(results.filter(r => JSON.stringify(r).includes('sub-dispatch limit'))).toHaveLength(6);
  });

  it('concurrent dispatches decompose independently', async () => {
    const llm: LLMClient = {
      decompose: async ({ intent }) => {
        await new Promise(r => setTimeout(r, 5));
        return { subIntents: [{ intent: `${intent} / x` }], strategy: 'sequential' };
      },
    };
    const { runtime } = build({}, lowTool(), { llmClient: llm, maxDecompositionDepth: 1 });
    const [a, b] = await Promise.all([runtime.dispatch('first vague thing', {}), runtime.dispatch('second vague thing', {})]);
    expect(a.metadata?.decomposed).toBe(true);
    expect(b.metadata?.decomposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-26 — timeouts and generator cancellation did not stop the tool
// ---------------------------------------------------------------------------

describe('SC-INF-26: an AbortSignal reaches the tool', () => {
  function slowTool(seen: Array<AbortSignal | undefined>, ran: string[]): Partial<ToolIMP> {
    return {
      execute: async (_args, options) => {
        seen.push(options?.signal);
        await new Promise<void>(resolve => {
          const t = setTimeout(resolve, 500);
          options?.signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); });
        });
        ran.push('slow');
        return { content: 'late' };
      },
    };
  }

  it('withTimeout aborts the running tool', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const ran: string[] = [];
    const { runtime } = build({ 'run the slow job': axis(0) }, [
      { provider: 'jobs', name: 'slow', vector: toward(0, 0.9, 1), imp: slowTool(seen, ran) },
    ]);
    await expect(runtime.dispatch('run the slow job').withTimeout(20).exec()).rejects.toThrow(/timed out/);
    expect(seen[0]?.aborted).toBe(true);
  });

  it('an already-aborted signal runs nothing', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const ran: string[] = [];
    const { runtime } = build({ 'run the slow job': axis(0) }, [
      { provider: 'jobs', name: 'slow', vector: toward(0, 0.9, 1), imp: slowTool(seen, ran) },
    ]);
    const controller = new AbortController();
    controller.abort();
    const byId = await runtime.dispatchById('jobs/slow', {}, { signal: controller.signal });
    expect(byId.isError).toBe(true);
    expect(byId.metadata?.outcome).toBe('aborted');
    const byIntent = await runtime.dispatch('run the slow job', {}, { signal: controller.signal });
    expect(byIntent.metadata?.outcome).toBe('aborted');
    expect(seen).toHaveLength(0);
  });

  it('closing a dispatch stream aborts the streaming tool', async () => {
    let signal: AbortSignal | undefined;
    const { runtime } = build({ 'tail the log': axis(0) }, [{
      provider: 'logs',
      name: 'tail',
      vector: toward(0, 0.9, 1),
      imp: {
        executeStream: async function* (_args: Record<string, unknown>, options?: { signal?: AbortSignal }) {
          signal = options?.signal;
          for (let i = 0; ; i++) {
            if (options?.signal?.aborted) return;
            yield { content: `line ${i}` };
          }
        },
      } as Partial<ToolIMP>,
    }]);
    for await (const event of runtime.dispatchStream('tail the log', {})) {
      if (event.type === 'chunk') break;
    }
    expect(signal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-09 — streaming dispatch dropped non-MCP ToolProxy tools
// ---------------------------------------------------------------------------

describe('SC-INF-09: streaming dispatch executes every tool', () => {
  /** Transport shaped like MCPTransport for a non-'mcp' transport type. */
  function localTransport(counter: { calls: number }): ToolTransport {
    const execute = async (): Promise<ToolResult> => { counter.calls++; return { content: 'Sunny in Paris' }; };
    return {
      execute,
      async *executeStream() { yield await execute(); },
      // MCPTransport returns immediately for non-MCP transports
      async *executeInference(): AsyncGenerator<InferenceDelta> { /* nothing */ },
    };
  }

  function proxyRuntime(transport: ToolTransport) {
    const { runtime } = build({ 'weather in paris': axis(0) }, []);
    const cls = new ToolClass('weather');
    const proxy = new ToolProxy(
      'weather',
      'get_weather',
      'local',
      async () => ({ name: 'get_weather', description: 'weather', inputSchema: { type: 'object' }, arguments: [] }),
      undefined,
      undefined,
      () => transport,
    );
    cls.addMethod(runtime.selectorTable.register(toward(0, 0.9, 1), 'weather.get_weather'), proxy);
    runtime.registerClass(cls);
    return runtime;
  }

  async function collect(stream: AsyncGenerator<DispatchEvent>): Promise<DispatchEvent[]> {
    const events: DispatchEvent[] = [];
    for await (const e of stream) events.push(e);
    return events;
  }

  it('a local-transport ToolProxy runs once and its result is the done result', async () => {
    const counter = { calls: 0 };
    const runtime = proxyRuntime(localTransport(counter));
    const events = await collect(runtime.dispatchStream('weather in paris', {}));
    const done = events.find(e => e.type === 'done') as Extract<DispatchEvent, { type: 'done' }>;
    expect(done.result.content).toBe('Sunny in Paris');
    expect(counter.calls).toBe(1);

    const tokens: string[] = [];
    for await (const t of runtime.inferenceStream('weather in paris', {})) tokens.push(t);
    expect(tokens.join('')).toContain('Sunny in Paris');
  });

  it('an IMP whose inference stream yields nothing falls back to execute', async () => {
    let executed = 0;
    const { runtime } = build({ 'summarise it': axis(0) }, [{
      provider: 'ai',
      name: 'summarise',
      vector: toward(0, 0.9, 1),
      imp: {
        execute: async () => { executed++; return { content: 'summary' }; },
        executeInference: async function* () { /* zero deltas, no result */ },
      } as Partial<ToolIMP>,
    }]);
    const events = await collect(runtime.dispatchStream('summarise it', {}));
    const done = events.find(e => e.type === 'done') as Extract<DispatchEvent, { type: 'done' }>;
    expect(done.result.content).toBe('summary');
    expect(executed).toBe(1);
  });

  it('a non-streamed result returned by the inference stream is used, not re-executed', async () => {
    let executed = 0;
    const { runtime } = build({ 'summarise it': axis(0) }, [{
      provider: 'ai',
      name: 'summarise',
      vector: toward(0, 0.9, 1),
      imp: {
        execute: async () => { executed++; return { content: 'second run' }; },
        executeInference: async function* (): AsyncGenerator<InferenceDelta, ToolResult> {
          return { content: 'plain json reply' };
        },
      } as Partial<ToolIMP>,
    }]);
    const events = await collect(runtime.dispatchStream('summarise it', {}));
    const done = events.find(e => e.type === 'done') as Extract<DispatchEvent, { type: 'done' }>;
    expect(done.result.content).toBe('plain json reply');
    expect(executed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-17 — WorkerVectorIndex could not back a runtime
// ---------------------------------------------------------------------------

describe('SC-INF-17: a WorkerVectorIndex backs a ToolRuntime', () => {
  it('dispatch works through the async worker index', async () => {
    const backing = new MemoryVectorIndex();
    const bridge = {
      async request(type: string, payload: Record<string, unknown> = {}) {
        switch (type) {
          case 'vectorInsert': backing.insert(payload.id as string, payload.vector as Float32Array); return {};
          case 'vectorRemove': backing.remove(payload.id as string); return {};
          case 'vectorSearch': return { results: backing.search(payload.query as Float32Array, payload.topK as number, payload.threshold as number) };
          case 'vectorSize': return { size: backing.size() };
          default: throw new Error(`unexpected ${type}`);
        }
      },
    } as unknown as EmbeddingWorkerBridge;

    const embedder = new ScriptedEmbedder({ 'get the weather': axis(0) });
    const runtime = new ToolRuntime(new WorkerVectorIndex(bridge), embedder);
    const ran: string[] = [];
    const cls = new ToolClass('weather');
    cls.addMethod(runtime.selectorTable.register(toward(0, 0.9, 1), 'weather.get'), localIMP('weather', 'get', ran));
    runtime.registerClass(cls);

    const result = await runtime.dispatch('get the weather', {});
    expect(result.metadata?.toolId).toBe('weather/get');
    expect(await new WorkerVectorIndex(bridge).size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism — quantized scores, tie-break on canonical tool id
// ---------------------------------------------------------------------------

describe('Determinism: same artifact + same embedder + same runtime state ⇒ same outcome', () => {
  it('scores are quantized to 1e-4 and ties break on the canonical tool id', async () => {
    // zeta is ahead by 3e-5 — below the quantum, so the tie-break decides.
    const { runtime } = build({ 'run it': axis(0) }, [
      { provider: 'zeta', name: 'run', vector: toward(0, 0.90004, 1) },
      { provider: 'alpha', name: 'run', vector: toward(0, 0.90001, 2) },
    ]);
    const r = await runtime.resolve('run it');
    expect(r.candidates.map(c => c.toolId)).toEqual(['alpha/run', 'zeta/run']);
    expect(r.chosen).toBe('alpha/run');
    for (const c of r.candidates) expect(Math.round(c.score * 1e4) / 1e4).toBe(c.score);
  });

  it('registration order does not change which equally-scored tools are candidates', async () => {
    const names = ['g', 'f', 'e', 'd', 'c', 'b', 'a'];
    const specs = names.map((n, i) => ({ provider: 'p', name: n, vector: toward(0, 0.7, i + 1) }));
    const forward = build({ 'go': axis(0) }, specs);
    const reverse = build({ 'go': axis(0) }, [...specs].reverse());
    const r1 = await forward.runtime.resolve('go');
    const r2 = await reverse.runtime.resolve('go');
    expect(r1.candidates.map(c => c.toolId)).toEqual(r2.candidates.map(c => c.toolId));
    expect(r1.candidates.map(c => c.toolId)).toEqual(['p/a', 'p/b', 'p/c', 'p/d', 'p/e']);
    expect(r1.proof.proofDigest).toBe(r2.proof.proofDigest);
  });

  it('the proof of a resolution is identical before and after unrelated traffic', async () => {
    const intents = { 'archive mail': axis(0), 'other': axis(2), 'another': toward(0, 0.97, 3) };
    const { runtime } = build(intents, [
      { provider: 'mail', name: 'archive', vector: toward(0, 0.9, 1) },
      { provider: 'mail', name: 'other', vector: toward(2, 0.9, 1) },
    ]);
    const before = await runtime.resolve('archive mail');
    await runtime.dispatch('other', {});
    await runtime.dispatch('another', {});
    // learn: true takes the same path dispatch() does (interning, caching)
    const after = await runtime.resolve('archive mail', { learn: true });
    expect(after.proof.proofDigest).toBe(before.proof.proofDigest);
  });
});
