/**
 * JSON Canonicalization Scheme (RFC 8785) — the byte form truth lines hash.
 *
 * Objects serialize with their keys sorted by UTF-16 code units, numbers in
 * ECMAScript's shortest round-trip form (`Number.prototype.toString`, -0 as
 * 0), strings with JSON's minimal escaping, and no whitespace. Values JSON
 * can't represent (NaN, ±Infinity, undefined in an array, bigint,
 * functions, symbols, lone surrogates, non-plain objects) are errors, not
 * silent coercions: a hash must never cover something other than what was
 * written. Zero dependencies; mirrors stenographer's src/truth/jcs.ts.
 */

export class CanonicalizationError extends Error {}

/** RFC 8785 canonical JSON text of `value`. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(`${path}: ${value} is not representable in JSON`);
      // ECMAScript Number::toString is exactly RFC 8785's number format; -0 prints as 0
      return String(value);
    case 'string':
      return serializeString(value, path);
    case 'object':
      return Array.isArray(value) ? serializeArray(value, path) : serializeObject(value as object, path);
    default:
      throw new CanonicalizationError(`${path}: ${typeof value} is not representable in JSON`);
  }
}

function serializeString(value: string, path: string): string {
  // RFC 8785 §3.2.2.2: lone surrogates are rejected, not escaped
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      throw new CanonicalizationError(`${path}: lone surrogate U+${unit.toString(16).toUpperCase()}`);
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalizationError(`${path}: lone surrogate U+${unit.toString(16).toUpperCase()}`);
    }
  }
  // JSON.stringify escapes exactly ", \ and U+0000–U+001F (\b \t \n \f \r, else \u00xx lowercase)
  return JSON.stringify(value);
}

function serializeArray(value: unknown[], path: string): string {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === undefined) throw new CanonicalizationError(`${path}[${i}]: undefined is not representable in JSON`);
    parts.push(serialize(value[i], `${path}[${i}]`));
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(value: object, path: string): string {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(`${path}: only plain objects are canonicalized`);
  }
  const record = value as Record<string, unknown>;
  // The default sort compares UTF-16 code units, which is RFC 8785's key
  // order. Undefined members are absent, as in JSON.stringify.
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${serializeString(k, path)}:${serialize(record[k], `${path}.${k}`)}`).join(',')}}`;
}
