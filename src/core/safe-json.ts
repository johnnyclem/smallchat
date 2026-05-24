/**
 * safe-json — JSON.parse wrapper that defends against prototype-pollution
 * payloads in untrusted input (compiled manifests, smallchat.json,
 * inbound JSON-RPC bodies).
 *
 * "Prototype pollution" here means a parsed object carrying a key
 * named __proto__, constructor, or prototype. Plain `JSON.parse` is
 * safe in isolation because the resulting key lives on the object,
 * not on Object.prototype — but any code path that subsequently
 * spreads or merges the parsed value (Object.assign, structuredClone,
 * { ...obj }, recursive copy, etc.) can promote the polluted key into
 * a prototype chain and silently change runtime behaviour everywhere.
 *
 * Two modes are supported:
 *
 *   - 'throw' (default): reject the parse outright. Use this for
 *     compile-time inputs where a noisy failure is appropriate.
 *
 *   - 'strip': delete the forbidden keys from every object in the
 *     parse result and return the cleaned value. Use this for runtime
 *     paths that must keep flowing.
 *
 * Forbidden keys: __proto__, constructor, prototype. Numeric/string
 * indices on arrays are not policed (arrays cannot pollute the
 * Object prototype through normal access).
 */

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

export class PrototypePollutionError extends Error {
  readonly key: string;
  readonly path: string;
  constructor(key: string, path: string) {
    super(`Refusing to parse JSON: forbidden key "${key}" at ${path || '<root>'}`);
    this.name = 'PrototypePollutionError';
    this.key = key;
    this.path = path;
  }
}

export interface SafeJsonParseOptions {
  /**
   * Behaviour when a forbidden key is encountered. Defaults to 'throw'.
   */
  onPollution?: 'throw' | 'strip';
  /**
   * Optional reviver, forwarded to JSON.parse for value transformation.
   */
  reviver?: (key: string, value: unknown) => unknown;
}

export function safeJsonParse(text: string, options: SafeJsonParseOptions = {}): unknown {
  const mode = options.onPollution ?? 'throw';
  const parsed = JSON.parse(text, options.reviver);
  return scrub(parsed, mode, '');
}

function scrub(value: unknown, mode: 'throw' | 'strip', path: string): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = scrub(value[i], mode, `${path}[${i}]`);
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  for (const key of FORBIDDEN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (mode === 'throw') {
      throw new PrototypePollutionError(key, path);
    }
    delete obj[key];
  }

  for (const key of Object.keys(obj)) {
    obj[key] = scrub(obj[key], mode, path ? `${path}.${key}` : key);
  }
  return obj;
}
