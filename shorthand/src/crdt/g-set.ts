/**
 * G-Set (Grow-Only Set) with merge function — elements can be added but
 * never removed. Merge is union, which is commutative, associative, and
 * idempotent as long as the merge function picks the greater of two
 * entries under a total order (the default does).
 *
 * Used for L2 (topic-clustered summaries). Summaries from different agents
 * are both retained. A domain-aware merge function handles deduplication
 * of entries that share a `dedupeKey`.
 *
 * Every entry has an explicit id (its `dedupeKey`): either the caller's
 * key (e.g. a topic) or one the set issues, `__id:<replicaId>:<counter>`,
 * from a counter that is serialized and advanced by merges, so a restored
 * replica never reissues an id. Values are never used as keys.
 */

import type { AgentId, CRDT } from './types.js';
import {
  CRDT_SCHEMA_VERSION,
  canonicalJson,
  checkClockField,
  checkString,
  checkState,
  compareStrings,
  fail,
  isRecord,
} from './wire.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata attached to each summary entry for conflict resolution. */
export interface GSetEntry<V> {
  value: V;
  /** Agent that produced this entry. */
  sourceAgent: string;
  /** Whether the producing agent was a direct participant. */
  isDirectParticipant: boolean;
  /**
   * The entry's id and deduplication key (e.g., a topic). Optional on
   * `add`, where the set issues one; always present in serialized state.
   * Keys starting with `__` are reserved for issued ids.
   */
  dedupeKey?: string;
}

/** Serialized G-Set state. */
export interface GSetState<V> {
  /** Wire-format version (absent on pre-1.0 states). */
  schemaVersion?: typeof CRDT_SCHEMA_VERSION;
  /** Counter of the last id this replica issued or saw. */
  clock?: number;
  entries: GSetEntry<V>[];
}

/** Options for a G-Set replica. */
export interface GSetOptions<V> {
  /**
   * Replica id used in issued ids (`__id:<replicaId>:<counter>`). Defaults
   * to the entry's `sourceAgent`; set it when one replica adds entries on
   * behalf of several agents.
   */
  replicaId?: AgentId;
  /** Resolves two entries with the same key. Default: `defaultMergeFn`. */
  mergeFn?: GSetMergeFn<V>;
}

const KIND = 'G-Set';
const ISSUED_PREFIX = '__id:';

// ---------------------------------------------------------------------------
// Merge function type
// ---------------------------------------------------------------------------

/**
 * Domain-aware merge function for resolving duplicate entries.
 * Given two entries with the same dedupeKey, returns the winner.
 *
 * For replicas to converge it must return the greater of its arguments
 * under some total order over entries (so it is commutative, associative
 * and idempotent), never a new object.
 */
export type GSetMergeFn<V> = (a: GSetEntry<V>, b: GSetEntry<V>) => GSetEntry<V>;

function contentLength<V>(value: V): number {
  return typeof value === 'string' ? value.length : canonicalJson(value).length;
}

/**
 * Default merge: prefer a direct participant, then the longer summary, then
 * the entry whose canonical JSON sorts last — a total order, so every
 * replica keeps the same entry whatever the merge order.
 */
export function defaultMergeFn<V>(a: GSetEntry<V>, b: GSetEntry<V>): GSetEntry<V> {
  // "I was there" outranks "I heard about it"
  if (a.isDirectParticipant !== b.isDirectParticipant) return a.isDirectParticipant ? a : b;
  // Both direct or both indirect — prefer longer (more detailed) summary
  const aLen = contentLength(a.value);
  const bLen = contentLength(b.value);
  if (aLen !== bLen) return aLen > bLen ? a : b;
  return compareStrings(canonicalJson(a), canonicalJson(b)) >= 0 ? a : b;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GSet<V> implements CRDT<GSetEntry<V>[], GSetState<V>> {
  private entries: Map<string, GSetEntry<V>> = new Map();
  private mergeFn: GSetMergeFn<V>;
  private readonly replicaId?: AgentId;
  /** Counter for issued ids. */
  private counter = 0;

  constructor(options: GSetOptions<V> | GSetMergeFn<V> = {}) {
    const opts = typeof options === 'function' ? { mergeFn: options } : options;
    this.mergeFn = opts.mergeFn ?? defaultMergeFn;
    this.replicaId = opts.replicaId;
  }

  /**
   * Add an entry to the set and return its key: the entry's `dedupeKey`,
   * or a newly issued `__id:<replicaId>:<counter>`.
   */
  add(entry: GSetEntry<V>): string {
    if (entry.value === undefined) throw new TypeError('GSet.add: value must not be undefined');
    const key = entry.dedupeKey ?? `${ISSUED_PREFIX}${this.replicaId ?? entry.sourceAgent}:${++this.counter}`;
    const normalized = { ...entry, dedupeKey: key };

    const existing = this.entries.get(key);
    // Deduplicate using merge function
    this.entries.set(key, existing ? this.mergeFn(existing, normalized) : normalized);
    return key;
  }

  /** Get all entries, ordered by key. */
  value(): GSetEntry<V>[] {
    return this.sortedKeys().map((key) => this.entries.get(key)!);
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Look up an entry by its dedupeKey. */
  getByKey(dedupeKey: string): GSetEntry<V> | undefined {
    return this.entries.get(dedupeKey);
  }

  /** Serialize to JSON-safe form (entries ordered by key). */
  serialize(): GSetState<V> {
    return {
      schemaVersion: CRDT_SCHEMA_VERSION,
      clock: this.counter,
      entries: this.value().map((entry) => ({ ...entry })),
    };
  }

  /**
   * Merge with a remote G-Set. New entries are added; entries with matching
   * dedupeKeys are resolved using the merge function. Throws TypeError,
   * before changing anything, on a malformed state.
   * Returns true if any local state changed.
   */
  merge(remote: GSetState<V>): boolean {
    const incoming = parseGSetState<V>(remote);
    let changed = false;

    if (incoming.clock !== undefined) this.observe(incoming.clock);
    for (const remoteEntry of incoming.entries) {
      const key = remoteEntry.dedupeKey!;
      this.observeKey(key);
      const existing = this.entries.get(key);

      if (!existing) {
        this.entries.set(key, remoteEntry);
        changed = true;
      } else {
        const winner = this.mergeFn(existing, remoteEntry);
        if (winner !== existing) {
          this.entries.set(key, { ...winner, dedupeKey: key });
          changed = true;
        }
      }
    }

    return changed;
  }

  /** Create from serialized state (restores the id counter). */
  static from<V>(state: GSetState<V>, options?: GSetOptions<V> | GSetMergeFn<V>): GSet<V> {
    const set = new GSet<V>(options);
    set.merge(state);
    return set;
  }

  private observe(counter: number): void {
    if (counter > this.counter) this.counter = counter;
  }

  /** Advance the id counter past an issued id (`__id:<replica>:<n>`). */
  private observeKey(key: string): void {
    if (!key.startsWith(ISSUED_PREFIX)) return;
    const n = Number(key.slice(key.lastIndexOf(':') + 1));
    if (Number.isSafeInteger(n) && n > 0) this.observe(n);
  }

  private sortedKeys(): string[] {
    return [...this.entries.keys()].sort(compareStrings);
  }
}

/** Validate a peer's G-Set state; every entry must carry its key. */
function parseGSetState<V>(state: unknown): { clock?: number; entries: GSetEntry<V>[] } {
  const s = checkState(KIND, state);
  const clock = checkClockField(KIND, s);
  if (!Array.isArray(s.entries)) fail(KIND, 'entries', 'must be an array');
  const entries = s.entries.map((raw, i): GSetEntry<V> => {
    const path = `entries[${i}]`;
    if (!isRecord(raw)) fail(KIND, path, 'must be an object');
    if (raw.value === undefined) fail(KIND, `${path}.value`, 'is missing');
    if (typeof raw.isDirectParticipant !== 'boolean') fail(KIND, `${path}.isDirectParticipant`, 'must be a boolean');
    return {
      value: raw.value as V,
      sourceAgent: checkString(KIND, `${path}.sourceAgent`, raw.sourceAgent),
      isDirectParticipant: raw.isDirectParticipant,
      dedupeKey: checkString(KIND, `${path}.dedupeKey`, raw.dedupeKey),
    };
  });
  return { clock, entries };
}
