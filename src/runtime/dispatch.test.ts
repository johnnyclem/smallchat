import { describe, it, expect } from 'vitest';
import { DispatchContext, UnrecognizedIntent, toolkit_dispatch } from './dispatch.js';
import { ResolutionCache } from '../core/resolution-cache.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass } from '../core/tool-class.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { ToolIMP, ToolSelector } from '../core/types.js';

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
});
