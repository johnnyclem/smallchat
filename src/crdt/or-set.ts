/**
 * OR-Set (Observed-Remove Set) — a CRDT that handles concurrent add/remove
 * correctly: if one agent adds an element while another concurrently removes
 * it, the add wins. This is the safe default for knowledge graphs.
 *
 * Used for L3 (entity-relationship graph) nodes. Each add operation generates
 * a unique tag; remove operations record which tags they've observed.
 * An element is in the set iff it has at least one un-removed tag.
 *
 * Reference: Shapiro et al., "A comprehensive study of CRDTs" (2011)
 */

import type { AgentId, UniqueTag, CRDT } from './types.js';
import { LamportClock } from './clock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serialized OR-Set state: element → set of active unique tags. */
export interface ORSetState<E> {
  /** Map from serialized element to its active tags. */
  elements: Array<{ element: E; tags: UniqueTag[] }>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ORSet<E> implements CRDT<Set<E>, ORSetState<E>> {
  /**
   * Internal state: maps each element (by its JSON key) to its set of
   * active unique tags. An element is "in" the set iff it has ≥1 tag.
   */
  private elementMap: Map<string, { element: E; tags: Set<UniqueTag> }> = new Map();
  private clock: LamportClock;
  private readonly agentId: AgentId;

  constructor(agentId: AgentId) {
    this.agentId = agentId;
    this.clock = new LamportClock(agentId);
  }

  /** Serialize an element to a stable string key. */
  private keyOf(element: E): string {
    return JSON.stringify(element);
  }

  /** Generate a globally unique tag. */
  private newTag(): UniqueTag {
    const ts = this.clock.tick();
    return `${ts.agentId}:${ts.counter}`;
  }

  /** Add an element, returning its unique tag. */
  add(element: E): UniqueTag {
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
    this.elementMap.delete(key);
  }

  /** Check if an element is in the set. */
  has(element: E): boolean {
    const key = this.keyOf(element);
    const entry = this.elementMap.get(key);
    return entry !== undefined && entry.tags.size > 0;
  }

  /** Return the current set of elements. */
  value(): Set<E> {
    const result = new Set<E>();
    for (const entry of this.elementMap.values()) {
      if (entry.tags.size > 0) {
        result.add(entry.element);
      }
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

  /** Serialize to a JSON-safe representation. */
  serialize(): ORSetState<E> {
    const elements: Array<{ element: E; tags: UniqueTag[] }> = [];
    for (const entry of this.elementMap.values()) {
      if (entry.tags.size > 0) {
        elements.push({ element: entry.element, tags: [...entry.tags] });
      }
    }
    return { elements };
  }

  /**
   * Merge with a remote OR-Set replica. For each element, take the union
   * of tags. Elements present remotely but not locally are added.
   * Returns true if any local state changed.
   */
  merge(remote: ORSetState<E>): boolean {
    let changed = false;

    for (const { element, tags: remoteTags } of remote.elements) {
      const key = this.keyOf(element);
      const localEntry = this.elementMap.get(key);

      if (!localEntry) {
        // New element from remote — add all tags
        this.elementMap.set(key, {
          element,
          tags: new Set(remoteTags),
        });
        changed = true;
      } else {
        // Existing element — union of tags
        for (const tag of remoteTags) {
          if (!localEntry.tags.has(tag)) {
            localEntry.tags.add(tag);
            changed = true;
          }
        }
      }
    }

    return changed;
  }

  /** Create from a serialized state. */
  static from<E>(agentId: AgentId, state: ORSetState<E>): ORSet<E> {
    const set = new ORSet<E>(agentId);
    set.merge(state);
    return set;
  }
}
