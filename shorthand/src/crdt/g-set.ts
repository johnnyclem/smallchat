/**
 * G-Set (Grow-Only Set) with merge function — elements can be added but
 * never removed. Merge is union, which is trivially commutative,
 * associative, and idempotent.
 *
 * Used for L2 (topic-clustered summaries). Summaries from different agents
 * are both retained. A domain-aware merge function handles deduplication
 * of semantically equivalent summaries.
 *
 * The optional merge function allows custom deduplication logic — e.g.,
 * preferring summaries from direct participants over secondhand reports.
 */

import type { CRDT } from './types.js';

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
  /** Stable identifier for deduplication (e.g., topic hash). */
  dedupeKey?: string;
}

/** Serialized G-Set state. */
export interface GSetState<V> {
  entries: GSetEntry<V>[];
}

// ---------------------------------------------------------------------------
// Merge function type
// ---------------------------------------------------------------------------

/**
 * Domain-aware merge function for resolving duplicate entries.
 * Given two entries with the same dedupeKey, returns the winner.
 * Default: prefer direct participant, then longer content.
 */
export type GSetMergeFn<V> = (a: GSetEntry<V>, b: GSetEntry<V>) => GSetEntry<V>;

/** Default merge: prefer direct participant, then break tie by string length. */
export function defaultMergeFn<V>(a: GSetEntry<V>, b: GSetEntry<V>): GSetEntry<V> {
  // "I was there" outranks "I heard about it"
  if (a.isDirectParticipant && !b.isDirectParticipant) return a;
  if (b.isDirectParticipant && !a.isDirectParticipant) return b;
  // Both direct or both indirect — prefer longer (more detailed) summary
  const aLen = typeof a.value === 'string' ? a.value.length : JSON.stringify(a.value).length;
  const bLen = typeof b.value === 'string' ? b.value.length : JSON.stringify(b.value).length;
  return aLen >= bLen ? a : b;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class GSet<V> implements CRDT<GSetEntry<V>[], GSetState<V>> {
  private entries: Map<string, GSetEntry<V>> = new Map();
  private nextId = 0;
  private mergeFn: GSetMergeFn<V>;

  constructor(mergeFn: GSetMergeFn<V> = defaultMergeFn) {
    this.mergeFn = mergeFn;
  }

  /** Generate a unique key for entries without a dedupeKey. */
  private autoKey(): string {
    return `__auto_${this.nextId++}`;
  }

  /** Add an entry to the set. */
  add(entry: GSetEntry<V>): void {
    const key = entry.dedupeKey ?? this.autoKey();

    const existing = this.entries.get(key);
    if (existing) {
      // Deduplicate using merge function
      this.entries.set(key, this.mergeFn(existing, entry));
    } else {
      this.entries.set(key, { ...entry, dedupeKey: key });
    }
  }

  /** Get all entries. */
  value(): GSetEntry<V>[] {
    return [...this.entries.values()];
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Look up an entry by its dedupeKey. */
  getByKey(dedupeKey: string): GSetEntry<V> | undefined {
    return this.entries.get(dedupeKey);
  }

  /** Serialize to JSON-safe form. */
  serialize(): GSetState<V> {
    return { entries: [...this.entries.values()] };
  }

  /**
   * Merge with a remote G-Set. New entries are added; entries with matching
   * dedupeKeys are resolved using the merge function.
   * Returns true if any local state changed.
   */
  merge(remote: GSetState<V>): boolean {
    let changed = false;

    for (const remoteEntry of remote.entries) {
      const key = remoteEntry.dedupeKey ?? this.autoKey();
      const existing = this.entries.get(key);

      if (!existing) {
        this.entries.set(key, { ...remoteEntry, dedupeKey: key });
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

  /** Create from serialized state. */
  static from<V>(state: GSetState<V>, mergeFn?: GSetMergeFn<V>): GSet<V> {
    const set = new GSet<V>(mergeFn);
    set.merge(state);
    return set;
  }
}
