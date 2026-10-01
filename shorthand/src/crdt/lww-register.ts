/**
 * LWW-Register (Last Writer Wins Register) — a CRDT where concurrent
 * writes are resolved by Lamport timestamp ordering.
 *
 * Used for L4 (core invariants) where the most recent update should win.
 * Each key-value pair carries a Lamport timestamp from the register's own
 * clock (callers never supply one); on merge, the entry with the higher
 * timestamp takes precedence, equal counters are ordered by agentId, and
 * two entries with the same (counter, agentId) — two writers sharing a
 * replica id — are ordered by a tombstone-first, then canonical-JSON
 * comparison, so every replica picks the same winner in any merge order.
 *
 * Each entry also records the writer's vector clock, so a reader can tell
 * a causal overwrite from a concurrent write (ConflictDetector does).
 *
 * Reference: Shapiro et al., "A comprehensive study of CRDTs" (2011)
 */

import type { AgentId, LamportTimestamp, VectorClock, CRDT } from './types.js';
import { LamportClock, compareLamport, mergeVectorClocks } from './clock.js';
import {
  CRDT_SCHEMA_VERSION,
  canonicalJson,
  checkClockField,
  checkLamport,
  checkState,
  checkVectorClock,
  compareStrings,
  fail,
  isRecord,
} from './wire.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single timestamped entry in the register map. */
export interface LWWEntry<V> {
  /** The value. Absent on a tombstone. */
  value?: V;
  timestamp: LamportTimestamp;
  /** Set on a tombstone written by `delete`. */
  deleted?: true;
  /**
   * Vector clock of the writing replica when it wrote this entry (its
   * causal past, this write included). Absent on pre-1.0 entries.
   */
  vc?: VectorClock;
}

/** Serialized form of the full LWW register map. */
export interface LWWRegisterState<V> {
  /** Wire-format version (absent on pre-1.0 states). */
  schemaVersion?: typeof CRDT_SCHEMA_VERSION;
  /** Lamport counter of the serializing replica, restored by `from`. */
  clock?: number;
  /** Vector clock of everything the serializing replica has observed. */
  vc?: VectorClock;
  entries: Record<string, LWWEntry<V>>;
}

const KIND = 'LWW-Register';

/** Whether an entry is a tombstone (pre-1.0 tombstones have no value). */
export function isLWWTombstone<V>(entry: LWWEntry<V>): boolean {
  return entry.deleted === true || entry.value === undefined;
}

/**
 * Total order over entries for one key: Lamport timestamp, then a tombstone
 * over a value, then the canonical JSON of the whole entry. Positive when
 * `a` wins.
 */
export function compareLWWEntries<V>(a: LWWEntry<V>, b: LWWEntry<V>): number {
  const byTime = compareLamport(a.timestamp, b.timestamp);
  if (byTime !== 0) return byTime;
  const aDeleted = isLWWTombstone(a);
  if (aDeleted !== isLWWTombstone(b)) return aDeleted ? 1 : -1;
  return compareStrings(canonicalJson(a), canonicalJson(b));
}

function copyEntry<V>(entry: LWWEntry<V>): LWWEntry<V> {
  const copy: LWWEntry<V> = isLWWTombstone(entry)
    ? { timestamp: { ...entry.timestamp }, deleted: true }
    : { value: entry.value, timestamp: { ...entry.timestamp } };
  if (entry.vc) copy.vc = { ...entry.vc };
  return copy;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LWWRegister<V> implements CRDT<Map<string, V>, LWWRegisterState<V>> {
  private entries: Map<string, LWWEntry<V>> = new Map();
  private clock: LamportClock;
  /** Join of every vector clock this replica has observed. */
  private vc: VectorClock = {};

  constructor(agentId: AgentId) {
    this.clock = new LamportClock(agentId);
  }

  /** Set a key to a value, stamping it with a new Lamport timestamp. */
  set(key: string, value: V): LamportTimestamp {
    if (value === undefined) {
      throw new TypeError('LWWRegister.set: value must not be undefined (use delete)');
    }
    return this.write(key, { value });
  }

  /** Get the current value for a key, or undefined. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    return entry && !isLWWTombstone(entry) ? entry.value : undefined;
  }

  /** Get a copy of the full entry (value, timestamp, vector clock) for a key. */
  getEntry(key: string): LWWEntry<V> | undefined {
    const entry = this.entries.get(key);
    return entry ? copyEntry(entry) : undefined;
  }

  /** Whether a key holds a live (non-deleted) value. */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && !isLWWTombstone(entry);
  }

  /** Delete a key by writing a tombstone. */
  delete(key: string): void {
    this.write(key, { deleted: true });
  }

  /** Return all current key-value pairs (excluding tombstones), by key. */
  value(): Map<string, V> {
    const result = new Map<string, V>();
    for (const key of this.keys()) {
      const entry = this.entries.get(key)!;
      if (!isLWWTombstone(entry)) result.set(key, entry.value as V);
    }
    return result;
  }

  /** All keys including tombstoned ones, sorted. */
  keys(): string[] {
    return [...this.entries.keys()].sort(compareStrings);
  }

  /** Serialize to a JSON-safe representation (keys sorted). */
  serialize(): LWWRegisterState<V> {
    return {
      schemaVersion: CRDT_SCHEMA_VERSION,
      clock: this.clock.current(),
      vc: { ...this.vc },
      entries: Object.fromEntries(this.keys().map((key) => [key, copyEntry(this.entries.get(key)!)])),
    };
  }

  /**
   * Merge with a remote replica. For each key, the entry that is greater in
   * the total order (see `compareLWWEntries`) wins. The clock advances past
   * every timestamp observed. Throws TypeError, before changing anything,
   * on a malformed state. Returns true if any entry changed.
   */
  merge(remote: LWWRegisterState<V>): boolean {
    const incoming = parseLWWState<V>(remote);
    let changed = false;
    const observed: VectorClock[] = [this.vc];

    for (const [key, entry] of incoming.entries) {
      this.clock.observe(entry.timestamp.counter);
      observed.push({ [entry.timestamp.agentId]: entry.timestamp.counter });
      if (entry.vc) observed.push(entry.vc);
      const local = this.entries.get(key);
      if (!local || compareLWWEntries(entry, local) > 0) {
        this.entries.set(key, entry);
        changed = true;
      }
    }
    if (incoming.clock !== undefined) this.clock.observe(incoming.clock);
    if (incoming.vc) observed.push(incoming.vc);
    this.vc = observed.reduce(mergeVectorClocks, {});

    return changed;
  }

  /** Create from a serialized state (restores the clock). */
  static from<V>(agentId: AgentId, state: LWWRegisterState<V>): LWWRegister<V> {
    const reg = new LWWRegister<V>(agentId);
    reg.merge(state);
    return reg;
  }

  private write(key: string, body: { value: V } | { deleted: true }): LamportTimestamp {
    const ts = this.clock.tick();
    this.vc = { ...this.vc, [ts.agentId]: ts.counter };
    this.entries.set(key, { ...body, timestamp: ts, vc: { ...this.vc } });
    return { ...ts };
  }
}

/** Validate a peer's LWW state and return normalized copies of its parts. */
function parseLWWState<V>(state: unknown): {
  clock?: number;
  vc?: VectorClock;
  entries: Array<[string, LWWEntry<V>]>;
} {
  const s = checkState(KIND, state);
  const clock = checkClockField(KIND, s);
  const vc = s.vc === undefined ? undefined : checkVectorClock(KIND, 'vc', s.vc);
  if (!isRecord(s.entries)) fail(KIND, 'entries', 'must be an object');
  const entries: Array<[string, LWWEntry<V>]> = [];
  for (const [key, raw] of Object.entries(s.entries)) {
    const path = `entries.${key}`;
    if (!isRecord(raw)) fail(KIND, path, 'must be an object');
    if (raw.deleted !== undefined && raw.deleted !== true) fail(KIND, `${path}.deleted`, 'must be true or absent');
    const entry: LWWEntry<V> =
      raw.deleted === true || raw.value === undefined
        ? { timestamp: checkLamport(KIND, `${path}.timestamp`, raw.timestamp), deleted: true }
        : { value: raw.value as V, timestamp: checkLamport(KIND, `${path}.timestamp`, raw.timestamp) };
    if (raw.vc !== undefined) entry.vc = checkVectorClock(KIND, `${path}.vc`, raw.vc);
    entries.push([key, entry]);
  }
  return { clock, vc, entries };
}
