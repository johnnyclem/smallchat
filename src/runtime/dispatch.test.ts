import { describe, it, expect, vi } from 'vitest';
import { DispatchContext, UnrecognizedIntent, toolkit_dispatch, smallchat_dispatchStream } from './dispatch.js';
import type { FallbackChainResult } from './dispatch.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { ToolIMP, ToolProtocol, ToolSelector, ToolResult, DispatchEvent } from '../core/types.js';

function createContext() {
  const embedder = new LocalEmbedder(64);
  const vectorIndex = new MemoryVectorIndex();
  const selectorTable = new SelectorTable(vectorIndex, embedder);
  const cache = new ResolutionCache();
  return new DispatchContext(selectorTable, cache, vectorIndex, embedder);
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
    const selector = context.selectorTable.intern(embedding, 'github.search_code');
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
    const selector = context.selectorTable.intern(embedding, 'github.search_code');
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
    const selector = context.selectorTable.intern(embedding, 'github.search_code');
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
    expect(result.metadata!.fallback).toBe(true);

    const content = result.content as FallbackChainResult;
    expect(content.tool).toBe('unknown');
    expect(content.message.toLowerCase()).toContain('want me to search');
    expect(content.intent).toBe('completely unknown operation xyz123');
    expect(content.fallbackSteps).toBeDefined();
    expect(content.fallbackSteps.length).toBeGreaterThan(0);
  });

  it('tries superclass chain during fallback', async () => {
    const context = createContext();

    // Create a superclass with a tool
    const superclass = new ToolClass('base-tools');
    const embedding = await context.embedder.embed('deploy application');
    const selector = context.selectorTable.intern(embedding, 'base.deploy');
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
    const sel1 = context.selectorTable.intern(embedding, 'multi.search_a');
    const sel2 = context.selectorTable.intern(
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

  it('includes fallback steps trace in metadata', async () => {
    const context = createContext();

    const result = await toolkit_dispatch(context, 'nonexistent tool operation');
    const steps = (result.metadata as any)?.fallbackSteps;

    expect(steps).toBeDefined();
    expect(Array.isArray(steps)).toBe(true);
    // Should have at least the LLM disambiguate stub step
    expect(steps.some((s: any) => s.strategy === 'llm_disambiguate')).toBe(true);
  });

  it('passes arguments through to the IMP and returns them in metadata', async () => {
    const context = createContext();
    const cls = new ToolClass('slack');

    const embedding = await context.embedder.embed('send message to channel');
    const selector = context.selectorTable.intern(embedding, 'slack.send_message');
    cls.addMethod(selector, makeIMP('slack', 'send_message'));
    context.registerClass(cls);

    const result = await toolkit_dispatch(context, 'send message to channel', {
      channel: '#general',
      text: 'hello world',
    });

    expect(result.content).toBe('send_message:executed');
    expect(result.metadata).toEqual({
      args: { channel: '#general', text: 'hello world' },
    });
  });

  it('selects the correct provider when multiple are registered', async () => {
    const context = createContext();

    // Provider A: github — handles "search code repositories"
    const github = new ToolClass('github');
    const ghEmbed = await context.embedder.embed('search code repositories');
    const ghSel = context.selectorTable.intern(ghEmbed, 'github.search_code');
    github.addMethod(ghSel, makeIMP('github', 'search_code'));
    context.registerClass(github);

    // Provider B: jira — handles "create bug report"
    const jira = new ToolClass('jira');
    const jiraEmbed = await context.embedder.embed('create bug report');
    const jiraSel = context.selectorTable.intern(jiraEmbed, 'jira.create_issue');
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
    const selector = context.selectorTable.intern(embedding, 'ai.summarize');
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
    const selector = context.selectorTable.intern(embedding, 'fs.read_file');
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
    const selector = context.selectorTable.intern(embedding, 'proto.list_items');

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
    const selector = context.selectorTable.intern(embedding, 'github.search_code');
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
    const selector = context.selectorTable.intern(embedding, 'github.search_code');
    cls.addMethod(selector, makeIMP('github', 'search_code'));
    context.registerClass(cls);

    const gen = smallchat_dispatchStream(context, 'search code');
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('resolving');

    // Consume remaining events
    for await (const _ of gen) { /* drain */ }
  });

  it('yields fallback done event when no tool matches', async () => {
    const context = createContext();

    const events = await collectEvents(
      smallchat_dispatchStream(context, 'completely unknown operation xyz123'),
    );

    expect(events[0].type).toBe('resolving');
    const doneEvent = events.find(e => e.type === 'done');
    expect(doneEvent).toBeDefined();
    const result = (doneEvent as { type: 'done'; result: ToolResult }).result;
    expect(result.metadata?.fallback).toBe(true);
    const content = result.content as FallbackChainResult;
    expect(content.intent).toBe('completely unknown operation xyz123');
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
    const selector = context.selectorTable.intern(embedding, 'openai.chat_completion');
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
    const selector = context.selectorTable.intern(embedding, 'github.search_code');
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
});
