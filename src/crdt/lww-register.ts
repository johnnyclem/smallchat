/**
 * LWW-Register (Last Writer Wins Register) — a CRDT where concurrent
 * writes are resolved by Lamport timestamp ordering.
 *
 * Used for L4 (core invariants) where the most recent update should win.
 * Each key-value pair carries a Lamport timestamp; on merge, the entry
 * with the higher timestamp takes precedence. Ties are broken by agentId.
 *
 * Reference: Shapiro et al., "A comprehensive study of CRDTs" (2011)
 */

import type { AgentId, LamportTimestamp, CRDT } from './types.js';
import { LamportClock, compareLamport } from './clock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single timestamped entry in the register map. */
export interface LWWEntry<V> {
  value: V;
  timestamp: LamportTimestamp;
}

/** Serialized form of the full LWW register map. */
export interface LWWRegisterState<V> {
  entries: Record<string, LWWEntry<V>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class LWWRegister<V> implements CRDT<Map<string, V>, LWWRegisterState<V>> {
  private entries: Map<string, LWWEntry<V>> = new Map();
  private clock: LamportClock;

  constructor(agentId: AgentId) {
    this.clock = new LamportClock(agentId);
  }

  /** Set a key to a value, stamping it with a new Lamport timestamp. */
  set(key: string, value: V): LamportTimestamp {
    const ts = this.clock.tick();
    this.entries.set(key, { value, timestamp: ts });
    return ts;
  }

  /** Get the current value for a key, or undefined. */
  get(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  /** Get the full entry (value + timestamp) for a key. */
  getEntry(key: string): LWWEntry<V> | undefined {
    return this.entries.get(key);
  }

  /** Check if a key exists. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Delete a key by writing a tombstone (value = undefined). */
  delete(key: string): void {
    const ts = this.clock.tick();
    // We store the tombstone as a special entry; consumers check via get()
    this.entries.set(key, { value: undefined as unknown as V, timestamp: ts });
  }

  /** Return all current key-value pairs (excluding tombstones). */
  value(): Map<string, V> {
    const result = new Map<string, V>();
    for (const [key, entry] of this.entries) {
      if (entry.value !== undefined) {
        result.set(key, entry.value);
      }
    }
    return result;
  }

  /** All keys including tombstoned ones. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  /** Serialize to a JSON-safe representation. */
  serialize(): LWWRegisterState<V> {
    const entries: Record<string, LWWEntry<V>> = {};
    for (const [key, entry] of this.entries) {
      entries[key] = entry;
    }
    return { entries };
  }

  /**
   * Merge with a remote replica. For each key, the entry with the higher
   * Lamport timestamp wins. Returns true if any local state changed.
   */
  merge(remote: LWWRegisterState<V>): boolean {
    let changed = false;

    for (const [key, remoteEntry] of Object.entries(remote.entries)) {
      const localEntry = this.entries.get(key);

      if (!localEntry || compareLamport(remoteEntry.timestamp, localEntry.timestamp) > 0) {
        this.entries.set(key, remoteEntry);
        this.clock.receive(remoteEntry.timestamp);
        changed = true;
      }
    }

    return changed;
  }

  /** Create from a serialized state. */
  static from<V>(agentId: AgentId, state: LWWRegisterState<V>): LWWRegister<V> {
    const reg = new LWWRegister<V>(agentId);
    reg.merge(state);
    return reg;
  }
}
