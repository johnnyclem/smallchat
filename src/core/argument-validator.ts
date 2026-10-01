/**
 * Argument validation — tool call arguments are checked against the tool's
 * `inputSchema` (JSON Schema) before anything executes.
 *
 * Dialects: a schema without `$schema` is JSON Schema 2020-12 (the MCP
 * default); `$schema` may name 2020-12, 2019-09 or draft-07. draft-04 and
 * draft-06 schemas are validated with draft-07 rules (their `$schema` is
 * dropped), so a draft-04 boolean `exclusiveMaximum` is reported as an
 * invalid schema. Any other `$schema` is refused.
 *
 * Semantics are exactly the schema's: `additionalProperties: false` (a
 * closed schema) rejects unknown arguments, an open schema accepts them.
 * `required` counts only own properties whose value is not `undefined`.
 * Types are not coerced unless the caller opts in. `format` is not
 * asserted (it is an annotation in 2020-12).
 */

import Ajv2020Import from 'ajv/dist/2020.js';
import Ajv2019Import from 'ajv/dist/2019.js';
import AjvImport from 'ajv';
import type { ErrorObject, Options as AjvOptions, ValidateFunction } from 'ajv';
import type { ArgumentConstraints, ArgumentSpec, ValidationError, ValidationResult } from './types.js';

/** How argument types may be adjusted before validation. */
export type ArgumentCoercion = 'none' | 'primitives';

export interface ArgumentValidationOptions {
  /**
   * 'none' (default): arguments must already have the schema's types.
   * 'primitives': scalars are coerced to the schema type first ("5" → 5,
   * "true" → true, 5 → "5"); the coerced copy is what executes.
   */
  coerce?: ArgumentCoercion;
}

/** JSON Schema dialects the validator runs. */
export type SchemaDialect = '2020-12' | '2019-09' | 'draft-07';

/** The result of checking one set of arguments. */
export interface ArgumentCheck extends ValidationResult {
  /** The arguments to execute with: the input itself, or its coerced copy. */
  value: Record<string, unknown>;
}

export interface ArgumentValidator {
  readonly dialect: SchemaDialect;
  check(args: unknown): ArgumentCheck;
}

/** Thrown when a tool's inputSchema cannot be compiled into a validator. */
export class InputSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputSchemaError';
  }
}

/** Errors reported per call are capped; the rest are summarized. */
const MAX_ERRORS = 20;

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

type AjvInstance = { compile(schema: object): ValidateFunction };
type AjvClass = new (options: AjvOptions) => AjvInstance;

const AJV_CLASSES: Record<SchemaDialect, AjvClass> = {
  '2020-12': Ajv2020Import.default as unknown as AjvClass,
  '2019-09': Ajv2019Import.default as unknown as AjvClass,
  'draft-07': AjvImport.default as unknown as AjvClass,
};

const sharedInstances = new Map<string, AjvInstance>();
const compiled = new WeakMap<object, Map<ArgumentCoercion, ArgumentValidator>>();

function ajvFor(dialect: SchemaDialect, coerce: ArgumentCoercion, fresh: boolean): AjvInstance {
  const options: AjvOptions = {
    // strict: false tolerates unknown keywords in upstream schemas, but it
    // also relaxes number checks, so NaN/Infinity are re-forbidden here.
    strict: false,
    strictNumbers: true,
    allErrors: true,
    ownProperties: true,
    validateFormats: false,
    useDefaults: false,
    coerceTypes: coerce === 'primitives',
    logger: false,
  };
  if (fresh) return new AJV_CLASSES[dialect](options);
  const key = `${dialect}:${coerce}`;
  let instance = sharedInstances.get(key);
  if (!instance) {
    instance = new AJV_CLASSES[dialect](options);
    sharedInstances.set(key, instance);
  }
  return instance;
}

function dialectOf(schema: Record<string, unknown>): { dialect: SchemaDialect; stripSchema: boolean } {
  const uri = schema.$schema;
  if (uri === undefined) return { dialect: '2020-12', stripSchema: false };
  if (typeof uri !== 'string') throw new InputSchemaError('inputSchema.$schema must be a string');
  if (uri.includes('/2020-12/')) return { dialect: '2020-12', stripSchema: false };
  if (uri.includes('/2019-09/')) return { dialect: '2019-09', stripSchema: false };
  if (/\/draft-07\/schema/.test(uri)) return { dialect: 'draft-07', stripSchema: false };
  if (/\/draft-0[46]\/schema/.test(uri)) return { dialect: 'draft-07', stripSchema: true };
  throw new InputSchemaError(`inputSchema uses an unsupported JSON Schema dialect: ${uri}`);
}

/**
 * Compile `inputSchema` into a validator. Compiled validators are cached
 * per schema object, so compiling the same schema again is free. Throws
 * InputSchemaError when the schema is not a valid JSON Schema.
 */
export function compileArgumentValidator(
  inputSchema: unknown,
  options: ArgumentValidationOptions = {},
): ArgumentValidator {
  const coerce = options.coerce ?? 'none';
  if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new InputSchemaError('inputSchema must be a JSON Schema object');
  }

  const byCoercion = compiled.get(inputSchema) ?? new Map<ArgumentCoercion, ArgumentValidator>();
  const cached = byCoercion.get(coerce);
  if (cached) return cached;

  const schema = inputSchema as Record<string, unknown>;
  const { dialect, stripSchema } = dialectOf(schema);
  const source = stripSchema ? withoutKey(schema, '$schema') : schema;

  let validate: ValidateFunction;
  try {
    // A schema with its own $id gets a private instance: ids are global per instance.
    validate = ajvFor(dialect, coerce, typeof schema.$id === 'string').compile(source);
  } catch (e) {
    throw new InputSchemaError(`inputSchema is not a valid JSON Schema (${dialect}): ${(e as Error).message}`);
  }

  const validator: ArgumentValidator = {
    dialect,
    check(args: unknown): ArgumentCheck {
      // Coercion mutates in place, so it works on a copy the caller then executes.
      const value = coerce === 'none' ? args : structuredClone(args);
      if (validate(value)) {
        return { valid: true, errors: [], value: value as Record<string, unknown> };
      }
      return {
        valid: false,
        errors: describeErrors(validate.errors ?? [], value),
        value: value as Record<string, unknown>,
      };
    },
  };
  byCoercion.set(coerce, validator);
  compiled.set(inputSchema, byCoercion);
  return validator;
}

/**
 * ArgumentConstraints backed by a JSON Schema. The schema is compiled on
 * first use; a schema that does not compile makes every call to this tool
 * fail validation with the compile error, rather than running unchecked.
 * A tool without an inputSchema accepts any JSON object.
 */
export function createSchemaConstraints(
  inputSchema: Record<string, unknown> | undefined,
  specs: ArgumentSpec[] = [],
  options: ArgumentValidationOptions = {},
): ArgumentConstraints {
  const schema = inputSchema ?? { type: 'object' };
  let validator: ArgumentValidator | InputSchemaError | undefined;

  return {
    required: specs.filter(a => a.required),
    optional: specs.filter(a => !a.required),
    inputSchema: schema,
    validate(args: Record<string, unknown>): ValidationResult {
      if (validator === undefined) {
        try {
          validator = compileArgumentValidator(schema, options);
        } catch (e) {
          validator = e instanceof InputSchemaError ? e : new InputSchemaError(String(e));
        }
      }
      if (validator instanceof InputSchemaError) {
        return { valid: false, errors: [{ path: '', message: validator.message }] };
      }
      const { valid, errors } = validator.check(args);
      return { valid, errors };
    },
  };
}

// ---------------------------------------------------------------------------
// Model-readable errors
// ---------------------------------------------------------------------------

function describeErrors(errors: ErrorObject[], root: unknown): ValidationError[] {
  const described = errors.slice(0, MAX_ERRORS).map(e => describeError(e, root));
  if (errors.length > MAX_ERRORS) {
    described.push({ path: '', message: `${errors.length - MAX_ERRORS} more validation error(s) not shown` });
  }
  return described;
}

function describeError(e: ErrorObject, root: unknown): ValidationError {
  const at = e.instancePath;
  const params = e.params as Record<string, unknown>;

  switch (e.keyword) {
    case 'required': {
      const path = `${at}/${escapePointer(String(params.missingProperty))}`;
      return { path, message: `missing required argument ${quoted(path)}`, expected: 'a value' };
    }
    case 'additionalProperties':
    case 'unevaluatedProperties': {
      const name = String(params.additionalProperty ?? params.unevaluatedProperty);
      const path = `${at}/${escapePointer(name)}`;
      return {
        path,
        message: `unknown argument ${quoted(path)}: the tool's inputSchema does not allow it`,
        received: preview(valueAt(root, path)),
      };
    }
    case 'type': {
      const value = valueAt(root, at);
      return {
        path: at,
        message: `${label(at)} must be ${String(params.type)}, got ${kindOf(value)} ${preview(value)}`,
        expected: String(params.type),
        received: preview(value),
      };
    }
    case 'enum': {
      const value = valueAt(root, at);
      const allowed = (params.allowedValues as unknown[]).map(v => JSON.stringify(v)).join(', ');
      return {
        path: at,
        message: `${label(at)} must be one of ${allowed}, got ${preview(value)}`,
        expected: `one of ${allowed}`,
        received: preview(value),
      };
    }
    case 'const': {
      const value = valueAt(root, at);
      return {
        path: at,
        message: `${label(at)} must be ${JSON.stringify(params.allowedValue)}, got ${preview(value)}`,
        expected: JSON.stringify(params.allowedValue),
        received: preview(value),
      };
    }
    default: {
      const value = valueAt(root, at);
      return {
        path: at,
        message: `${label(at)} ${e.message ?? `fails ${e.keyword}`}, got ${preview(value)}`,
        received: preview(value),
      };
    }
  }
}

/** "arguments" for the root, otherwise `argument "filter[0].name"`. */
function label(pointer: string): string {
  return pointer === '' ? 'arguments' : `argument ${quoted(pointer)}`;
}

/** A JSON pointer as a quoted, readable path: "/filter/0/name" → "filter[0].name". */
function quoted(pointer: string): string {
  const segments = pointer.split('/').slice(1).map(unescapePointer);
  const display = segments
    .map((s, i) => (/^\d+$/.test(s) ? `[${s}]` : i === 0 ? s : `.${s}`))
    .join('');
  return `"${display}"`;
}

function valueAt(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    if (current === null || typeof current !== 'object') return undefined;
    const key = unescapePointer(raw);
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function preview(value: unknown): string {
  if (value === undefined) return 'undefined';
  let text: string;
  try {
    text = typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function withoutKey(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}
