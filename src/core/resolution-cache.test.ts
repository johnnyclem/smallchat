import { describe, it, expect, vi } from 'vitest';
import { ResolutionCache, computeSchemaFingerprint } from './resolution-cache.js';
import type { ToolIMP, ToolSelector, CacheVersionContext, InvalidationEvent } from './types.js';

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

function makeVersionContext(overrides?: Partial<CacheVersionContext>): CacheVersionContext {
  return {
    providerVersions: overrides?.providerVersions ?? new Map(),
    modelVersion: overrides?.modelVersion ?? '',
    schemaFingerprints: overrides?.schemaFingerprints ?? new Map(),
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

describe('ResolutionCache — provider + model version tagging', () => {
  it('tags entries with provider version on store', () => {
    const ctx = makeVersionContext({
      providerVersions: new Map([['github', '2.1.0']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    const result = cache.lookup(makeSelector('search:docs'));

    expect(result).not.toBeNull();
    expect(result!.providerVersion).toBe('2.1.0');
  });

  it('evicts stale entries when provider version changes', () => {
    const ctx = makeVersionContext({
      providerVersions: new Map([['github', '2.1.0']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    expect(cache.lookup(makeSelector('search:docs'))).not.toBeNull();

    // Provider upgrades
    cache.setProviderVersion('github', '3.0.0');
    expect(cache.lookup(makeSelector('search:docs'))).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('tags entries with model version on store', () => {
    const ctx = makeVersionContext({ modelVersion: 'minilm-v6' });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    const result = cache.lookup(makeSelector('search:docs'));

    expect(result).not.toBeNull();
    expect(result!.modelVersion).toBe('minilm-v6');
  });

  it('evicts stale entries when model version changes', () => {
    const ctx = makeVersionContext({ modelVersion: 'minilm-v6' });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    expect(cache.lookup(makeSelector('search:docs'))).not.toBeNull();

    // Embedder model upgrades
    cache.setModelVersion('minilm-v12');
    expect(cache.lookup(makeSelector('search:docs'))).toBeNull();
  });

  it('does not evict when version has not changed', () => {
    const ctx = makeVersionContext({
      providerVersions: new Map([['github', '2.1.0']]),
      modelVersion: 'minilm-v6',
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);

    // Same versions — no eviction
    cache.setProviderVersion('github', '2.1.0');
    cache.setModelVersion('minilm-v6');
    expect(cache.lookup(makeSelector('search:docs'))).not.toBeNull();
  });

  it('entries without version tags are not affected by version changes', () => {
    // No version context at construction — entries get undefined tags
    const cache = new ResolutionCache();

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);

    // Setting a version now doesn't evict the untagged entry
    cache.setProviderVersion('github', '3.0.0');
    expect(cache.lookup(makeSelector('search:docs'))).not.toBeNull();
  });
});

describe('ResolutionCache — schema fingerprint expiration', () => {
  it('evicts entries when schema fingerprint changes', () => {
    const ctx = makeVersionContext({
      schemaFingerprints: new Map([['github', 'abc123']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    expect(cache.lookup(makeSelector('search:docs'))).not.toBeNull();

    // Schema changes (e.g., new tool added, parameter changed)
    cache.setSchemaFingerprint('github', 'def456');
    expect(cache.lookup(makeSelector('search:docs'))).toBeNull();
  });

  it('does not evict when schema fingerprint is unchanged', () => {
    const ctx = makeVersionContext({
      schemaFingerprints: new Map([['github', 'abc123']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);

    cache.setSchemaFingerprint('github', 'abc123');
    expect(cache.lookup(makeSelector('search:docs'))).not.toBeNull();
  });

  it('only evicts entries from the changed provider', () => {
    const ctx = makeVersionContext({
      schemaFingerprints: new Map([['github', 'aaa'], ['slack', 'bbb']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    cache.store(makeSelector('send:message'), makeIMP('slack', 'post'), 0.95);

    // Only github schema changes
    cache.setSchemaFingerprint('github', 'changed');

    expect(cache.lookup(makeSelector('search:docs'))).toBeNull();
    expect(cache.lookup(makeSelector('send:message'))).not.toBeNull();
  });
});

describe('ResolutionCache — invalidateOn hooks', () => {
  it('fires hook on flush', () => {
    const cache = new ResolutionCache();
    const events: InvalidationEvent[] = [];
    cache.invalidateOn((e) => events.push(e));

    cache.store(makeSelector('a'), makeIMP('p', 'a'), 0.95);
    cache.flush();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('flush');
  });

  it('fires hook on flushProvider', () => {
    const cache = new ResolutionCache();
    const events: InvalidationEvent[] = [];
    cache.invalidateOn((e) => events.push(e));

    cache.store(makeSelector('a'), makeIMP('github', 'a'), 0.95);
    cache.flushProvider('github');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'provider', providerId: 'github' });
  });

  it('fires hook on flushSelector', () => {
    const cache = new ResolutionCache();
    const events: InvalidationEvent[] = [];
    cache.invalidateOn((e) => events.push(e));

    const sel = makeSelector('a');
    cache.store(sel, makeIMP('p', 'a'), 0.95);
    cache.flushSelector(sel);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('selector');
  });

  it('fires hook on stale entry eviction', () => {
    const ctx = makeVersionContext({
      providerVersions: new Map([['github', '1.0']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);
    const events: InvalidationEvent[] = [];
    cache.invalidateOn((e) => events.push(e));

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    cache.setProviderVersion('github', '2.0');
    cache.lookup(makeSelector('search:docs')); // triggers stale eviction

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'stale',
      reason: 'provider-version',
      key: 'search:docs',
    });
  });

  it('fires stale hook for schema change', () => {
    const ctx = makeVersionContext({
      schemaFingerprints: new Map([['github', 'old']]),
    });
    const cache = new ResolutionCache(1024, 0.85, ctx);
    const events: InvalidationEvent[] = [];
    cache.invalidateOn((e) => events.push(e));

    cache.store(makeSelector('search:docs'), makeIMP('github', 'search'), 0.95);
    cache.setSchemaFingerprint('github', 'new');
    cache.lookup(makeSelector('search:docs'));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'stale',
      reason: 'schema-change',
      key: 'search:docs',
    });
  });

  it('unsubscribe stops hook from firing', () => {
    const cache = new ResolutionCache();
    const events: InvalidationEvent[] = [];
    const unsub = cache.invalidateOn((e) => events.push(e));

    cache.flush();
    expect(events).toHaveLength(1);

    unsub();
    cache.flush();
    expect(events).toHaveLength(1); // no new event
  });

  it('supports multiple hooks', () => {
    const cache = new ResolutionCache();
    let count1 = 0;
    let count2 = 0;
    cache.invalidateOn(() => count1++);
    cache.invalidateOn(() => count2++);

    cache.flush();
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});

describe('computeSchemaFingerprint', () => {
  it('produces consistent fingerprints for same input', () => {
    const schemas = [
      { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'list', inputSchema: { type: 'object' } },
    ];
    const a = computeSchemaFingerprint(schemas);
    const b = computeSchemaFingerprint(schemas);
    expect(a).toBe(b);
  });

  it('is order-independent (sorted by name)', () => {
    const a = computeSchemaFingerprint([
      { name: 'list', inputSchema: { type: 'object' } },
      { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ]);
    const b = computeSchemaFingerprint([
      { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'list', inputSchema: { type: 'object' } },
    ]);
    expect(a).toBe(b);
  });

  it('changes when schema changes', () => {
    const before = computeSchemaFingerprint([
      { name: 'search', inputSchema: { type: 'object' } },
    ]);
    const after = computeSchemaFingerprint([
      { name: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ]);
    expect(before).not.toBe(after);
  });

  it('returns 8-char hex string', () => {
    const fp = computeSchemaFingerprint([{ name: 'x', inputSchema: {} }]);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
});
