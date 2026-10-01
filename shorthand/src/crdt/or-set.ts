/**
 * OR-Set (Observed-Remove Set) — a CRDT that handles concurrent add/remove
 * correctly: if one agent adds an element while another concurrently removes
 * it, the add wins. This is the safe default for knowledge graphs.
 *
 * Used for L3 (entity-relationship graph) nodes. Each add operation generates
 * a unique tag (`<agentId>:<counter>` from the set's own Lamport clock);
 * remove operations tombstone the tags they've observed, and the tombstones
 * travel with the serialized state so removes propagate. An element is in
 * the set iff it has at least one un-removed tag. Elements are identified by
 * their canonical JSON, so key order never makes two equal objects differ.
 *
 * The clock is serialized (`clock`) and every merge advances it past the
 * counters it sees, so a restored replica never reissues a tag.
 *
 * Reference: Shapiro et al., "A comprehensive study of CRDTs" (2011)
 */

import type { AgentId, UniqueTag, CRDT } from './types.js';
import { LamportClock } from './clock.js';
import {
  CRDT_SCHEMA_VERSION,
  canonicalJson,
  checkClockField,
  checkState,
  checkStringArray,
  compareStrings,
  fail,
  isRecord,
} from './wire.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serialized OR-Set state: element → set of active unique tags, plus tombstones. */
export interface ORSetState<E> {
  /** Wire-format version (absent on pre-1.0 states). */
  schemaVersion?: typeof CRDT_SCHEMA_VERSION;
  /** Lamport counter of the serializing replica (the last tag it issued or saw). */
  clock?: number;
  /** Map from serialized element to its active tags. */
  elements: Array<{ element: E; tags: UniqueTag[] }>;
  /**
   * Tags observed by a remove (tombstones). A tag in this set never
   * becomes active again, so removes propagate through merges. Optional
   * so states written before tombstones existed still load.
   */
  removed?: UniqueTag[];
}

const KIND = 'OR-Set';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ORSet<E> implements CRDT<Set<E>, ORSetState<E>> {
  /**
   * Internal state: maps each element (by its canonical JSON) to its set of
   * active unique tags. An element is "in" the set iff it has ≥1 tag.
   */
  private elementMap: Map<string, { element: E; tags: Set<UniqueTag> }> = new Map();
  /** Tags observed by removes — never re-activated by a merge. */
  private removed: Set<UniqueTag> = new Set();
  private clock: LamportClock;

  constructor(agentId: AgentId) {
    this.clock = new LamportClock(agentId);
  }

  /** Serialize an element to a stable string key (canonical JSON). */
  private keyOf(element: E): string {
    return canonicalJson(element);
  }

  /** Generate a globally unique tag. */
  private newTag(): UniqueTag {
    const ts = this.clock.tick();
    return `${ts.agentId}:${ts.counter}`;
  }

  /** Add an element, returning its unique tag. */
  add(element: E): UniqueTag {
    if (element === undefined) throw new TypeError('ORSet.add: element must not be undefined');
    const key = this.keyOf(element);
    const tag = this.newTag();
    const entry = this.elementMap.get(key);
    if (entry) {
      entry.tags.add(tag);
    } else {
      this.elementMap.set(key, { element, tags: new Set([tag]) });
    }
    return tag;
  }

  /**
   * Remove an element by removing all currently observed tags.
   * If a concurrent add created a new tag we haven't seen, that tag
   * survives — making the add win over the remove (add-wins semantics).
   */
  remove(element: E): void {
    const key = this.keyOf(element);
    const entry = this.elementMap.get(key);
    if (!entry) return;
    for (const tag of entry.tags) this.removed.add(tag);
    this.elementMap.delete(key);
  }

  /** Check if an element is in the set. */
  has(element: E): boolean {
    const key = this.keyOf(element);
    const entry = this.elementMap.get(key);
    return entry !== undefined && entry.tags.size > 0;
  }

  /** Return the current set of elements, in canonical-key order. */
  value(): Set<E> {
    const result = new Set<E>();
    for (const key of this.sortedKeys()) {
      result.add(this.elementMap.get(key)!.element);
    }
    return result;
  }

  /** Number of elements in the set. */
  get size(): number {
    let count = 0;
    for (const entry of this.elementMap.values()) {
      if (entry.tags.size > 0) count++;
    }
    return count;
  }

  /** Iterate over elements. */
  [Symbol.iterator](): Iterator<E> {
    return this.value()[Symbol.iterator]();
  }

  /** Serialize to a JSON-safe representation (elements, tags and tombstones sorted). */
  serialize(): ORSetState<E> {
    const elements: Array<{ element: E; tags: UniqueTag[] }> = [];
    for (const key of this.sortedKeys()) {
      const entry = this.elementMap.get(key)!;
      elements.push({ element: entry.element, tags: [...entry.tags].sort(compareStrings) });
    }
    return {
      schemaVersion: CRDT_SCHEMA_VERSION,
      clock: this.clock.current(),
      elements,
      removed: [...this.removed].sort(compareStrings),
    };
  }

  /**
   * Merge with a remote OR-Set replica: the union of adds minus the union
   * of removes. An element is present iff it has at least one tag no
   * replica has removed. Throws TypeError, before changing anything, on a
   * malformed state. Returns true if any element or tag changed.
   */
  merge(remote: ORSetState<E>): boolean {
    const incoming = parseORSetState<E>(remote);
    let changed = false;

    // Advance the tag clock past every tag seen, so this replica never
    // reissues a tag it (or a restored copy of it) already used.
    if (incoming.clock !== undefined) this.clock.observe(incoming.clock);
    for (const { tags } of incoming.elements) {
      for (const tag of tags) this.observeTag(tag);
    }
    for (const tag of incoming.removed) this.observeTag(tag);

    // Union of removes: tombstone remote-removed tags locally.
    const newlyRemoved = new Set(incoming.removed.filter((tag) => !this.removed.has(tag)));
    if (newlyRemoved.size > 0) {
      for (const tag of newlyRemoved) this.removed.add(tag);
      for (const [key, entry] of this.elementMap) {
        for (const tag of entry.tags) {
          if (newlyRemoved.has(tag)) {
            entry.tags.delete(tag);
            changed = true;
          }
        }
        if (entry.tags.size === 0) this.elementMap.delete(key);
      }
    }

    // Union of adds, minus anything tombstoned.
    for (const { element, tags: remoteTags } of incoming.elements) {
      const live = remoteTags.filter((tag) => !this.removed.has(tag));
      if (live.length === 0) continue;
      const key = this.keyOf(element);
      const localEntry = this.elementMap.get(key);

      if (!localEntry) {
        this.elementMap.set(key, { element, tags: new Set(live) });
        changed = true;
      } else {
        for (const tag of live) {
          if (!localEntry.tags.has(tag)) {
            localEntry.tags.add(tag);
            changed = true;
          }
        }
      }
    }

    return changed;
  }

  /** Move the tag clock past a tag's counter (`<agentId>:<counter>`). */
  private observeTag(tag: UniqueTag): void {
    const counter = Number(tag.slice(tag.lastIndexOf(':') + 1));
    if (Number.isSafeInteger(counter) && counter > 0) this.clock.observe(counter);
  }

  private sortedKeys(): string[] {
    return [...this.elementMap.keys()].sort(compareStrings);
  }

  /** Create from a serialized state (restores the tag clock). */
  static from<E>(agentId: AgentId, state: ORSetState<E>): ORSet<E> {
    const set = new ORSet<E>(agentId);
    set.merge(state);
    return set;
  }
}

/** Validate a peer's OR-Set state. */
function parseORSetState<E>(state: unknown): {
  clock?: number;
  elements: Array<{ element: E; tags: UniqueTag[] }>;
  removed: UniqueTag[];
} {
  const s = checkState(KIND, state);
  const clock = checkClockField(KIND, s);
  if (!Array.isArray(s.elements)) fail(KIND, 'elements', 'must be an array');
  const elements = s.elements.map((raw, i) => {
    if (!isRecord(raw)) fail(KIND, `elements[${i}]`, 'must be an object');
    if (raw.element === undefined) fail(KIND, `elements[${i}].element`, 'is missing');
    return { element: raw.element as E, tags: checkStringArray(KIND, `elements[${i}].tags`, raw.tags) };
  });
  const removed = s.removed === undefined ? [] : checkStringArray(KIND, 'removed', s.removed);
  return { clock, elements, removed };
}
