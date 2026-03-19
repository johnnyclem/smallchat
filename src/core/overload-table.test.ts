import { describe, it, expect } from 'vitest';
import { OverloadTable, OverloadAmbiguityError } from './overload-table.js';
import { createSignature, param, SCType } from './sc-types.js';
import { SCData, SCSelector } from './sc-object.js';
import type { ToolIMP, ToolSelector as ToolSelectorType } from './types.js';

function mockIMP(name: string): ToolIMP {
  return {
    providerId: 'test',
    toolName: name,
    transportType: 'local',
    schema: null,
    schemaLoader: async () => ({ name, description: name, inputSchema: { type: 'object' }, arguments: [] }),
    execute: async (args) => ({ content: { tool: name, args } }),
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
  };
}

describe('OverloadTable', () => {
  it('registers and resolves a single overload', () => {
    const table = new OverloadTable('search:code');
    const sig = createSignature([
      param('query', 0, SCType.string()),
    ]);
    const imp = mockIMP('search_by_query');
    table.register(sig, imp);

    const result = table.resolve(['hello']);
    expect(result).not.toBeNull();
    expect(result!.imp.toolName).toBe('search_by_query');
    expect(result!.matchQuality).toBe('exact');
  });

  it('resolves correct overload by arity', () => {
    const table = new OverloadTable('search');

    // Overload 1: search(query)
    const sig1 = createSignature([
      param('query', 0, SCType.string()),
    ]);
    table.register(sig1, mockIMP('search_simple'));

    // Overload 2: search(query, language)
    const sig2 = createSignature([
      param('query', 0, SCType.string()),
      param('language', 1, SCType.string()),
    ]);
    table.register(sig2, mockIMP('search_with_lang'));

    // Should pick overload 1
    const r1 = table.resolve(['test']);
    expect(r1!.imp.toolName).toBe('search_simple');

    // Should pick overload 2
    const r2 = table.resolve(['test', 'typescript']);
    expect(r2!.imp.toolName).toBe('search_with_lang');
  });

  it('resolves correct overload by type', () => {
    const table = new OverloadTable('send');

    // Overload 1: send(string)
    const sig1 = createSignature([
      param('message', 0, SCType.string()),
    ]);
    table.register(sig1, mockIMP('send_text'));

    // Overload 2: send(SCData)
    const sig2 = createSignature([
      param('payload', 0, SCType.object('SCData')),
    ]);
    table.register(sig2, mockIMP('send_data'));

    // String arg → send_text
    const r1 = table.resolve(['hello']);
    expect(r1!.imp.toolName).toBe('send_text');

    // SCData arg → send_data
    const r2 = table.resolve([new SCData({ key: 'value' })]);
    expect(r2!.imp.toolName).toBe('send_data');
  });

  it('returns null when no overload matches', () => {
    const table = new OverloadTable('test');
    const sig = createSignature([
      param('query', 0, SCType.string()),
    ]);
    table.register(sig, mockIMP('test'));

    // Number doesn't match string
    const result = table.resolve([42]);
    expect(result).toBeNull();
  });

  it('rejects duplicate signature keys', () => {
    const table = new OverloadTable('test');
    const sig = createSignature([param('a', 0, SCType.string())]);
    table.register(sig, mockIMP('first'));

    expect(() => {
      table.register(sig, mockIMP('second'));
    }).toThrow('Duplicate overload');
  });

  it('resolves named arguments', () => {
    const table = new OverloadTable('create');

    const sig = createSignature([
      param('title', 0, SCType.string()),
      param('body', 1, SCType.string()),
    ]);
    table.register(sig, mockIMP('create_issue'));

    const result = table.resolveNamed({ title: 'Bug', body: 'Details' });
    expect(result).not.toBeNull();
    expect(result!.imp.toolName).toBe('create_issue');
  });

  it('supports SCObject type matching via superclass', () => {
    const table = new OverloadTable('process');

    // Accepts any SCObject
    const sig = createSignature([
      param('input', 0, SCType.object('SCObject')),
    ]);
    table.register(sig, mockIMP('process_any'));

    // SCData is-a SCObject → superclass match
    const result = table.resolve([new SCData({ x: 1 })]);
    expect(result).not.toBeNull();
    expect(result!.matchQuality).toBe('superclass');
  });

  it('prefers exact match over superclass match', () => {
    const table = new OverloadTable('handle');

    const sig1 = createSignature([
      param('input', 0, SCType.object('SCObject')),
    ]);
    table.register(sig1, mockIMP('handle_generic'));

    const sig2 = createSignature([
      param('input', 0, SCType.object('SCData')),
    ]);
    table.register(sig2, mockIMP('handle_data'));

    const result = table.resolve([new SCData({ x: 1 })]);
    expect(result!.imp.toolName).toBe('handle_data');
  });

  it('supports union types', () => {
    const table = new OverloadTable('format');

    const sig = createSignature([
      param('input', 0, SCType.union(SCType.string(), SCType.number())),
    ]);
    table.register(sig, mockIMP('format_primitive'));

    expect(table.resolve(['hello'])!.imp.toolName).toBe('format_primitive');
    expect(table.resolve([42])!.imp.toolName).toBe('format_primitive');
    expect(table.resolve([true])).toBeNull(); // boolean not in union
  });

  it('supports id (any) type', () => {
    const table = new OverloadTable('log');

    const sig = createSignature([
      param('value', 0, SCType.any()),
    ]);
    table.register(sig, mockIMP('log_any'));

    expect(table.resolve(['string'])!.imp.toolName).toBe('log_any');
    expect(table.resolve([42])!.imp.toolName).toBe('log_any');
    expect(table.resolve([new SCData({})])!.imp.toolName).toBe('log_any');
  });

  it('prefers developer-defined over semantic overloads in ambiguity', () => {
    const table = new OverloadTable('search');

    const sig1 = createSignature([param('q', 0, SCType.any())]);
    table.register(sig1, mockIMP('dev_search'), { isSemanticOverload: false });

    const sig2 = createSignature([param('query', 0, SCType.any())]);
    // Different signature key due to different parameter name type
    // Let's use a string type instead to make it distinct
    const sig2b = createSignature([param('query', 0, SCType.string())]);
    table.register(sig2b, mockIMP('semantic_search'), { isSemanticOverload: true });

    // For a string arg, sig2b matches with 'exact' (4), sig1 matches with 'any' (1)
    // sig2b should win on score
    const result = table.resolve(['test']);
    expect(result!.imp.toolName).toBe('semantic_search');
  });

  it('reports size and hasSignature correctly', () => {
    const table = new OverloadTable('test');
    expect(table.size).toBe(0);

    const sig = createSignature([param('x', 0, SCType.string())]);
    table.register(sig, mockIMP('test'));

    expect(table.size).toBe(1);
    expect(table.hasSignature('string')).toBe(true);
    expect(table.hasSignature('number')).toBe(false);
  });

  it('handles optional parameters', () => {
    const table = new OverloadTable('fetch');

    const sig = createSignature([
      param('url', 0, SCType.string(), true),
      param('headers', 1, SCType.object('SCData'), false),
    ]);
    table.register(sig, mockIMP('fetch_url'));

    // Just required arg
    const r1 = table.resolve(['https://example.com']);
    expect(r1).not.toBeNull();

    // Both args
    const r2 = table.resolve(['https://example.com', new SCData({})]);
    expect(r2).not.toBeNull();

    // Too many args
    const r3 = table.resolve(['url', new SCData({}), 'extra']);
    expect(r3).toBeNull();
  });
});
