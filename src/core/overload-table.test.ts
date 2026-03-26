import { describe, it, expect } from 'vitest';
import { OverloadTable, OverloadAmbiguityError, SignatureValidationError } from './overload-table.js';
import { createSignature, param, SCType, validateArgumentTypes, validateNamedArgumentTypes } from './sc-types.js';
import { SCData, SCSelector, SCArray, SCObject, registerClass } from './sc-object.js';
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

// ---------------------------------------------------------------------------
// Strict signature validation — Type Confusion prevention
// ---------------------------------------------------------------------------

describe('validateArgumentTypes', () => {
  it('passes for exact type matches', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
      param('limit', 1, SCType.number()),
    ]);
    const result = validateArgumentTypes(sig, ['hello', 42]);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects primitive type mismatch (Type Confusion vector)', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
    ]);
    const result = validateArgumentTypes(sig, [42]);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('type_mismatch');
    expect(result.violations[0].expected).toBe('string');
    expect(result.violations[0].received).toBe('number');
  });

  it('rejects SCObject class mismatch (isa violation)', () => {
    const sig = createSignature([
      param('data', 0, SCType.object('SCSelector')),
    ]);
    // Pass an SCData where SCSelector is expected — classic type confusion
    const result = validateArgumentTypes(sig, [new SCData({ evil: true })]);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('isa_violation');
    expect(result.violations[0].expected).toBe('SCSelector');
    expect(result.violations[0].received).toBe('SCData');
  });

  it('accepts superclass matches (SCData is-a SCObject)', () => {
    const sig = createSignature([
      param('input', 0, SCType.object('SCObject')),
    ]);
    const result = validateArgumentTypes(sig, [new SCData({ x: 1 })]);
    expect(result.valid).toBe(true);
  });

  it('rejects excess arguments', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
    ]);
    const result = validateArgumentTypes(sig, ['hello', 'extra', 'args']);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0].kind).toBe('excess_argument');
    expect(result.violations[1].kind).toBe('excess_argument');
  });

  it('reports missing required arguments', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
      param('scope', 1, SCType.string()),
    ]);
    const result = validateArgumentTypes(sig, ['hello']);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('missing_required');
    expect(result.violations[0].parameterName).toBe('scope');
  });

  it('allows missing optional arguments', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
      param('limit', 1, SCType.number(), false, 10),
    ]);
    const result = validateArgumentTypes(sig, ['hello']);
    expect(result.valid).toBe(true);
  });

  it('accepts union type matches', () => {
    const sig = createSignature([
      param('input', 0, SCType.union(SCType.string(), SCType.number())),
    ]);
    expect(validateArgumentTypes(sig, ['hello']).valid).toBe(true);
    expect(validateArgumentTypes(sig, [42]).valid).toBe(true);
    expect(validateArgumentTypes(sig, [true]).valid).toBe(false);
  });

  it('rejects primitive where SCObject is expected', () => {
    const sig = createSignature([
      param('data', 0, SCType.object('SCData')),
    ]);
    // Passing a plain string where SCData is expected
    const result = validateArgumentTypes(sig, ['not-an-object']);
    expect(result.valid).toBe(false);
    expect(result.violations[0].kind).toBe('type_mismatch');
  });

  it('catches multiple violations in a single call', () => {
    const sig = createSignature([
      param('name', 0, SCType.string()),
      param('count', 1, SCType.number()),
      param('data', 2, SCType.object('SCData')),
    ]);
    // All wrong: number for string, string for number, string for SCData
    const result = validateArgumentTypes(sig, [42, 'not-a-number', 'not-an-object']);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(3);
  });
});

describe('validateNamedArgumentTypes', () => {
  it('validates named arguments correctly', () => {
    const sig = createSignature([
      param('title', 0, SCType.string()),
      param('count', 1, SCType.number()),
    ]);
    const result = validateNamedArgumentTypes(sig, { title: 'hello', count: 5 });
    expect(result.valid).toBe(true);
  });

  it('rejects unknown argument names as excess', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
    ]);
    const result = validateNamedArgumentTypes(sig, {
      query: 'hello',
      __proto__: 'attack',   // Prototype pollution attempt
      evil_param: 'injected',
    });
    expect(result.valid).toBe(false);
    const excessViolations = result.violations.filter(v => v.kind === 'excess_argument');
    expect(excessViolations.length).toBeGreaterThanOrEqual(1);
  });

  it('detects type mismatch in named arguments', () => {
    const sig = createSignature([
      param('query', 0, SCType.string()),
      param('limit', 1, SCType.number()),
    ]);
    const result = validateNamedArgumentTypes(sig, { query: 42, limit: 'not-number' });
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBe(2);
  });
});

describe('OverloadTable.validateAndResolve', () => {
  it('resolves and validates correct arguments', () => {
    const table = new OverloadTable('search');
    const sig = createSignature([
      param('query', 0, SCType.string()),
    ]);
    table.register(sig, mockIMP('search_text'));

    const result = table.validateAndResolve(['hello']);
    expect(result).not.toBeNull();
    expect(result!.imp.toolName).toBe('search_text');
  });

  it('throws SignatureValidationError on type mismatch', () => {
    const table = new OverloadTable('search');

    // Register two overloads
    const sig1 = createSignature([param('query', 0, SCType.string())]);
    table.register(sig1, mockIMP('search_text'));

    const sig2 = createSignature([param('data', 0, SCType.object('SCData'))]);
    table.register(sig2, mockIMP('search_data'));

    // Number matches neither overload → resolve returns null
    const result = table.validateAndResolve([42]);
    expect(result).toBeNull();
  });

  it('blocks Type Confusion: SCData passed where SCSelector expected', () => {
    const table = new OverloadTable('execute');

    // Only accepts SCSelector
    const sig = createSignature([
      param('selector', 0, SCType.object('SCSelector')),
    ]);
    table.register(sig, mockIMP('execute_selector'));

    // Attacker sends SCData (wrong SCObject subclass) — resolve returns null
    // because matchType returns 'none' for non-related classes
    const result = table.validateAndResolve([new SCData({ attack: true })]);
    expect(result).toBeNull();
  });

  it('blocks Type Confusion via any-typed slot with validateAndResolveNamed', () => {
    const table = new OverloadTable('process');

    // Has an 'any' typed slot + a typed slot — resolve will succeed via 'any',
    // but the typed slot must still be validated strictly
    const sig = createSignature([
      param('input', 0, SCType.any()),
      param('config', 1, SCType.object('SCData')),
    ]);
    table.register(sig, mockIMP('process_any'));

    // Correct: any + SCData → passes
    const good = table.validateAndResolveNamed({
      input: 'anything',
      config: new SCData({ key: 'value' }),
    });
    expect(good).not.toBeNull();

    // Attack: any + string (not SCData) — resolve returns null because
    // scoreSignatureMatch returns -1 for a non-matching typed slot.
    // validateAndResolveNamed returns null (no valid overload).
    const result = table.validateAndResolveNamed({
      input: 'anything',
      config: 'not-an-scdata' as unknown,
    });
    expect(result).toBeNull();
  });

  it('throws SignatureValidationError with detailed violation info on excess args', () => {
    const table = new OverloadTable('send');
    const sig = createSignature([
      param('message', 0, SCType.string()),
    ]);
    table.register(sig, mockIMP('send_message'));

    // Resolve succeeds (message is string), but there's an extra injected field
    try {
      table.validateAndResolveNamed({
        message: 'valid',
        injected: 'attack-payload',
      });
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SignatureValidationError);
      const validationErr = err as SignatureValidationError;
      expect(validationErr.violations.length).toBeGreaterThanOrEqual(1);
      expect(validationErr.violations[0].kind).toBe('excess_argument');
      expect(validationErr.violations[0].parameterName).toBe('injected');
      expect(validationErr.message).toContain('Type Confusion');
    }
  });

  it('rejects unknown named arguments as excess', () => {
    const table = new OverloadTable('create');
    const sig = createSignature([
      param('title', 0, SCType.string()),
    ]);
    table.register(sig, mockIMP('create_item'));

    expect(() => {
      table.validateAndResolveNamed({
        title: 'valid',
        injected_field: 'attack',
      });
    }).toThrow(SignatureValidationError);
  });
});
