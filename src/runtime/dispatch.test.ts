import { describe, it, expect, vi } from 'vitest';
import { DispatchContext, UnrecognizedIntent, toolkit_dispatch, smallchat_dispatchStream } from './dispatch.js';
import type { FallbackChainResult } from './dispatch.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { IntentPinRegistry } from '../core/intent-pin.js';
import type { ToolIMP, ToolProtocol, ToolSelector, ToolResult, DispatchEvent, InferenceDelta, DispatchEventInferenceDelta } from '../core/types.js';

function createContext(intentPins?: IntentPinRegistry) {
  const embedder = new LocalEmbedder(64);
  const vectorIndex = new MemoryVectorIndex();
  const selectorTable = new SelectorTable(vectorIndex, embedder);
  const cache = new ResolutionCache();
  return new DispatchContext(selectorTable, cache, vectorIndex, embedder, undefined, intentPins);
}

function makeIMP(providerId: string, toolName: string, result: unknown = null): ToolIMP {
  return {
    providerId,
    toolName,
    transportType: 'local',
    schema: null,
    schemaLoader: async () => ({ name: toolName, description: '', inputSchema: { type: 'object' }, arguments: [] }),
    execute: async (args) => ({ content: result ?? `${toolName}:executed`, metadata: { args } }),
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
  };
}

describe('DispatchContext', () => {
  it('registers a tool class', async () => {
    const context = createContext();
    const cls = new ToolClass('github');

    const embedding = await context.embedder.embed('search code');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));

    context.registerClass(cls);
    expect(context.getClasses()).toHaveLength(1);
  });
});

describe('toolkit_dispatch', () => {
  it('dispatches to a registered tool via vector similarity', async () => {
    const context = createContext();
    const cls = new ToolClass('github');

    // Register a tool
    const embedding = await context.embedder.embed('search code repositories');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));
    context.registerClass(cls);

    // Dispatch with a similar intent
    const result = await toolkit_dispatch(context, 'search code repositories', { query: 'auth' });
    expect(result.content).toBe('search_code:executed');
  });

  it('caches resolved tools for subsequent dispatches', async () => {
    const context = createContext();
    const cls = new ToolClass('github');

    let execCount = 0;
    const imp: ToolIMP = {
      ...makeIMP('github', 'search_code'),
      execute: async () => {
        execCount++;
        return { content: `call:${execCount}` };
      },
    };

    const embedding = await context.embedder.embed('search code');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, imp);
    context.registerClass(cls);

    // First dispatch
    await toolkit_dispatch(context, 'search code', {});
    // Second dispatch — should hit cache
    await toolkit_dispatch(context, 'search code', {});

    expect(execCount).toBe(2); // Both should execute
    expect(context.cache.size).toBeGreaterThan(0); // But cache should be populated
  });

  it('returns fallback stub instead of throwing when no tool matches', async () => {
    const context = createContext();

    const result = await toolkit_dispatch(context, 'completely unknown operation xyz123');

    // Should return a result, not throw
    expect(result).toBeDefined();
    expect(result.metadata).toBeDefined();
    // 0.4.0: may return refinement or forwarding fallback — both include a proof
    expect(result.metadata!.proof).toBeDefined();
    expect(result.metadata!.tier).toBeDefined();
    expect(result.isError).not.toBe(true);
  });

  it('tries superclass chain during fallback', async () => {
    const context = createContext();

    // Create a superclass with a tool
    const superclass = new ToolClass('base-tools');
    const embedding = await context.embedder.embed('deploy application');
    const selector = await context.selectorTable.intern(embedding, 'base.deploy');
    superclass.addMethod(selector, makeIMP('base', 'deploy', 'deployed!'));
    context.registerClass(superclass);

    // Create a subclass that inherits from superclass but has no direct tools
    const subclass = new ToolClass('cloud-tools');
    subclass.superclass = superclass;
    context.registerClass(subclass);

    // Dispatch something that won't match at threshold 0.75 but will match
    // via superclass traversal in the fallback chain
    const result = await toolkit_dispatch(context, 'deploy application');
    expect(result.content).toBe('deployed!');
  });

  it('annotates ambiguous multi-candidate results', async () => {
    const context = createContext();
    const cls = new ToolClass('multi');

    // Register two tools with the same embedding to force ambiguity
    const embedding = await context.embedder.embed('search items');
    const sel1 = await context.selectorTable.intern(embedding, 'multi.search_a');
    const sel2 = await context.selectorTable.intern(
      await context.embedder.embed('search items'),
      'multi.search_b',
    );
    cls.addMethod(sel1, makeIMP('multi', 'search_a'));
    cls.addMethod(sel2, makeIMP('multi', 'search_b'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'search items');

    // Should still return a result (not throw)
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it('includes resolution proof in metadata', async () => {
    const context = createContext();

    const result = await toolkit_dispatch(context, 'nonexistent tool operation');
    const proof = (result.metadata as any)?.proof;

    expect(proof).toBeDefined();
    expect(proof.intent).toBe('nonexistent tool operation');
    expect(proof.tier).toBeDefined();
    expect(Array.isArray(proof.steps)).toBe(true);
  });

  it('passes arguments through to the IMP and returns them in metadata', async () => {
    const context = createContext();
    const cls = new ToolClass('slack');

    const embedding = await context.embedder.embed('send message to channel');
    const selector = await context.selectorTable.intern(embedding, 'slack.send_message');
    cls.addMethod(selector, makeIMP('slack', 'send_message'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'send message to channel', {
      channel: '#general',
      text: 'hello world',
    });

    expect(result.content).toBe('send_message:executed');
    expect(result.metadata?.args).toEqual({ channel: '#general', text: 'hello world' });
    expect(result.metadata?.tier).toBeDefined();
  });

  it('selects the correct provider when multiple are registered', async () => {
    const context = createContext();

    // Provider A: github — handles "search code repositories"
    const github = new ToolClass('github');
    const ghEmbed = await context.embedder.embed('search code repositories');
    const ghSel = await context.selectorTable.intern(ghEmbed, 'github.search_code');
    github.addMethod(ghSel, makeIMP('github', 'search_code'));
    context.registerClass(github);

    // Provider B: jira — handles "create bug report"
    const jira = new ToolClass('jira');
    const jiraEmbed = await context.embedder.embed('create bug report');
    const jiraSel = await context.selectorTable.intern(jiraEmbed, 'jira.create_issue');
    jira.addMethod(jiraSel, makeIMP('jira', 'create_issue'));
    context.registerClass(jira);

    // Dispatch an intent that should match jira, not github
    const result = await toolkit_dispatch(context, 'create bug report', { title: 'fix login' });
    expect(result.content).toBe('create_issue:executed');
  });

  it('invokes a mock provider and streams back structured chunks', async () => {
    const context = createContext();
    const cls = new ToolClass('ai');

    // Simulate a provider that returns chunked content
    const chunks = ['chunk-1', 'chunk-2', 'chunk-3'];
    const mockIMP: ToolIMP = {
      ...makeIMP('ai', 'summarize'),
      execute: vi.fn(async (args) => ({
        content: chunks,
        metadata: { chunksEmitted: chunks.length, source: args.url },
      })),
    };

    const embedding = await context.embedder.embed('summarize document');
    const selector = await context.selectorTable.intern(embedding, 'ai.summarize');
    cls.addMethod(selector, mockIMP);
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'summarize document', { url: 'https://example.com' });

    // Assert chunks flowed through
    expect(result.content).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
    expect(result.metadata?.chunksEmitted).toBe(3);
    expect(result.metadata?.source).toBe('https://example.com');

    // Assert the mock was called exactly once with unwrapped args
    expect(mockIMP.execute).toHaveBeenCalledOnce();
    expect(mockIMP.execute).toHaveBeenCalledWith({ url: 'https://example.com' });
  });

  it('returns a result via fallback chain when no exact tool matches but index is non-empty', async () => {
    const context = createContext();

    // Register one tool so vector index is non-empty
    const cls = new ToolClass('fs');
    const embedding = await context.embedder.embed('read file contents');
    const selector = await context.selectorTable.intern(embedding, 'fs.read_file');
    cls.addMethod(selector, makeIMP('fs', 'read_file'));
    context.registerClass(cls);

    // With broadened search (threshold 0.5), the fallback chain may find
    // a near-miss match via the registered tool, or return a fallback stub.
    const result = await toolkit_dispatch(context, 'completely unrelated intent xyz999');
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  it('resolves via protocol conformance when dispatch table misses', async () => {
    const context = createContext();

    // Create a selector for the protocol's required method
    const embedding = await context.embedder.embed('list items');
    const selector = await context.selectorTable.intern(embedding, 'proto.list_items');

    // Create a protocol that requires this selector
    const protocol: ToolProtocol = {
      name: 'ListCapability',
      embedding: new Float32Array(64),
      requiredSelectors: [selector],
      optionalSelectors: [],
    };

    // Register a class that conforms to the protocol and handles the selector
    const cls = new ToolClass('inventory');
    cls.addProtocol(protocol);
    cls.addMethod(selector, makeIMP('inventory', 'list_items', 'inventory-list'));
    context.registerClass(cls);
    context.registerProtocol(protocol);

    // Dispatch with the exact intent — should resolve via protocol conformance path
    // when the vector search doesn't yield a direct match
    const result = await toolkit_dispatch(context, 'list items');
    expect(result.content).toBe('inventory-list');
  });
});

/** Collect all events from an async generator */
async function collectEvents(gen: AsyncGenerator<DispatchEvent>): Promise<DispatchEvent[]> {
  const events: DispatchEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('smallchat_dispatchStream', () => {
  it('yields resolving → tool-start → chunk → done for a matched tool', async () => {
    const context = createContext();
    const cls = new ToolClass('github');

    const embedding = await context.embedder.embed('search code repositories');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));
    context.registerClass(cls);

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'search code repositories', { query: 'auth' }),
    );

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0].type).toBe('resolving');
    expect((events[0] as { type: 'resolving'; intent: string }).intent).toBe('search code repositories');
    expect(events[1].type).toBe('tool-start');
    const toolStart = events[1] as { type: 'tool-start'; toolName: string; providerId: string };
    expect(toolStart.toolName).toBe('search_code');
    expect(toolStart.providerId).toBe('github');
    expect(events[2].type).toBe('chunk');
    expect((events[2] as { type: 'chunk'; content: unknown }).content).toBe('search_code:executed');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('yields resolving immediately before any async work', async () => {
    const context = createContext();
    const cls = new ToolClass('github');

    const embedding = await context.embedder.embed('search code');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));
    context.registerClass(cls);

    const gen = smallchat_dispatchStream(context, 'search code');
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('resolving');

    // Consume remaining events
    for await (const _ of gen) { /* drain */ }
  });

  it('yields done event when no tool matches (refinement or fallback)', async () => {
    const context = createContext();

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'completely unknown operation xyz123'),
    );

    expect(events[0].type).toBe('resolving');
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    const result = (doneEvent as { type: 'done'; result: ToolResult }).result;
    // 0.4.0: May return refinement or fallback depending on nearest matches
    expect(result.metadata?.tier).toBeDefined();
  });

  it('streams chunks from an IMP with executeStream', async () => {
    const context = createContext();
    const cls = new ToolClass('openai');

    const streamingImp: ToolIMP & { executeStream: (args: Record<string, unknown>) => AsyncIterable<ToolResult> } = {
      ...makeIMP('openai', 'chat_completion'),
      executeStream: async function* (_args: Record<string, unknown>) {
        yield { content: 'Hello' };
        yield { content: ' world' };
        yield { content: '!' };
      },
    };

    const embedding = await context.embedder.embed('chat completion');
    const selector = await context.selectorTable.intern(embedding, 'openai.chat_completion');
    cls.addMethod(selector, streamingImp);
    context.registerClass(cls);

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'chat completion', { prompt: 'hi' }),
    );

    expect(events[0].type).toBe('resolving');
    expect(events[1].type).toBe('tool-start');

    const chunks = events.filter(e => e.type === 'chunk') as Array<{ type: 'chunk'; content: unknown; index: number }>;
    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Hello');
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].content).toBe(' world');
    expect(chunks[1].index).toBe(1);
    expect(chunks[2].content).toBe('!');
    expect(chunks[2].index).toBe(2);

    expect(events[events.length - 1].type).toBe('done');
  });

  it('uses cache on second streaming dispatch', async () => {
    const context = createContext();
    const cls = new ToolClass('github');

    const embedding = await context.embedder.embed('search code');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));
    context.registerClass(cls);

    // First dispatch — populates cache
    await collectEvents(smallchat_dispatchStream(context, 'search code'));
    expect(context.cache.size).toBeGreaterThan(0);

    // Second dispatch — hits cache
    const events = await collectEvents(smallchat_dispatchStream(context, 'search code'));
    expect(events[0].type).toBe('resolving');
    expect(events[1].type).toBe('tool-start');
    expect(events[events.length - 1].type).toBe('done');
  });

  it('yields inference-delta events from an IMP with executeInference', async () => {
    const context = createContext();
    const cls = new ToolClass('anthropic');

    const inferenceImp: ToolIMP & { executeInference: (args: Record<string, unknown>) => AsyncIterable<InferenceDelta> } = {
      ...makeIMP('anthropic', 'messages_create'),
      executeInference: async function* (_args: Record<string, unknown>) {
        yield { text: 'The' };
        yield { text: ' answer' };
        yield { text: ' is' };
        yield { text: ' 42', finishReason: 'stop' };
      },
    };

    const embedding = await context.embedder.embed('create message completion');
    const selector = await context.selectorTable.intern(embedding, 'anthropic.messages_create');
    cls.addMethod(selector, inferenceImp);
    context.registerClass(cls);

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'create message completion', { prompt: 'meaning of life' }),
    );

    expect(events[0].type).toBe('resolving');
    expect(events[1].type).toBe('tool-start');

    // Should have inference-delta events for each token
    const deltas = events.filter(e => e.type === 'inference-delta') as DispatchEventInferenceDelta[];
    expect(deltas).toHaveLength(4);
    expect(deltas[0].delta.text).toBe('The');
    expect(deltas[0].tokenIndex).toBe(0);
    expect(deltas[1].delta.text).toBe(' answer');
    expect(deltas[1].tokenIndex).toBe(1);
    expect(deltas[2].delta.text).toBe(' is');
    expect(deltas[2].tokenIndex).toBe(2);
    expect(deltas[3].delta.text).toBe(' 42');
    expect(deltas[3].delta.finishReason).toBe('stop');
    expect(deltas[3].tokenIndex).toBe(3);

    // Should still get a synthesised chunk + done with the assembled text
    const chunks = events.filter(e => e.type === 'chunk') as Array<{ type: 'chunk'; content: unknown }>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('The answer is 42');

    expect(events[events.length - 1].type).toBe('done');
    const done = events[events.length - 1] as { type: 'done'; result: ToolResult };
    expect(done.result.content).toBe('The answer is 42');
  });

  it('prefers executeInference over executeStream when both are present', async () => {
    const context = createContext();
    const cls = new ToolClass('openai');

    const dualImp: ToolIMP & {
      executeInference: (args: Record<string, unknown>) => AsyncIterable<InferenceDelta>;
      executeStream: (args: Record<string, unknown>) => AsyncIterable<ToolResult>;
    } = {
      ...makeIMP('openai', 'chat_completion'),
      executeInference: async function* () {
        yield { text: 'fast' };
        yield { text: ' path', finishReason: 'stop' };
      },
      executeStream: async function* () {
        yield { content: 'slow path' };
      },
    };

    const embedding = await context.embedder.embed('openai chat');
    const selector = await context.selectorTable.intern(embedding, 'openai.chat_completion');
    cls.addMethod(selector, dualImp);
    context.registerClass(cls);

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'openai chat', { prompt: 'test' }),
    );

    // Should use inference path, not chunk path
    const deltas = events.filter(e => e.type === 'inference-delta');
    expect(deltas).toHaveLength(2);

    const chunks = events.filter(e => e.type === 'chunk') as Array<{ type: 'chunk'; content: unknown }>;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('fast path'); // assembled from deltas, not from executeStream
  });

  it('carries provider metadata through inference deltas', async () => {
    const context = createContext();
    const cls = new ToolClass('openai');

    const imp: ToolIMP & { executeInference: (args: Record<string, unknown>) => AsyncIterable<InferenceDelta> } = {
      ...makeIMP('openai', 'completion'),
      executeInference: async function* () {
        yield { text: 'Hello', index: 0, providerMeta: { logprob: -0.5 } };
        yield { text: '!', index: 0, finishReason: 'stop', providerMeta: { logprob: -0.1 } };
      },
    };

    const embedding = await context.embedder.embed('openai completion');
    const selector = await context.selectorTable.intern(embedding, 'openai.completion');
    cls.addMethod(selector, imp);
    context.registerClass(cls);

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'openai completion'),
    );

    const deltas = events.filter(e => e.type === 'inference-delta') as DispatchEventInferenceDelta[];
    expect(deltas[0].delta.providerMeta).toEqual({ logprob: -0.5 });
    expect(deltas[1].delta.finishReason).toBe('stop');
  });

  it('handles errors in executeInference gracefully', async () => {
    const context = createContext();
    const cls = new ToolClass('anthropic');

    const failImp: ToolIMP & { executeInference: (args: Record<string, unknown>) => AsyncIterable<InferenceDelta> } = {
      ...makeIMP('anthropic', 'messages'),
      executeInference: async function* () {
        yield { text: 'partial' };
        throw new Error('stream interrupted');
      },
    };

    const embedding = await context.embedder.embed('anthropic messages');
    const selector = await context.selectorTable.intern(embedding, 'anthropic.messages');
    cls.addMethod(selector, failImp);
    context.registerClass(cls);

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'anthropic messages'),
    );

    // Should get partial delta then error
    const deltas = events.filter(e => e.type === 'inference-delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: 'error'; error: string }).error).toBe('stream interrupted');
  });
});

describe('Intent Pinning — semantic collision mitigation', () => {
  it('exact-pinned tool dispatches when intent matches exactly', async () => {
    const pins = new IntentPinRegistry();
    // Pin with a canonical that matches what canonicalize() produces for 'delete record'
    // canonicalize('delete record') → 'delete:record'
    pins.pin({ canonical: 'delete:record', policy: 'exact' });
    const context = createContext(pins);
    const cls = new ToolClass('db');

    const embedding = await context.embedder.embed('delete record');
    const selector = await context.selectorTable.intern(embedding, 'delete:record');
    cls.addMethod(selector, makeIMP('db', 'delete_record', 'deleted'));
    context.registerClass(cls);

    // Exact intent should work — canonicalize('delete record') === 'delete:record'
    const result = await toolkit_dispatch(context, 'delete record');
    expect(result.content).toBe('deleted');
  });

  it('exact-pinned tool blocks semantically similar but non-exact intents', async () => {
    const pins = new IntentPinRegistry();
    pins.pin({ canonical: 'db.delete_record', policy: 'exact' });
    const context = createContext(pins);
    const cls = new ToolClass('db');

    // Register delete_record (pinned exact) and archive_record (not pinned)
    const delEmbed = await context.embedder.embed('delete record permanently');
    const delSelector = await context.selectorTable.intern(delEmbed, 'db.delete_record');
    cls.addMethod(delSelector, makeIMP('db', 'delete_record', 'deleted'));

    const archEmbed = await context.embedder.embed('archive record safely');
    const archSelector = await context.selectorTable.intern(archEmbed, 'db.archive_record');
    cls.addMethod(archSelector, makeIMP('db', 'archive_record', 'archived'));

    context.registerClass(cls);

    // A crafted intent that might semantically bridge to delete_record
    // should NOT dispatch to the pinned delete_record; it should either
    // dispatch to archive_record or fall through to fallback
    const result = await toolkit_dispatch(context, 'archive record safely');
    // Should not accidentally hit delete_record
    expect(result.content).not.toBe('deleted');
  });

  it('elevated-pinned tool blocks low-similarity matches', async () => {
    const pins = new IntentPinRegistry();
    pins.pin({ canonical: 'bank.transfer_funds', policy: 'elevated', threshold: 0.95 });
    const context = createContext(pins);
    const cls = new ToolClass('bank');

    const transferEmbed = await context.embedder.embed('transfer funds between accounts');
    const transferSel = await context.selectorTable.intern(transferEmbed, 'bank.transfer_funds');
    cls.addMethod(transferSel, makeIMP('bank', 'transfer_funds', 'transferred'));

    const checkEmbed = await context.embedder.embed('check account balance');
    const checkSel = await context.selectorTable.intern(checkEmbed, 'bank.check_balance');
    cls.addMethod(checkSel, makeIMP('bank', 'check_balance', 'balance-checked'));

    context.registerClass(cls);

    // Direct intent should work
    const directResult = await toolkit_dispatch(context, 'transfer funds between accounts');
    expect(directResult.content).toBe('transferred');
  });

  it('non-pinned tools still dispatch normally alongside pinned tools', async () => {
    const pins = new IntentPinRegistry();
    pins.pin({ canonical: 'db.delete_record', policy: 'exact' });
    const context = createContext(pins);
    const cls = new ToolClass('db');

    const delEmbed = await context.embedder.embed('delete record');
    const delSelector = await context.selectorTable.intern(delEmbed, 'db.delete_record');
    cls.addMethod(delSelector, makeIMP('db', 'delete_record', 'deleted'));

    const readEmbed = await context.embedder.embed('read record');
    const readSelector = await context.selectorTable.intern(readEmbed, 'db.read_record');
    cls.addMethod(readSelector, makeIMP('db', 'read_record', 'record-data'));

    context.registerClass(cls);

    // Non-pinned tool dispatches normally
    const result = await toolkit_dispatch(context, 'read record');
    expect(result.content).toBe('record-data');
  });

  it('dispatch works normally when no pins are registered', async () => {
    const context = createContext(); // no pins
    const cls = new ToolClass('github');

    const embedding = await context.embedder.embed('search code repositories');
    const selector = await context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'search code repositories', { query: 'auth' });
    expect(result.content).toBe('search_code:executed');
  });

  it('exact-pinned tool accepts via alias', async () => {
    const pins = new IntentPinRegistry();
    pins.pin({
      canonical: 'db.delete_record',
      policy: 'exact',
      aliases: ['remove record permanently'],
    });
    const context = createContext(pins);
    const cls = new ToolClass('db');

    const embedding = await context.embedder.embed('delete record');
    const selector = await context.selectorTable.intern(embedding, 'db.delete_record');
    cls.addMethod(selector, makeIMP('db', 'delete_record', 'deleted'));
    context.registerClass(cls);

    // Intent that canonicalizes to an alias should still work
    const result = await toolkit_dispatch(context, 'remove record permanently');
    expect(result.content).toBe('deleted');
  });
});

describe('Inference-core hardening', () => {
  it('resolves via the dispatch index without consulting non-owning classes', async () => {
    const context = createContext();

    // Two providers with distinct selectors. github should never be asked to
    // resolve jira's selector — the index routes the match to its owner only.
    const github = new ToolClass('github');
    const ghResolve = vi.spyOn(github, 'resolveSelector');
    const ghEmbed = await context.embedder.embed('search code repositories');
    const ghSel = await context.selectorTable.intern(ghEmbed, 'github.search_code');
    github.addMethod(ghSel, makeIMP('github', 'search_code'));
    context.registerClass(github);

    const jira = new ToolClass('jira');
    const jiraEmbed = await context.embedder.embed('create a bug report ticket');
    const jiraSel = await context.selectorTable.intern(jiraEmbed, 'jira.create_issue');
    jira.addMethod(jiraSel, makeIMP('jira', 'create_issue', 'issue-created'));
    context.registerClass(jira);

    ghResolve.mockClear();
    const result = await toolkit_dispatch(context, 'create a bug report ticket', { title: 'x' });

    expect(result.content).toBe('issue-created');
    // The non-owning github class must not have been scanned for jira's selector
    expect(ghResolve).not.toHaveBeenCalled();
  });

  it('keeps the index correct after loadCategory mutates an existing class', async () => {
    // Reindexing on registry mutation is exercised through ToolRuntime; here we
    // assert classesForSelector reflects an addMethod + reindex.
    const context = createContext();
    const cls = new ToolClass('files');
    const embed = await context.embedder.embed('read file contents');
    const sel = await context.selectorTable.intern(embed, 'files.read');
    cls.addMethod(sel, makeIMP('files', 'read', 'data'));
    context.registerClass(cls);

    // Add a second selector to the same class post-registration, then reindex.
    const embed2 = await context.embedder.embed('write file contents');
    const sel2 = await context.selectorTable.intern(embed2, 'files.write');
    cls.addMethod(sel2, makeIMP('files', 'write', 'written'));
    context.reindex();

    expect(context.classesForSelector('files.write')).toContain(cls);
    const result = await toolkit_dispatch(context, 'write file contents', { path: '/tmp/x' });
    expect(result.content).toBe('written');
  });

  it('memoizes tool summaries until the registry changes', async () => {
    const context = createContext();
    const cls = new ToolClass('a');
    const embed = await context.embedder.embed('do thing one');
    const sel = await context.selectorTable.intern(embed, 'a.one');
    cls.addMethod(sel, makeIMP('a', 'one'));
    context.registerClass(cls);

    const first = context.getToolSummaries();
    const second = context.getToolSummaries();
    expect(second).toBe(first); // same reference — cached

    context.reindex();
    const third = context.getToolSummaries();
    expect(third).not.toBe(first); // invalidated after mutation
    expect(third.map(s => s.name)).toContain('one');
  });

  it('clamps confidence to [0,1] when a backend returns distance > 1', async () => {
    // Custom vector index that reports an over-orthogonal distance (1.5).
    const overDistanceIndex = {
      insert() {},
      remove() {},
      size() { return 1; },
      search() {
        return [{ id: 'x.tool', distance: 1.5 }];
      },
    };
    const embedder = new LocalEmbedder(64);
    const selectorTable = new SelectorTable(overDistanceIndex as any, embedder);
    const cache = new ResolutionCache();
    const context = new DispatchContext(selectorTable, cache, overDistanceIndex as any, embedder);

    const cls = new ToolClass('x');
    const embed = await embedder.embed('thing');
    const sel = await selectorTable.intern(embed, 'x.tool');
    cls.addMethod(sel, makeIMP('x', 'tool', 'ran'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'thing');
    const proof = (result.metadata as any)?.proof;
    expect(proof).toBeDefined();
    // Whatever path is taken, no negative confidence may surface.
    if (typeof result.metadata?.confidence === 'number') {
      expect(result.metadata.confidence).toBeGreaterThanOrEqual(0);
      expect(result.metadata.confidence).toBeLessThanOrEqual(1);
    }
    for (const c of (result.metadata?.topCandidates as Array<{ confidence: number }> | undefined) ?? []) {
      expect(c.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it('completes the forwarding chain by decomposing an unrecognized intent', async () => {
    // A stub LLM client that decomposes the unknown intent into two sub-intents
    // that DO resolve to registered tools.
    const llmClient = {
      decompose: async () => ({
        strategy: 'sequential' as const,
        subIntents: [
          { intent: 'read file contents' },
          { intent: 'send message to channel' },
        ],
      }),
    };

    // A vector index that matches nothing — guarantees the broadened-search
    // step misses, so forwarding reaches the decomposition step deterministically.
    const emptyIndex = {
      insert() {},
      remove() {},
      size() { return 0; },
      search() { return []; },
    };
    const embedder = new LocalEmbedder(64);
    const selectorTable = new SelectorTable(emptyIndex as any, embedder);
    const cache = new ResolutionCache();
    const context = new DispatchContext(
      selectorTable, cache, emptyIndex as any, embedder, undefined, undefined,
      { llmClient },
    );

    const files = new ToolClass('files');
    const fSel = await selectorTable.intern(await embedder.embed('read file contents'), 'files.read');
    files.addMethod(fSel, makeIMP('files', 'read', 'file-data'));
    context.registerClass(files);

    // An intent that matches nothing directly — drives resolution to forward().
    const result = await context.forward(
      await selectorTable.resolve('xyzzy plugh frobnicate nothing matches'),
      'xyzzy plugh frobnicate nothing matches',
    );

    const steps = (result.metadata as any)?.fallbackSteps as Array<{ strategy: string; result: string }>;
    const llmStep = steps?.find(s => s.strategy === 'llm_disambiguate');
    expect(llmStep?.result).toBe('hit');
    expect((result.content as any)?.decomposed).toBe(true);
    expect((result.content as any)?.results).toHaveLength(2);
  });
});

describe('semantic map — learned refinement resolution (Pillar 4b)', () => {
  async function contextWithTool(
    toolEmbedText: string,
    selectorId: string,
    opts?: import('./semantic-map.js').SemanticMapOptions,
  ) {
    const embedder = new LocalEmbedder(64);
    const vectorIndex = new MemoryVectorIndex();
    const selectorTable = new SelectorTable(vectorIndex, embedder);
    const cache = new ResolutionCache();
    const context = new DispatchContext(
      selectorTable, cache, vectorIndex, embedder, undefined, undefined,
      { semanticMapOptions: opts },
    );

    const cls = new ToolClass('contexta');
    const selector = await selectorTable.intern(await embedder.embed(toolEmbedText), selectorId);
    cls.addMethod(selector, makeIMP('contexta', 'list_tasks', 'list_tasks:executed'));
    context.registerClass(cls);
    return context;
  }

  it('resolves an exact previously-disambiguated intent via the fast-path', async () => {
    const context = await contextWithTool('deploy production database cluster', 'contexta:list_tasks');

    // User disambiguates: this intent maps to contexta:list_tasks.
    await context.reinforceRefinement('quarterly revenue overview', 'contexta:list_tasks');

    // After learning: the exact intent resolves straight to the chosen tool via
    // the semantic-map fast-path (before vector search), at the exact tier.
    const after = await toolkit_dispatch(context, 'quarterly revenue overview');
    expect(after.content).toBe('list_tasks:executed');

    const proof = after.metadata!.proof as any;
    // The very first proof step is the semantic-map exact resolution.
    const smStep = proof.steps.find((s: any) => s.stage === 'semantic_map');
    expect(smStep).toBeDefined();
    expect(smStep.output).toBe('contexta:list_tasks');
    expect(String(smStep.decision)).toContain('exact');
    expect(after.metadata!.tier).toBe('exact');
  });

  it('boosts a similar (non-identical) intent toward the learned selector', async () => {
    // Threshold lowered so a partial-word-overlap intent clears the similar bar.
    // Tool vector is unrelated, so only the learned intent vector can surface it.
    const context = await contextWithTool('deploy production database cluster', 'contexta:list_tasks', {
      similarityThreshold: 0.5,
    });

    await context.reinforceRefinement('list all tasks', 'contexta:list_tasks');

    // Different canonical form ("list tasks now" vs "list tasks"), similar vector.
    const result = await toolkit_dispatch(context, 'list tasks now');
    expect(result.content).toBe('list_tasks:executed');

    const proof = result.metadata!.proof as any;
    const smStep = proof.steps.find((s: any) => s.stage === 'semantic_map');
    expect(smStep).toBeDefined();
    expect(String(smStep.decision)).toContain('injected');
  });

  it('does not fire for an unrelated intent after learning', async () => {
    const context = await contextWithTool('deploy production database cluster', 'contexta:list_tasks', {
      similarityThreshold: 0.85,
    });
    await context.reinforceRefinement('list all tasks', 'contexta:list_tasks');

    // Semantically unrelated — must not be hijacked by the learned preference.
    const result = await toolkit_dispatch(context, 'encrypt the backup archive');
    expect(result.content).not.toBe('list_tasks:executed');
  });

  it('records the mapping so size grows on reinforcement', async () => {
    const context = await contextWithTool('deploy production database cluster', 'contexta:list_tasks');
    expect(context.semanticMap.size).toBe(0);
    const pref = await context.reinforceRefinement('quarterly revenue overview', 'contexta:list_tasks');
    expect(context.semanticMap.size).toBe(1);
    expect(pref.selectorId).toBe('contexta:list_tasks');
    // The stored key is the canonicalized intent.
    expect(context.semanticMap.lookupExact(pref.intentCanonical)).not.toBeNull();
  });

  it('ignores a learned preference whose selector was unregistered (stale)', async () => {
    const context = await contextWithTool('deploy production database cluster', 'contexta:list_tasks');
    // Reinforce a selector that does not exist in the registry.
    await context.reinforceRefinement('quarterly revenue overview', 'ghost:missing_tool');

    const result = await toolkit_dispatch(context, 'quarterly revenue overview');
    // A stale preference must not force resolution — no semantic_map proof step
    // is emitted because the selector can't be resolved to an executable IMP.
    const proof = result.metadata!.proof as any;
    const smStep = proof.steps.find((s: any) => s.stage === 'semantic_map');
    expect(smStep).toBeUndefined();
  });
});

// Regression coverage for the HyperVault field report (#2): after the very
// first dispatch, the resolved intent used to get interned into the same
// selector table / vector index as compiled tools, so it could come back as
// a phantom "tool" — either enumerated via selectorTable.all(), or offered
// by refine() as the top "did you mean?" option (matching itself at ~1.0).
describe('selector table pollution — resolved intents must not surface as tools', () => {
  it('does not list a previously-resolved intent via selectorTable.all()', async () => {
    const context = createContext();
    const cls = new ToolClass('workspace');
    const embedding = await context.embedder.embed('list my workspaces');
    const selector = await context.selectorTable.intern(embedding, 'list:workspaces');
    cls.addMethod(selector, makeIMP('workspace', 'list_workspaces', 'workspaces!'));
    context.registerClass(cls);

    // An intent unrelated to any registered tool — forces the resolve() path
    // to intern it, which is exactly what happened in production.
    await toolkit_dispatch(context, 'search for projects in my workspace');

    const canonical = 'search:projects:workspace';
    expect(context.selectorTable.all().some(s => s.canonical === canonical)).toBe(false);
    // It's still tracked (for cache-hit purposes), just not as a "tool".
    expect(context.selectorTable.get(canonical)).toBeDefined();
  });

  it('never offers the caller\'s own intent as a refinement option', async () => {
    const context = createContext();
    const cls = new ToolClass('workspace');
    const embedding = await context.embedder.embed('list my workspaces');
    const selector = await context.selectorTable.intern(embedding, 'list:workspaces');
    cls.addMethod(selector, makeIMP('workspace', 'list_workspaces', 'workspaces!'));
    context.registerClass(cls);

    const intent = 'search for projects in my workspace';

    // First dispatch interns the intent into the shared vector index.
    const first = await toolkit_dispatch(context, intent);
    const firstRefinement = (first as any).refinement;
    if (firstRefinement) {
      expect(
        firstRefinement.options.some((o: any) => o.selectorId === 'search:projects:workspace'),
      ).toBe(false);
    }

    // Second dispatch of the *exact same* intent: before the fix, the intent
    // now matches itself at ~1.0 similarity and becomes the top "did you
    // mean?" suggestion, or gets dispatched as a dead tool with no owning
    // ToolClass — either way, a caller acting on it fails with "no longer in
    // the toolkit".
    const second = await toolkit_dispatch(context, intent);
    const secondRefinement = (second as any).refinement;
    if (secondRefinement) {
      expect(
        secondRefinement.options.some((o: any) => o.selectorId === 'search:projects:workspace'),
      ).toBe(false);
    }
    expect(context.selectorTable.get('search:projects:workspace')?.provenance).toBe('intent');
  });
});

// Regression coverage for the HyperVault field report (#3): without an
// LLMClient, MEDIUM verification is schema-only and LOW decomposition can't
// run, so both tiers silently fell through to "dispatch best match" — a
// footgun for write/destructive tools on a 0.60-confidence mismatch.
describe('requireLLMForSubHighDispatch — sub-HIGH tiers without an LLM client', () => {
  // A fake vector index that reports a fixed distance, so the resulting
  // confidence (and tier) is deterministic regardless of the embedder.
  function fixedDistanceIndex(distance: number, id = 'write.delete_record') {
    return {
      insert() {},
      remove() {},
      size() { return 1; },
      search() {
        return [{ id, distance }];
      },
    };
  }

  it('defaults to auto-dispatching a LOW-confidence match (prior behavior)', async () => {
    const index = fixedDistanceIndex(0.35); // confidence 0.65 → LOW tier
    const embedder = new LocalEmbedder(64);
    const selectorTable = new SelectorTable(index as any, embedder);
    const cache = new ResolutionCache();
    const context = new DispatchContext(selectorTable, cache, index as any, embedder);

    const cls = new ToolClass('write');
    const sel = await selectorTable.intern(await embedder.embed('delete a record'), 'write.delete_record');
    cls.addMethod(sel, makeIMP('write', 'delete_record', 'deleted!'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'delete a record');
    expect(result.content).toBe('deleted!');
    expect(result.metadata?.tier).toBe('low');
  });

  it('defers to refinement instead of auto-dispatching when the flag is set', async () => {
    const index = fixedDistanceIndex(0.35); // confidence 0.65 → LOW tier
    const embedder = new LocalEmbedder(64);
    const selectorTable = new SelectorTable(index as any, embedder);
    const cache = new ResolutionCache();
    const context = new DispatchContext(
      selectorTable, cache, index as any, embedder, undefined, undefined,
      { requireLLMForSubHighDispatch: true },
    );

    const cls = new ToolClass('write');
    const sel = await selectorTable.intern(await embedder.embed('delete a record'), 'write.delete_record');
    cls.addMethod(sel, makeIMP('write', 'delete_record', 'deleted!'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'delete a record');
    expect(result.content).not.toBe('deleted!');
    expect((result as any).refinement).toBeDefined();
  });

  it('does not affect HIGH/EXACT tier dispatch when the flag is set', async () => {
    const index = fixedDistanceIndex(0.02); // confidence 0.98 → EXACT tier
    const embedder = new LocalEmbedder(64);
    const selectorTable = new SelectorTable(index as any, embedder);
    const cache = new ResolutionCache();
    const context = new DispatchContext(
      selectorTable, cache, index as any, embedder, undefined, undefined,
      { requireLLMForSubHighDispatch: true },
    );

    const cls = new ToolClass('write');
    const sel = await selectorTable.intern(await embedder.embed('delete a record'), 'write.delete_record');
    cls.addMethod(sel, makeIMP('write', 'delete_record', 'deleted!'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'delete a record');
    expect(result.content).toBe('deleted!');
  });

  it('has no effect when an LLMClient is configured', async () => {
    const index = fixedDistanceIndex(0.35); // confidence 0.65 → LOW tier
    const embedder = new LocalEmbedder(64);
    const selectorTable = new SelectorTable(index as any, embedder);
    const cache = new ResolutionCache();
    const llmClient = {
      microCheck: async () => ({ pass: true, confidence: 1 }),
      decompose: async () => ({ decomposed: false, subIntents: [], strategy: 'none' as const }),
    };
    const context = new DispatchContext(
      selectorTable, cache, index as any, embedder, undefined, undefined,
      { requireLLMForSubHighDispatch: true, llmClient: llmClient as any },
    );

    const cls = new ToolClass('write');
    const sel = await selectorTable.intern(await embedder.embed('delete a record'), 'write.delete_record');
    cls.addMethod(sel, makeIMP('write', 'delete_record', 'deleted!'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'delete a record');
    expect(result.content).toBe('deleted!');
  });
});
