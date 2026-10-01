/**
 * Feature: exact by construction — resolve/execute split, argument
 * validation, one dispatch policy on every path, replayable proofs.
 *
 * Each "SC-INF-*" scenario reproduces an audit finding; it failed before
 * the fix. Scores are made deterministic with a scripted embedder: each
 * intent is a basis vector and each tool vector sits at an exact cosine
 * from it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRuntime, runtimeOptionsFromPolicy } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';
import { DispatchContext, toolkit_dispatch } from './dispatch.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { IntentPinRegistry } from '../core/intent-pin.js';
import { createSignature, param, SCType } from '../core/sc-types.js';
import { callDigest } from '../core/call-digest.js';
import { computeProofDigest } from '../core/proof.js';
import type { ResolutionProof } from '../core/proof.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { buildArtifact } from '../artifact/format.js';
import { writeArtifact } from '../artifact/io.js';
import { loadRuntime } from '../mcp/artifact.js';
import { MCPServer } from '../mcp/server.js';
import { registerLocalHandler, unregisterLocalHandler } from '../mcp/transport.js';
import type { Embedder, LLMClient, ProviderManifest, ToolAnnotations, ToolIMP, ToolResult } from '../core/types.js';

// ---------------------------------------------------------------------------
// Scripted geometry
// ---------------------------------------------------------------------------

const DIMS = 16;

/** Unit basis vector e_i. */
function axis(i: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[i] = 1;
  return v;
}

/** A unit vector at exactly `cosine` from e_from, completed along e_other. */
function toward(from: number, cosine: number, other: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[from] = cosine;
  v[other] = Math.sqrt(1 - cosine * cosine);
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

/** A runtime with one class `providerId` holding tools at scripted vectors. */
function scriptedRuntime(
  intents: Record<string, Float32Array>,
  providerId: string,
  tools: Array<{ name: string; vector: Float32Array; annotations?: ToolAnnotations; description?: string }>,
  options: RuntimeOptions = {},
) {
  const embedder = new ScriptedEmbedder(intents);
  const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder, options);
  const ran: string[] = [];
  const cls = new ToolClass(providerId);
  for (const t of tools) {
    const description = t.description;
    cls.addMethod(
      runtime.selectorTable.register(t.vector, `${providerId}.${t.name}`),
      localIMP(providerId, t.name, ran, {
        annotations: t.annotations,
        ...(description ? { schemaLoader: async () => ({ name: t.name, description, inputSchema: { type: 'object' }, arguments: [] }) } : {}),
      }),
    );
  }
  runtime.registerClass(cls);
  return { runtime, embedder, ran };
}

const approve: LLMClient = { microCheck: async () => true };

function proofOf(result: ToolResult): ResolutionProof {
  return result.metadata!.proof as ResolutionProof;
}

// ---------------------------------------------------------------------------
// SC-INF-05 — the overload branch bypassed ranking, tiers and guards
// ---------------------------------------------------------------------------

describe('SC-INF-05: overloaded selectors are ranked like every other candidate', () => {
  function fsRuntime(options: RuntimeOptions = {}) {
    const embedder = new ScriptedEmbedder({ 'read the config file': axis(0) });
    const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder, options);
    const ran: string[] = [];

    const fs = new ToolClass('fs');
    fs.addMethod(runtime.selectorTable.register(toward(0, 0.78, 1), 'fs.read_file'), localIMP('fs', 'read_file', ran));
    runtime.registerClass(fs);
    const deleteSel = runtime.selectorTable.register(toward(0, 0.61, 2), 'fs.delete_path');
    runtime.addOverload(fs, deleteSel, createSignature([param('path', 0, SCType.string(), true)]), localIMP('fs', 'delete_path', ran));
    runtime.addOverload(
      fs,
      deleteSel,
      createSignature([param('path', 0, SCType.string(), true), param('recursive', 1, SCType.boolean(), true)]),
      localIMP('fs', 'delete_path_recursive', ran),
    );
    return { runtime, ran };
  }

  it('does not run a LOW overloaded tool over a better non-overloaded match', async () => {
    const { runtime, ran } = fsRuntime({ requireLLMForSubHighDispatch: true });

    const result = await runtime.dispatch('read the config file', { path: 'config.yaml' });

    expect(ran).not.toContain('fs/delete_path');
    expect(result.metadata!.outcome).toBe('needs-disambiguation');
    const proof = proofOf(result);
    expect(proof.candidates.map(c => [c.toolId, c.source])).toEqual([
      ['fs/read_file', 'vector'],
      ['fs/delete_path', 'overload'],
    ]);
    expect(proof.decision).toBe('needs-llm-verifier');
  });

  it('runs the best candidate once the verifier approves it, never the overload', async () => {
    const { runtime, ran } = fsRuntime({ llmClient: approve });
    await runtime.dispatch('read the config file', { path: 'config.yaml' });
    expect(ran).toEqual(['fs/read_file']);
  });

  it('chooses the overload matching the arguments when it is the best-ranked candidate', async () => {
    const embedder = new ScriptedEmbedder({ 'delete the build folder': axis(0) });
    const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder);
    const ran: string[] = [];
    const fs = new ToolClass('fs');
    runtime.registerClass(fs);
    const sel = runtime.selectorTable.register(toward(0, 0.97, 1), 'fs.delete_path');
    runtime.addOverload(fs, sel, createSignature([param('path', 0, SCType.string(), true)]), localIMP('fs', 'delete_path', ran));
    runtime.addOverload(
      fs,
      sel,
      createSignature([param('path', 0, SCType.string(), true), param('recursive', 1, SCType.boolean(), true)]),
      localIMP('fs', 'delete_path_recursive', ran),
    );

    const result = await runtime.dispatch('delete the build folder', { path: 'build', recursive: true });

    expect(ran).toEqual(['fs/delete_path_recursive']);
    expect(proofOf(result).candidates[0]).toMatchObject({ toolId: 'fs/delete_path_recursive', source: 'overload', tier: 'exact' });
  });

  it('applies strict-mode verification to an overload candidate', async () => {
    const embedder = new ScriptedEmbedder({ 'remove the folder': axis(0) });
    const microCheck = vi.fn(async () => false);
    const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder, { strict: true, llmClient: { microCheck } });
    const ran: string[] = [];
    const fs = new ToolClass('fs');
    runtime.registerClass(fs);
    const sel = runtime.selectorTable.register(toward(0, 0.9, 1), 'fs.delete_path');
    runtime.addOverload(fs, sel, createSignature([param('path', 0, SCType.string(), true)]), localIMP('fs', 'delete_path', ran));
    runtime.addOverload(
      fs,
      sel,
      createSignature([param('path', 0, SCType.string(), true), param('recursive', 1, SCType.boolean(), true)]),
      localIMP('fs', 'delete_path_recursive', ran),
    );

    const result = await runtime.dispatch('remove the folder', { path: 'build' });

    expect(ran).toEqual([]);
    expect(proofOf(result).steps.some(s => s.stage === 'verification')).toBe(true);
    expect(proofOf(result).decision).toBe('verification-failed');
  });
});

// ---------------------------------------------------------------------------
// SC-INF-04 — exact pins bypassed via negation, interning + cache, semantic map
// ---------------------------------------------------------------------------

describe('SC-INF-04: an exact pin fires only on its exact phrase', () => {
  function bankContext(embedder: Embedder, pins: IntentPinRegistry) {
    const index = new MemoryVectorIndex();
    const table = new SelectorTable(index, embedder);
    const context = new DispatchContext(table, new ResolutionCache(), index, embedder, undefined, pins);
    const ran: string[] = [];
    const bank = new ToolClass('bank');
    bank.addMethod(table.register(axis(0), 'bank.transfer_funds'), localIMP('bank', 'transfer_funds', ran));
    bank.addMethod(table.register(axis(1), 'bank.check_balance'), localIMP('bank', 'check_balance', ran));
    context.registerClass(bank);
    return { context, ran };
  }

  function transferPin(): IntentPinRegistry {
    const pins = new IntentPinRegistry();
    pins.pin({ canonical: 'bank.transfer_funds', policy: 'exact', aliases: ['transfer funds'] });
    return pins;
  }

  it('fires on its pinned phrase', async () => {
    const { context, ran } = bankContext(new ScriptedEmbedder({}), transferPin());
    const result = await toolkit_dispatch(context, 'transfer funds', {});
    expect(ran).toEqual(['bank/transfer_funds']);
    expect(proofOf(result).decision).toBe('pin-exact');
  });

  it('does not fire on a negated alias', async () => {
    const { context, ran } = bankContext(new ScriptedEmbedder({}), transferPin());
    await toolkit_dispatch(context, 'do not transfer funds', {});
    expect(ran).not.toContain('bank/transfer_funds');
  });

  it('does not fire for a different intent that interned onto the alias and hit its cache entry', async () => {
    const embedder = new ScriptedEmbedder({
      'transfer funds': axis(3),
      'wire everything to mallory': axis(3),
    });
    const { context, ran } = bankContext(embedder, transferPin());

    await toolkit_dispatch(context, 'transfer funds', {});
    expect(ran).toEqual(['bank/transfer_funds']);

    await toolkit_dispatch(context, 'wire everything to mallory', {});
    expect(ran).toEqual(['bank/transfer_funds']);
  });

  it('does not fire through a semantic-map boost for a merely similar intent', async () => {
    const embedder = new ScriptedEmbedder({
      'move money to savings': axis(4),
      'move money to my brother': toward(4, 0.95, 5),
    });
    const { context, ran } = bankContext(embedder, transferPin());

    await context.reinforceRefinement('move money to savings', 'bank.transfer_funds');
    const result = await toolkit_dispatch(context, 'move money to my brother', {});

    expect(ran).not.toContain('bank/transfer_funds');
    expect(proofOf(result).candidates).toContainEqual(expect.objectContaining({ toolId: 'bank/transfer_funds', excluded: 'pin-exact-required' }));
  });

  it("measures an 'elevated' pin against the intent's own embedding, not an interned neighbour's", async () => {
    // The intent embeds at 0.96 from the pinned tool, which is enough to
    // intern it onto the tool's own selector (>= 0.95) — whose vector then
    // scores 1.0. The pin requires 0.98 of the intent itself.
    const embedder = new ScriptedEmbedder({ 'move the money over': toward(0, 0.96, 6) });
    const pins = new IntentPinRegistry();
    pins.pin({ canonical: 'bank.transfer_funds', policy: 'elevated', threshold: 0.98 });
    const { context, ran } = bankContext(embedder, pins);

    await toolkit_dispatch(context, 'move the money over', {});

    expect(ran).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-11 — arguments were never validated against the input schema
// ---------------------------------------------------------------------------

const purgeManifest: ProviderManifest = {
  id: 'db',
  name: 'Database',
  transportType: 'local',
  tools: [
    {
      name: 'purge_logs',
      description: 'Delete log rows older than a number of days',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1 },
          table: { type: 'string', enum: ['logs', 'events'] },
        },
        required: ['days', 'table'],
        additionalProperties: false,
      } as never,
      annotations: { destructiveHint: true },
      providerId: 'db',
      transportType: 'local',
    },
  ],
};

describe('SC-INF-11: arguments are validated against the tool input schema', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    unregisterLocalHandler('purge_logs');
  });

  async function purgeArtifact(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'sc2-validate-'));
    tmpDirs.push(dir);
    const path = join(dir, 'tools.toolkit.json');
    const embedder = new HashEmbedder(64);
    const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile([purgeManifest]);
    await writeArtifact(path, buildArtifact(result, [purgeManifest], embedder.fingerprint));
    return path;
  }

  it('rejects wrong types, out-of-enum values, extra keys and null/undefined required values (compiler IMP)', async () => {
    const result = await new ToolCompiler(new HashEmbedder(64), new MemoryVectorIndex()).compile([purgeManifest]);
    const imp = [...result.dispatchTables.get('db')!.values()][0];

    expect(imp.constraints.validate({ days: '-1; DROP', table: 'users', extra: 1 }).valid).toBe(false);
    expect(imp.constraints.validate({ days: null, table: undefined }).valid).toBe(false);
    expect(imp.constraints.validate({ days: 7, table: 'logs' }).valid).toBe(true);
  });

  it('rejects invalid arguments on a runtime loaded from an artifact', async () => {
    const { runtime } = await loadRuntime(await purgeArtifact());
    const imp = runtime.context.getClasses()[0].dispatchTable.get('db.purge_logs')!;

    expect(imp.constraints.validate({ days: '-1; DROP', table: 'users', extra: 1 }).valid).toBe(false);
    expect((await imp.schemaLoader()).inputSchema).toEqual(purgeManifest.tools[0].inputSchema);
  });

  it('never executes a call with invalid arguments, and says precisely why', async () => {
    const calls: unknown[] = [];
    registerLocalHandler('purge_logs', async (args) => {
      calls.push(args);
      return { content: 'purged' };
    });
    const { runtime } = await loadRuntime(await purgeArtifact());

    const bad = await runtime.dispatchById('db/purge_logs', { days: '-1; DROP', table: 'users', extra: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.metadata!.outcome).toBe('invalid-arguments');
    expect((bad.content as { errors: string[] }).errors).toEqual([
      '/extra: unknown argument "extra": the tool\'s inputSchema does not allow it',
      '/days: argument "days" must be integer, got string "-1; DROP"',
      '/table: argument "table" must be one of "logs", "events", got "users"',
    ]);
    expect(proofOf(bad).ran).toBeNull();
    expect(calls).toEqual([]);

    const good = await runtime.dispatchById('db/purge_logs', { days: 30, table: 'logs' });
    expect(good.isError).toBeFalsy();
    expect(calls).toEqual([{ days: 30, table: 'logs' }]);
  });

  it('coerces scalar types only when configured to', async () => {
    const calls: unknown[] = [];
    registerLocalHandler('purge_logs', async (args) => {
      calls.push(args);
      return { content: 'purged' };
    });
    const path = await purgeArtifact();

    const strict = (await loadRuntime(path)).runtime;
    expect((await strict.dispatchById('db/purge_logs', { days: '30', table: 'logs' })).isError).toBe(true);

    const lenient = (await loadRuntime(path, { runtimeOptions: { argumentCoercion: 'primitives' } })).runtime;
    expect((await lenient.dispatchById('db/purge_logs', { days: '30', table: 'logs' })).isError).toBeFalsy();
    expect(calls).toEqual([{ days: 30, table: 'logs' }]);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-15 — alternates accepted without the LLM check the best one failed
// ---------------------------------------------------------------------------

describe('SC-INF-15: alternates get the same verification as the best candidate', () => {
  it('does not run a LOW alternate after the LLM rejected the best candidate', async () => {
    const microCheck = vi.fn(async () => false);
    const { runtime, ran } = scriptedRuntime(
      { 'clean up old slack messages': axis(0) },
      'slack',
      [
        { name: 'archive_messages', vector: toward(0, 0.8, 1), description: 'Archive a conversation thread' },
        { name: 'purge_messages', vector: toward(0, 0.61, 2), description: 'Permanently purge old slack messages' },
      ],
      { llmClient: { microCheck } },
    );

    const result = await runtime.dispatch('clean up old slack messages', {});

    expect(ran).toEqual([]);
    expect(microCheck.mock.calls.map(c => (c as unknown as [{ toolName: string }])[0].toolName)).toEqual(['archive_messages', 'purge_messages']);
    expect(result.metadata!.outcome).toBe('needs-disambiguation');
    expect(proofOf(result).decision).toBe('verification-failed');
  });
});

// ---------------------------------------------------------------------------
// SC-INF-16 — the proof names the tool that ran, and can be replayed
// ---------------------------------------------------------------------------

describe('SC-INF-16: the proof names the tool that ran', () => {
  it('does not report a vector-search winner while a cached tool runs', async () => {
    const embedder = new ScriptedEmbedder({ 'search the docs': axis(0) });
    const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder);
    const ran: string[] = [];

    const legacy = new ToolClass('legacy');
    legacy.addMethod(runtime.selectorTable.register(toward(0, 0.882, 1), 'legacy.legacy_search'), localIMP('legacy', 'legacy_search', ran));
    runtime.registerClass(legacy);
    await runtime.dispatch('search the docs', {});

    const v2 = new ToolClass('v2');
    v2.addMethod(runtime.selectorTable.register(toward(0, 0.932, 2), 'v2.search_v2'), localIMP('v2', 'search_v2', ran));
    runtime.registerClass(v2);
    const result = await runtime.dispatch('search the docs', { query: 'install' });

    const proof = proofOf(result);
    expect(proof.ran).toBe(ran[ran.length - 1]);
    expect(proof.chosen).toBe(proof.ran);
    expect(proof.candidates[0].toolId).toBe(proof.ran);

    // Without arguments the cache answers — and the proof says so.
    const cached = await runtime.dispatch('search the docs', {});
    expect(proofOf(cached).decision).toBe('cache');
    expect(proofOf(cached).ran).toBe(ran[ran.length - 1]);
  });

  it('records the decision inputs, binds the call by digest, and never records raw arguments', async () => {
    const { runtime } = scriptedRuntime({ 'search the docs': axis(0) }, 'docs', [{ name: 'search', vector: toward(0, 0.97, 1) }], { artifactHash: 'a'.repeat(64) });
    const args = { query: 'secret-token-123' };

    const result = await runtime.dispatch('search the docs', args);
    const proof = proofOf(result);

    expect(proof).toMatchObject({
      outcome: 'resolved',
      decision: 'ranked',
      chosen: 'docs/search',
      ran: 'docs/search',
      callDigest: callDigest('docs/search', args),
      artifactHash: 'a'.repeat(64),
      thresholds: { exact: 0.95, high: 0.85, medium: 0.75, low: 0.6 },
      guards: { requireLLMForSubHighDispatch: true, strict: false, llmVerifier: false },
    });
    expect(result.metadata!.callDigest).toBe(proof.callDigest);
    expect(JSON.stringify(proof)).not.toContain('secret-token-123');
    expect(proof.proofDigest).toBe(computeProofDigest(proof));
  });

  it('gives the same decision the same proofDigest across runtimes, whatever the timings', async () => {
    const run = async () => {
      const { runtime } = scriptedRuntime({ 'search the docs': axis(0) }, 'docs', [
        { name: 'search', vector: toward(0, 0.97, 1) },
        { name: 'browse', vector: toward(0, 0.9, 2) },
      ]);
      return proofOf(await runtime.dispatch('search the docs', { query: 'x' }));
    };
    const [a, b] = [await run(), await run()];
    expect(a.proofDigest).toBe(b.proofDigest);
    expect(a.candidates.map(c => c.toolId)).toEqual(['docs/search', 'docs/browse']);
  });

  it('records the embedder fingerprint', async () => {
    const embedder = new HashEmbedder(64);
    const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder);
    const resolution = await runtime.resolve('anything at all');
    expect(resolution.proof.embedder).toEqual(embedder.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-14 — exact-name dispatch path; resolve is pure
// ---------------------------------------------------------------------------

describe('SC-INF-14: tools are executable by exact id, and resolve never executes', () => {
  it('runtime.dispatchById runs exactly the named tool without embedding', async () => {
    const { runtime, embedder, ran } = scriptedRuntime({}, 'github', [{ name: 'get_issue', vector: axis(0) }]);

    const result = await runtime.dispatchById('github/get_issue', {});

    expect(ran).toEqual(['github/get_issue']);
    expect(embedder.calls).toEqual([]);
    expect(proofOf(result)).toMatchObject({ intent: null, decision: 'exact-id', ran: 'github/get_issue' });
  });

  it('refuses an unknown id without running anything', async () => {
    const { runtime, ran } = scriptedRuntime({}, 'github', [{ name: 'get_issue', vector: axis(0) }]);
    const result = await runtime.dispatchById('github/get_issues', {});
    expect(result.isError).toBe(true);
    expect(proofOf(result).decision).toBe('unknown-tool');
    expect(ran).toEqual([]);
  });

  it('resolve() proposes a tool and changes nothing: no execution, interning or caching', async () => {
    const { runtime, ran } = scriptedRuntime({ 'look up issue 7': axis(0) }, 'github', [{ name: 'get_issue', vector: toward(0, 0.97, 1) }]);
    const selectorsBefore = runtime.selectorTable.size;

    const resolution = await runtime.resolve('look up issue 7');

    expect(resolution).toMatchObject({ outcome: 'resolved', chosen: 'github/get_issue', tier: 'exact' });
    expect(ran).toEqual([]);
    expect(runtime.selectorTable.size).toBe(selectorsBefore);
    expect(runtime.cache.size).toBe(0);

    // The host then runs the proposal by id, linking the two proofs.
    const result = await runtime.dispatchById(resolution.chosen!, { number: 7 }, { resolutionDigest: resolution.proof.proofDigest });
    expect(ran).toEqual(['github/get_issue']);
    expect(proofOf(result).resolutionDigest).toBe(resolution.proof.proofDigest);
  });

  it('MCP tools/call executes the listed tool by name, and never guesses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc2-mcp-'));
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
    const embedder = new HashEmbedder(64);
    const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
    const path = join(dir, 'tools.toolkit.json');
    await writeArtifact(path, buildArtifact(result, manifests, embedder.fingerprint));

    const calls: unknown[] = [];
    registerLocalHandler('get_issue', async (args) => {
      calls.push(args);
      return { content: { title: 'Bug' } };
    });
    const server = new MCPServer({ port: 0, host: '127.0.0.1', sourcePath: path, dbPath: ':memory:' });
    const call = async (name: string, args: Record<string, unknown>) => {
      const port = ((server as unknown as { server: { address(): { port: number } } }).server.address()).port;
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return await res.json() as { result?: { isError: boolean; content: Array<{ text: string }> }; error?: { code: number; message: string } };
    };
    try {
      await server.start();

      const ok = await call('get_issue', { number: 7 });
      expect(ok.result?.isError).toBe(false);
      expect(calls).toEqual([{ number: 7 }]);

      // By canonical id, too.
      expect((await call('github/get_issue', { number: 8 })).result?.isError).toBe(false);
      expect(calls).toEqual([{ number: 7 }, { number: 8 }]);

      // A name that is not listed must never execute some other tool.
      const miss = await call('get issue', { number: 9 });
      expect(miss.error?.code).toBe(-32602);

      // A listed name two providers share is ambiguous, not guessed.
      const ambiguous = await call('search_code', { query: 'x' });
      expect(ambiguous.error?.code).toBe(-32602);
      expect(ambiguous.error?.message).toContain('github/search_code, gitlab/search_code');

      // Invalid arguments are reported to the model; the tool does not run.
      const invalid = await call('get_issue', { number: 'seven' });
      expect(invalid.result?.isError).toBe(true);
      expect(invalid.result?.content[0].text).toContain('argument \\"number\\" must be integer');
      expect(calls).toHaveLength(2);
    } finally {
      unregisterLocalHandler('get_issue');
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Annotation-driven policy (destructiveHint), on every path
// ---------------------------------------------------------------------------

describe('Destructive tools run only by exact id, pinned phrase or EXACT similarity', () => {
  const destructive: ToolAnnotations = { destructiveHint: true };

  it('refuses a HIGH-tier destructive match even with LLM approval, and runs it by id', async () => {
    const { runtime, ran } = scriptedRuntime(
      { 'clear the logs': axis(0) },
      'db',
      [{ name: 'purge_logs', vector: toward(0, 0.9, 1), annotations: destructive }],
      { llmClient: approve },
    );

    const result = await runtime.dispatch('clear the logs', {});
    expect(ran).toEqual([]);
    expect(proofOf(result).decision).toBe('destructive-needs-exact');
    expect(result.refinement?.options[0].toolId).toBe('db/purge_logs');

    await runtime.dispatchById('db/purge_logs', {});
    expect(ran).toEqual(['db/purge_logs']);
  });

  it('runs a destructive tool at EXACT similarity, and never caches it', async () => {
    const { runtime, ran } = scriptedRuntime(
      { 'purge the logs': axis(0) },
      'db',
      [{ name: 'purge_logs', vector: toward(0, 0.97, 1), annotations: destructive }],
    );
    await runtime.dispatch('purge the logs', {});
    expect(ran).toEqual(['db/purge_logs']);
    expect(runtime.cache.size).toBe(0);
  });

  it('does not let a learned preference authorize a destructive tool', async () => {
    const { runtime, ran } = scriptedRuntime(
      { 'tidy up': axis(3) },
      'db',
      [{ name: 'purge_logs', vector: axis(0), annotations: destructive }],
    );
    await runtime.reinforceRefinement('tidy up', 'db.purge_logs');

    const result = await runtime.dispatch('tidy up', {});

    expect(ran).toEqual([]);
    expect(result.metadata!.outcome).not.toBe('resolved');
  });

  it('treats readOnlyHint:false without destructiveHint as destructive (the MCP default)', async () => {
    const { runtime, ran } = scriptedRuntime(
      { 'clear the logs': axis(0) },
      'db',
      [{ name: 'purge_logs', vector: toward(0, 0.9, 1), annotations: { readOnlyHint: false } }],
    );
    await runtime.dispatch('clear the logs', {});
    expect(ran).toEqual([]);
  });

  it('carries annotations from the MCP tool definition through the artifact into the runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc2-annotations-'));
    try {
      const path = join(dir, 'tools.toolkit.json');
      const embedder = new HashEmbedder(64);
      const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile([purgeManifest]);
      expect(result.dispatchTables.get('db')!.get('db.purge_logs')!.annotations).toEqual({ destructiveHint: true });
      await writeArtifact(path, buildArtifact(result, [purgeManifest], embedder.fingerprint));
      const { runtime } = await loadRuntime(path);
      expect(runtime.getTool('db/purge_logs')!.imp.annotations).toEqual({ destructiveHint: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SC-INF-24 — guardrails configurable, and their types exported
// ---------------------------------------------------------------------------

describe('SC-INF-24: guardrails are configurable and their types exported', () => {
  it('exports IntentPinRegistry, SignatureValidationError, SemanticMap and the policy types from /inference', async () => {
    const inference = await import('../inference.js') as Record<string, unknown>;
    for (const name of [
      'IntentPinRegistry',
      'SignatureValidationError',
      'SemanticMap',
      'evaluateDispatchPolicy',
      'isDestructive',
      'callDigest',
      'compileArgumentValidator',
      'computeProofDigest',
      'dispatchById',
      'resolveIntent',
    ]) {
      expect(inference[name], name).toBeDefined();
    }
  });

  it('honours intent pins passed through RuntimeOptions', async () => {
    const pins = new IntentPinRegistry();
    pins.pin({ canonical: 'bank.transfer_funds', policy: 'exact' });
    const runtime = new ToolRuntime(new MemoryVectorIndex(), new ScriptedEmbedder({}), { intentPins: pins });
    expect(runtime.context.intentPins).toBe(pins);

    const fromList = new ToolRuntime(new MemoryVectorIndex(), new ScriptedEmbedder({}), {
      intentPins: [{ canonical: 'bank.transfer_funds', policy: 'exact', aliases: ['send money'] }],
    });
    expect(fromList.intentPins.checkExact('send money')?.canonical).toBe('bank.transfer_funds');
  });

  it('builds runtime options from a smallchat.json policy block (as serve does)', async () => {
    const options = runtimeOptionsFromPolicy({
      requireLLMForSubHighDispatch: false,
      strict: true,
      treatUnannotatedAsDestructive: true,
      thresholds: { high: 0.9 },
      pins: [{ canonical: 'bank.transfer_funds', policy: 'exact', aliases: ['transfer funds'] }],
      argumentCoercion: 'primitives',
    });
    const runtime = new ToolRuntime(new MemoryVectorIndex(), new ScriptedEmbedder({}), options);

    expect(runtime.context.policyOptions).toEqual({
      thresholds: { exact: 0.95, high: 0.9, medium: 0.75, low: 0.6 },
      requireLLMForSubHighDispatch: false,
      treatUnannotatedAsDestructive: true,
    });
    expect(runtime.strict).toBe(true);
    expect(runtime.context.argumentCoercion).toBe('primitives');
    expect(runtime.intentPins.checkExact('transfer funds')?.canonical).toBe('bank.transfer_funds');
    expect(runtimeOptionsFromPolicy({})).toEqual({});
  });
});
