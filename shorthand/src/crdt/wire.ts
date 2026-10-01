/**
 * Wire-format helpers shared by the CRDTs: the schema version, canonical
 * JSON for deterministic tie-breaks, and the structural checks every
 * `merge` runs on a peer's state before it touches local state.
 *
 * The format is documented in docs/crdt-format.md.
 */

import type { LamportTimestamp, VectorClock } from './types.js';

/**
 * Version of the serialized CRDT states (`schemaVersion` on every state).
 * States without the field are pre-1.0 and still load; a newer version is
 * rejected instead of being merged half-understood.
 */
export const CRDT_SCHEMA_VERSION = 1;

/**
 * Canonical JSON: object keys sorted by UTF-16 code units, no whitespace,
 * `undefined` members dropped (as JSON.stringify does). Two values that are
 * equal as JSON have the same canonical form whatever their key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const member = (value as Record<string, unknown>)[key];
    if (member === undefined || typeof member === 'function') continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Order two strings by UTF-16 code units (locale-independent). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Structural checks (throw TypeError naming the offending path)
// ---------------------------------------------------------------------------

export function fail(kind: string, path: string, problem: string): never {
  throw new TypeError(`Invalid ${kind} state: ${path} ${problem}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkState(kind: string, state: unknown): Record<string, unknown> {
  if (!isRecord(state)) fail(kind, 'state', 'must be an object');
  const version = state.schemaVersion;
  if (version !== undefined && version !== CRDT_SCHEMA_VERSION) {
    if (typeof version === 'number' && Number.isInteger(version) && version > CRDT_SCHEMA_VERSION) {
      fail(kind, 'schemaVersion', `${version} is newer than this library understands (${CRDT_SCHEMA_VERSION})`);
    }
    fail(kind, 'schemaVersion', `must be ${CRDT_SCHEMA_VERSION} or absent`);
  }
  return state;
}

export function checkCounter(kind: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(kind, path, 'must be a non-negative safe integer');
  }
  return value;
}

export function checkString(kind: string, path: string, value: unknown): string {
  if (typeof value !== 'string') fail(kind, path, 'must be a string');
  return value;
}

export function checkLamport(kind: string, path: string, value: unknown): LamportTimestamp {
  if (!isRecord(value)) fail(kind, path, 'must be a Lamport timestamp');
  return {
    counter: checkCounter(kind, `${path}.counter`, value.counter),
    agentId: checkString(kind, `${path}.agentId`, value.agentId),
  };
}

export function checkVectorClock(kind: string, path: string, value: unknown): VectorClock {
  if (!isRecord(value)) fail(kind, path, 'must be a vector clock object');
  const clock: VectorClock = {};
  for (const [agent, counter] of Object.entries(value)) {
    Object.defineProperty(clock, agent, {
      value: checkCounter(kind, `${path}.${agent}`, counter),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return clock;
}

export function checkStringArray(kind: string, path: string, value: unknown): string[] {
  if (!Array.isArray(value)) fail(kind, path, 'must be an array of strings');
  value.forEach((item, i) => checkString(kind, `${path}[${i}]`, item));
  return value as string[];
}

/** Optional `clock` field: the serializing replica's Lamport counter. */
export function checkClockField(kind: string, state: Record<string, unknown>): number | undefined {
  return state.clock === undefined ? undefined : checkCounter(kind, 'clock', state.clock);
}
