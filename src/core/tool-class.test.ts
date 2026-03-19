import { describe, it, expect } from 'vitest';
import { ToolClass, ToolProxy } from './tool-class.js';
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
    execute: async () => ({ content: `executed:${toolName}` }),
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
  };
}

describe('ToolClass', () => {
  it('adds and resolves methods', () => {
    const cls = new ToolClass('github');
    const sel = makeSelector('search:code');
    const imp = makeIMP('github', 'search_code');

    cls.addMethod(sel, imp);
    const resolved = cls.resolveSelector(sel);

    expect(resolved).toBe(imp);
  });

  it('walks superclass chain for resolution', () => {
    const parent = new ToolClass('base');
    const child = new ToolClass('extended');
    child.superclass = parent;

    const sel = makeSelector('search:code');
    const imp = makeIMP('base', 'search_code');
    parent.addMethod(sel, imp);

    const resolved = child.resolveSelector(sel);
    expect(resolved).toBe(imp);
  });

  it('returns null when selector is not found', () => {
    const cls = new ToolClass('github');
    const sel = makeSelector('unknown:method');
    expect(cls.resolveSelector(sel)).toBeNull();
  });

  it('canHandle checks own table and superclass', () => {
    const parent = new ToolClass('base');
    const child = new ToolClass('extended');
    child.superclass = parent;

    const sel = makeSelector('search:code');
    parent.addMethod(sel, makeIMP('base', 'search'));

    expect(child.canHandle(sel)).toBe(true);
    expect(child.canHandle(makeSelector('unknown'))).toBe(false);
  });

  it('lists all selectors including inherited', () => {
    const parent = new ToolClass('base');
    parent.addMethod(makeSelector('base:method'), makeIMP('base', 'base_method'));

    const child = new ToolClass('extended');
    child.superclass = parent;
    child.addMethod(makeSelector('child:method'), makeIMP('extended', 'child_method'));

    const selectors = child.allSelectors();
    expect(selectors).toContain('base:method');
    expect(selectors).toContain('child:method');
  });

  it('checks protocol conformance', () => {
    const cls = new ToolClass('github');
    const protocol = {
      name: 'Searchable',
      embedding: new Float32Array(8),
      requiredSelectors: [],
      optionalSelectors: [],
    };

    expect(cls.conformsTo(protocol)).toBe(false);
    cls.addProtocol(protocol);
    expect(cls.conformsTo(protocol)).toBe(true);
  });
});

describe('ToolProxy', () => {
  it('loads schema lazily on first execute', async () => {
    let loaded = false;
    const proxy = new ToolProxy(
      'test',
      'my_tool',
      'local',
      async () => {
        loaded = true;
        return {
          name: 'my_tool',
          description: 'A test tool',
          inputSchema: { type: 'object' },
          arguments: [],
        };
      },
    );

    expect(proxy.schema).toBeNull();
    expect(loaded).toBe(false);

    await proxy.execute({});

    expect(loaded).toBe(true);
    expect(proxy.schema).not.toBeNull();
    expect(proxy.schema!.name).toBe('my_tool');
  });

  it('returns validation errors for invalid args', async () => {
    const proxy = new ToolProxy(
      'test',
      'my_tool',
      'local',
      async () => ({ name: 'my_tool', description: '', inputSchema: { type: 'object' }, arguments: [] }),
      {
        required: [{ name: 'query', type: { type: 'string' }, description: 'Search query', required: true }],
        optional: [],
        validate: (args) => {
          if (!('query' in args)) {
            return { valid: false, errors: [{ path: 'query', message: 'Required argument "query" is missing' }] };
          }
          return { valid: true, errors: [] };
        },
      },
    );

    const result = await proxy.execute({}); // Missing required 'query'
    expect(result.isError).toBe(true);
  });
});
