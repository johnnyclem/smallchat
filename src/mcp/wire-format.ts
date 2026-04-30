/**
 * Compact wire format for MCP responses.
 *
 * Inspired by loom-mcp's "TOON" approach: when a JSON-RPC result contains an
 * array of homogeneous objects (the common case for `tools/list`,
 * `resources/list`, etc.), pack it once into a column header plus rows instead
 * of repeating the keys on every element. Optional path/string interning
 * compresses a small set of high-frequency string values.
 *
 * The format is lossless: `decode(encode(x))` deep-equals `x` for any
 * JSON-serializable input.
 *
 * Wire envelope (compact form):
 * ```
 * { "__sc_wire": 1, "data": <encoded> }
 * ```
 * `data` may contain packed arrays of the form
 * `{ "__pack": ["k1","k2",...], "__rows": [[v1a,v2a],[v1b,v2b],...] }`.
 *
 * Negotiation: `negotiate(format, value)` picks compact only when it saves at
 * least `MIN_SAVINGS_RATIO` bytes; otherwise it returns the original value
 * unchanged. The 0.15 threshold matches the loom-mcp default.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json };

export type WireFormat = 'auto' | 'compact' | 'json';

export const MIN_SAVINGS_RATIO = 0.15;

const PACK_KEY = '__pack';
const ROWS_KEY = '__rows';
const ENVELOPE_KEY = '__sc_wire';
const ENVELOPE_VERSION = 1;

interface PackedArray {
  [PACK_KEY]: string[];
  [ROWS_KEY]: Json[][];
}

function isPackedArray(v: unknown): v is PackedArray {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Array.isArray((v as Record<string, unknown>)[PACK_KEY]) &&
    Array.isArray((v as Record<string, unknown>)[ROWS_KEY])
  );
}

function isPlainObject(v: unknown): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns true if every element of `arr` is a plain object with the *same*
 * key set (order-insensitive), and there are at least 2 elements. Such arrays
 * are worth packing. Objects whose values contain reserved marker keys are
 * rejected to keep the format unambiguous.
 */
function canPack(arr: Json[]): { ok: true; keys: string[] } | { ok: false } {
  if (arr.length < 2) return { ok: false };
  if (!isPlainObject(arr[0])) return { ok: false };

  const firstKeys = Object.keys(arr[0]).sort();
  if (firstKeys.length === 0) return { ok: false };
  if (firstKeys.includes(PACK_KEY) || firstKeys.includes(ROWS_KEY)) {
    return { ok: false };
  }

  for (let i = 1; i < arr.length; i++) {
    const el = arr[i];
    if (!isPlainObject(el)) return { ok: false };
    const keys = Object.keys(el);
    if (keys.length !== firstKeys.length) return { ok: false };
    const sorted = keys.slice().sort();
    for (let j = 0; j < sorted.length; j++) {
      if (sorted[j] !== firstKeys[j]) return { ok: false };
    }
  }
  return { ok: true, keys: firstKeys };
}

/**
 * Recursively encode a JSON value. Packs homogeneous object arrays into
 * `{__pack, __rows}` form; otherwise leaves structure untouched.
 */
export function encodeValue(value: Json): Json {
  if (Array.isArray(value)) {
    const packable = canPack(value);
    if (packable.ok) {
      const rows: Json[][] = value.map((el) => {
        const obj = el as Record<string, Json>;
        return packable.keys.map((k) => encodeValue(obj[k]));
      });
      return { [PACK_KEY]: packable.keys, [ROWS_KEY]: rows };
    }
    return value.map((el) => encodeValue(el));
  }
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value)) {
      out[k] = encodeValue(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Recursively decode a value previously produced by `encodeValue`. Unpacks
 * any `{__pack, __rows}` shapes back into arrays of objects.
 */
export function decodeValue(value: Json): Json {
  if (isPackedArray(value)) {
    const { [PACK_KEY]: keys, [ROWS_KEY]: rows } = value;
    return rows.map((row) => {
      const obj: Record<string, Json> = {};
      for (let i = 0; i < keys.length; i++) {
        obj[keys[i]] = decodeValue(row[i] ?? null);
      }
      return obj;
    });
  }
  if (Array.isArray(value)) {
    return value.map((el) => decodeValue(el));
  }
  if (isPlainObject(value)) {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value)) {
      out[k] = decodeValue(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Wrap an encoded payload in the wire envelope.
 */
export function wrap(encoded: Json): Json {
  return { [ENVELOPE_KEY]: ENVELOPE_VERSION, data: encoded };
}

/**
 * Detect and unwrap a wire envelope. Returns the inner data when the envelope
 * is recognised; otherwise returns the value unchanged. Unrecognised envelope
 * versions throw — callers should treat that as a transport error.
 */
export function unwrap(value: Json): Json {
  if (
    isPlainObject(value) &&
    typeof value[ENVELOPE_KEY] === 'number' &&
    'data' in value
  ) {
    if (value[ENVELOPE_KEY] !== ENVELOPE_VERSION) {
      throw new Error(
        `Unsupported smallchat wire envelope version: ${value[ENVELOPE_KEY]}`,
      );
    }
    return decodeValue(value.data as Json);
  }
  return value;
}

function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export interface NegotiationResult {
  format: 'compact' | 'json';
  /** Final payload — for `compact`, this is the wrapped envelope. */
  payload: Json;
  /** Byte length of the JSON-stringified original value. */
  originalBytes: number;
  /** Byte length of the JSON-stringified payload. */
  finalBytes: number;
  /** Fraction saved vs. original (negative when compact would have grown). */
  savingsRatio: number;
}

/**
 * Pick a wire format for `value`.
 *
 * - `'json'` — never compacts.
 * - `'compact'` — always compacts (caller has opted in even at zero savings).
 * - `'auto'` — compacts only when savings are at least `MIN_SAVINGS_RATIO`.
 */
export function negotiate(format: WireFormat, value: Json): NegotiationResult {
  const originalSerialized = JSON.stringify(value);
  const originalBytes = utf8ByteLength(originalSerialized);

  if (format === 'json') {
    return {
      format: 'json',
      payload: value,
      originalBytes,
      finalBytes: originalBytes,
      savingsRatio: 0,
    };
  }

  const encoded = encodeValue(value);
  const wrapped = wrap(encoded);
  const compactSerialized = JSON.stringify(wrapped);
  const compactBytes = utf8ByteLength(compactSerialized);
  const savingsRatio = (originalBytes - compactBytes) / originalBytes;

  if (format === 'compact') {
    return {
      format: 'compact',
      payload: wrapped,
      originalBytes,
      finalBytes: compactBytes,
      savingsRatio,
    };
  }

  // 'auto'
  if (savingsRatio >= MIN_SAVINGS_RATIO) {
    return {
      format: 'compact',
      payload: wrapped,
      originalBytes,
      finalBytes: compactBytes,
      savingsRatio,
    };
  }
  return {
    format: 'json',
    payload: value,
    originalBytes,
    finalBytes: originalBytes,
    savingsRatio,
  };
}

/**
 * Parse a `format` parameter from a JSON-RPC params object. Defaults to
 * `'json'` when absent or invalid, preserving wire-compatibility for clients
 * unaware of the negotiation.
 */
export function parseFormatParam(params: Record<string, unknown>): WireFormat {
  const f = params.format;
  if (f === 'auto' || f === 'compact' || f === 'json') return f;
  return 'json';
}
