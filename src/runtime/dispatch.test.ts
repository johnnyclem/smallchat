import { describe, it, expect, vi } from 'vitest';
import { DispatchContext, UnrecognizedIntent, toolkit_dispatch } from './dispatch.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { ToolIMP, ToolProtocol, ToolSelector } from '../core/types.js';

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

  it('throws UnrecognizedIntent when no tool matches', async () => {
    const context = createContext();

    await expect(
      toolkit_dispatch(context, 'completely unknown operation xyz123'),
    ).rejects.toThrow(UnrecognizedIntent);
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

  it('UnrecognizedIntent carries nearest selectors and a suggestion', async () => {
    const context = createContext();

    // Register one tool so vector index is non-empty
    const cls = new ToolClass('fs');
    const embedding = await context.embedder.embed('read file contents');
    const selector = context.selectorTable.intern(embedding, 'fs.read_file');
    cls.addMethod(selector, makeIMP('fs', 'read_file'));
    context.registerClass(cls);

    try {
      await toolkit_dispatch(context, 'completely unrelated intent xyz999');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnrecognizedIntent);
      const unrecognized = err as UnrecognizedIntent;
      expect(unrecognized.intent).toBe('completely unrelated intent xyz999');
      expect(unrecognized.nearestSelectors).toBeDefined();
      expect(typeof unrecognized.suggestion).toBe('string');
    }
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
