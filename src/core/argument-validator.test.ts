import { describe, it, expect } from 'vitest';
import { compileArgumentValidator, createSchemaConstraints, InputSchemaError } from './argument-validator.js';

const purgeSchema = {
  type: 'object',
  properties: {
    days: { type: 'integer', minimum: 1 },
    table: { type: 'string', enum: ['logs', 'events'] },
    filter: { $ref: '#/$defs/Filter' },
  },
  required: ['days', 'table'],
  additionalProperties: false,
  $defs: {
    Filter: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
  },
};

describe('compileArgumentValidator', () => {
  const validator = compileArgumentValidator(purgeSchema);

  it('treats a schema without $schema as JSON Schema 2020-12', () => {
    expect(validator.dialect).toBe('2020-12');
  });

  it('accepts arguments that match the schema', () => {
    expect(validator.check({ days: 7, table: 'logs', filter: { tag: 'x' } }).valid).toBe(true);
  });

  it('reports wrong types, out-of-enum values and unknown keys in model-readable form', () => {
    const { valid, errors } = validator.check({ days: '-1; DROP', table: 'users', extra: 1 });
    expect(valid).toBe(false);
    const messages = errors.map(e => e.message);
    expect(messages).toContain('unknown argument "extra": the tool\'s inputSchema does not allow it');
    expect(messages).toContain('argument "days" must be integer, got string "-1; DROP"');
    expect(messages).toContain('argument "table" must be one of "logs", "events", got "users"');
    expect(errors.find(e => e.path === '/days')).toMatchObject({ expected: 'integer', received: '"-1; DROP"' });
  });

  it('treats null as a wrong type and undefined as missing', () => {
    const { errors } = validator.check({ days: null, table: undefined });
    const messages = errors.map(e => e.message);
    expect(messages).toContain('missing required argument "table"');
    expect(messages).toContain('argument "days" must be integer, got null null');
  });

  it('does not let inherited properties satisfy required', () => {
    const inherited = Object.create({ days: 1, table: 'logs' }) as Record<string, unknown>;
    const { valid, errors } = validator.check(inherited);
    expect(valid).toBe(false);
    expect(errors.map(e => e.path)).toEqual(['/days', '/table']);
  });

  it('names nested paths and keyword failures', () => {
    const { errors } = validator.check({ days: 0, table: 'logs', filter: {} });
    const messages = errors.map(e => e.message);
    expect(messages).toContain('argument "days" must be >= 1, got 0');
    expect(messages).toContain('missing required argument "filter.tag"');
  });

  it('rejects NaN and Infinity as numbers', () => {
    expect(validator.check({ days: NaN, table: 'logs' }).valid).toBe(false);
    expect(validator.check({ days: Infinity, table: 'logs' }).valid).toBe(false);
  });

  it('accepts unknown keys when the schema is open', () => {
    const open = compileArgumentValidator({ type: 'object', properties: { q: { type: 'string' } } });
    expect(open.check({ q: 'x', extra: true }).valid).toBe(true);
  });

  it('does not coerce types unless asked to', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } } };
    expect(compileArgumentValidator(schema).check({ n: '5' }).valid).toBe(false);

    const input = { n: '5' };
    const coerced = compileArgumentValidator(schema, { coerce: 'primitives' }).check(input);
    expect(coerced.valid).toBe(true);
    expect(coerced.value).toEqual({ n: 5 });
    expect(input).toEqual({ n: '5' });
  });

  it('runs draft-07 schemas, and draft-04 ones with draft-07 rules', () => {
    const d7 = compileArgumentValidator({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: { type: 'string' } },
      definitions: { unused: { type: 'string' } },
    });
    expect(d7.dialect).toBe('draft-07');
    expect(d7.check({ a: 1 }).valid).toBe(false);

    const d4 = compileArgumentValidator({ $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', required: ['a'] });
    expect(d4.dialect).toBe('draft-07');
    expect(d4.check({}).valid).toBe(false);
  });

  it('refuses schemas it cannot validate faithfully', () => {
    expect(() => compileArgumentValidator({ type: 'objekt' })).toThrow(InputSchemaError);
    expect(() => compileArgumentValidator({ $schema: 'https://example.com/my-dialect', type: 'object' })).toThrow(/unsupported JSON Schema dialect/);
    expect(() => compileArgumentValidator('nope')).toThrow(InputSchemaError);
  });

  it('compiles two schemas that share an $id independently', () => {
    const a = compileArgumentValidator({ $id: 'https://example.com/tool.json', type: 'object', required: ['a'] });
    const b = compileArgumentValidator({ $id: 'https://example.com/tool.json', type: 'object', required: ['b'] });
    expect(a.check({ a: 1 }).valid).toBe(true);
    expect(b.check({ a: 1 }).valid).toBe(false);
  });
});

describe('createSchemaConstraints', () => {
  it('exposes the schema and fails every call when the schema does not compile', () => {
    const bad = createSchemaConstraints({ type: 'objekt' });
    expect(bad.inputSchema).toEqual({ type: 'objekt' });
    const result = bad.validate({});
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/not a valid JSON Schema/);
  });

  it('accepts any object when the tool has no inputSchema', () => {
    const none = createSchemaConstraints(undefined);
    expect(none.validate({ anything: 1 }).valid).toBe(true);
  });
});
