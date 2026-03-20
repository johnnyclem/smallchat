import { describe, it, expect } from 'vitest';
import { DispatchContext, UnrecognizedIntent, toolkit_dispatch } from './dispatch.js';
import type { FallbackChainResult } from './dispatch.js';
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
});
