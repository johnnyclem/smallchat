/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * Produces the one canonical UTF-16 string for a JSON value: object keys
 * sorted by UTF-16 code units, no insignificant whitespace, numbers in
 * ECMAScript shortest round-trip form, strings escaped as JSON.stringify
 * does. Used wherever the suite hashes JSON (artifact content hashes,
 * call digests), so two implementations that agree on the value agree on
 * the bytes.
 *
 * Only plain JSON values are accepted: non-finite numbers, bigint,
 * functions, symbols and `undefined` array elements throw. Object
 * properties whose value is `undefined` are omitted, matching
 * JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      // ES Number.prototype.toString is the RFC 8785 number form; -0 → "0".
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, i) => {
      if (item === undefined) {
        throw new TypeError(`canonicalJson: undefined array element at ${path}[${i}]`);
      }
      return serialize(item, `${path}[${i}]`);
    });
    return `[${items.join(',')}]`;
  }

  if (ArrayBuffer.isView(value)) {
    throw new TypeError(`canonicalJson: typed array at ${path} (convert with Array.from first)`);
  }

  const obj = value as Record<string, unknown>;
  // Default sort compares UTF-16 code units, which is exactly RFC 8785 §3.2.3.
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  const members = keys.map(k => `${JSON.stringify(k)}:${serialize(obj[k], `${path}.${k}`)}`);
  return `{${members.join(',')}}`;
}
