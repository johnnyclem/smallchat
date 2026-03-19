import { describe, it, expect } from 'vitest';
import { ResolutionCache } from './resolution-cache.js';
import type { ToolIMP, ToolSelector } from './types.js';

function makeSelector(canonical: string): ToolSelector {
  return {
    vector: new Float32Array(8),
    canonical,
    parts: canonical.split(':'),
    arity: canonical.split(':').length - 1,
  };
}

function makeIMP(providerId: string, toolName: string): ToolIMP {
  return {
    providerId,
    toolName,
    transportType: 'local',
    schema: null,
    schemaLoader: async () => ({ name: toolName, description: '', inputSchema: { type: 'object' }, arguments: [] }),
    execute: async () => ({ content: null }),
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
  };
}

describe('ResolutionCache', () => {
  it('returns null on cache miss', () => {
    const cache = new ResolutionCache();
    const sel = makeSelector('search:docs');
    expect(cache.lookup(sel)).toBeNull();
  });

  it('stores and retrieves a resolution', () => {
    const cache = new ResolutionCache();
    const sel = makeSelector('search:docs');
    const imp = makeIMP('github', 'search');

    cache.store(sel, imp, 0.95);
    const result = cache.lookup(sel);

    expect(result).not.toBeNull();
    expect(result!.imp.toolName).toBe('search');
    expect(result!.confidence).toBe(0.95);
  });

  it('does not cache low-confidence resolutions', () => {
    const cache = new ResolutionCache();
    const sel = makeSelector('search:docs');
    const imp = makeIMP('github', 'search');

    cache.store(sel, imp, 0.5); // Below default threshold of 0.85
    expect(cache.lookup(sel)).toBeNull();
  });

  it('increments hit count on cache hit', () => {
    const cache = new ResolutionCache();
    const sel = makeSelector('search:docs');
    const imp = makeIMP('github', 'search');

    cache.store(sel, imp, 0.95);
    cache.lookup(sel);
    cache.lookup(sel);
    const result = cache.lookup(sel);

    expect(result!.hitCount).toBe(4); // 1 initial + 3 lookups
  });

  it('evicts oldest entries when at capacity', () => {
    const cache = new ResolutionCache(2); // Max 2 entries

    cache.store(makeSelector('a'), makeIMP('p', 'a'), 0.95);
    cache.store(makeSelector('b'), makeIMP('p', 'b'), 0.95);
    cache.store(makeSelector('c'), makeIMP('p', 'c'), 0.95); // Should evict 'a'

    expect(cache.lookup(makeSelector('a'))).toBeNull();
    expect(cache.lookup(makeSelector('b'))).not.toBeNull();
    expect(cache.lookup(makeSelector('c'))).not.toBeNull();
  });

  it('flushes all entries', () => {
    const cache = new ResolutionCache();
    cache.store(makeSelector('a'), makeIMP('p', 'a'), 0.95);
    cache.store(makeSelector('b'), makeIMP('p', 'b'), 0.95);

    cache.flush();
    expect(cache.size).toBe(0);
  });

  it('flushes entries for a specific provider', () => {
    const cache = new ResolutionCache();
    cache.store(makeSelector('a'), makeIMP('github', 'a'), 0.95);
    cache.store(makeSelector('b'), makeIMP('slack', 'b'), 0.95);

    cache.flushProvider('github');
    expect(cache.lookup(makeSelector('a'))).toBeNull();
    expect(cache.lookup(makeSelector('b'))).not.toBeNull();
  });

  it('flushes entries for a specific selector', () => {
    const cache = new ResolutionCache();
    const selA = makeSelector('a');
    cache.store(selA, makeIMP('p', 'a'), 0.95);
    cache.store(makeSelector('b'), makeIMP('p', 'b'), 0.95);

    cache.flushSelector(selA);
    expect(cache.lookup(selA)).toBeNull();
    expect(cache.lookup(makeSelector('b'))).not.toBeNull();
  });
});
