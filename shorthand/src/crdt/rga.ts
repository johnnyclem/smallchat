/**
 * RGA (Replicated Growable Array) — a sequence CRDT for ordered collections.
 *
 * Used for L0/L1 (recent history / session context). Merging two agents'
 * message sequences into a coherent interleaved order is the same problem
 * as collaborative text editing. RGA handles this at message granularity.
 *
 * Each element is identified by a unique (agentId, counter) pair, which is
 * also its Lamport timestamp. Insertions reference the element they follow
 * (causal predecessor; null = the head of the sequence, a virtual root).
 * A new element goes right after its predecessor, skipping every element
 * with a greater timestamp: concurrent inserts at the same position —
 * including the head — are ordered newest first, with agentId breaking
 * equal counters, and each skipped element's successors (which all carry
 * greater timestamps) stay attached to it. The sequence is therefore a
 * function of the set of elements alone, not of the order they arrived in.
 *
 * The sequence is a linked list indexed by id, so integrating an element
 * costs O(1) plus the elements it skips, and rehydrating a log is linear.
 *
 * Reference: Roh et al., "Replicated abstract data types" (2011)
 */

import type { AgentId, LamportTimestamp, CRDT } from './types.js';
import { LamportClock, compareLamport } from './clock.js';
import {
  CRDT_SCHEMA_VERSION,
  canonicalJson,
  checkClockField,
  checkCounter,
  checkLamport,
  checkState,
  checkString,
  fail,
  isRecord,
} from './wire.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique identifier for an RGA node. */
export interface RGANodeId {
  agentId: AgentId;
  counter: number;
}

/** A node in the RGA linked structure. */
export interface RGANode<V> {
  id: RGANodeId;
  value: V;
  /** Lamport timestamp of the insert; always equal to `id`. */
  timestamp: LamportTimestamp;
  /** The node this was inserted after. null = head of sequence. */
  parent: RGANodeId | null;
  /** Tombstone flag — true means this node has been deleted. */
  deleted: boolean;
}

/** Serialized RGA state. */
export interface RGAState<V> {
  /** Wire-format version (absent on pre-1.0 states). */
  schemaVersion?: typeof CRDT_SCHEMA_VERSION;
  /** Lamport counter of the serializing replica, restored by `from`. */
  clock?: number;
  /** Every node, tombstones included, in sequence order. */
  nodes: RGANode<V>[];
}

const KIND = 'RGA';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeIdKey(id: RGANodeId): string {
  return `${id.agentId}:${id.counter}`;
}

function copyNode<V>(node: RGANode<V>): RGANode<V> {
  return {
    id: { agentId: node.id.agentId, counter: node.id.counter },
    value: node.value,
    timestamp: { counter: node.timestamp.counter, agentId: node.timestamp.agentId },
    parent: node.parent ? { agentId: node.parent.agentId, counter: node.parent.counter } : null,
    deleted: node.deleted,
  };
}

/** A position in the linked list: the head sentinel or a node's slot. */
interface Link<V> {
  next: Slot<V> | null;
}

interface Slot<V> extends Link<V> {
  node: RGANode<V>;
  prev: Link<V>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RGA<V> implements CRDT<V[], RGAState<V>> {
  /** Head sentinel: the virtual root every head insert follows. */
  private readonly head: Link<V> = { next: null };
  /** Last link in the list (the head when empty). */
  private tail: Link<V> = this.head;
  private slots: Map<string, Slot<V>> = new Map();
  private visible = 0;
  private clock: LamportClock;

  constructor(agentId: AgentId) {
    this.clock = new LamportClock(agentId);
  }

  /**
   * Insert a value after the given reference node (or at head if null).
   * The reference node must be known to this replica (tombstoned is fine).
   * Returns the ID of the newly inserted node.
   */
  insertAfter(value: V, after: RGANodeId | null): RGANodeId {
    if (after !== null && !this.slots.has(nodeIdKey(after))) {
      throw new RangeError(`RGA.insertAfter: unknown node ${nodeIdKey(after)}`);
    }
    const ts = this.clock.tick();
    const id: RGANodeId = { agentId: ts.agentId, counter: ts.counter };
    this.integrate({
      id,
      value,
      timestamp: ts,
      parent: after ? { agentId: after.agentId, counter: after.counter } : null,
      deleted: false,
    });
    return { ...id };
  }

  /** Append a value at the end of the sequence. */
  append(value: V): RGANodeId {
    let link = this.tail;
    while (link !== this.head && (link as Slot<V>).node.deleted) link = (link as Slot<V>).prev;
    return this.insertAfter(value, link === this.head ? null : (link as Slot<V>).node.id);
  }

  /** Mark a node as deleted (tombstone). */
  delete(id: RGANodeId): boolean {
    const slot = this.slots.get(nodeIdKey(id));
    if (!slot || slot.node.deleted) return false;
    slot.node.deleted = true;
    this.visible--;
    return true;
  }

  /** Get the current ordered sequence (excluding tombstones). */
  value(): V[] {
    return this.visibleNodes().map((n) => n.value);
  }

  /** Get all node IDs in order (excluding tombstones). */
  nodeIds(): RGANodeId[] {
    return this.visibleNodes().map((n) => ({ ...n.id }));
  }

  /** Get the number of visible (non-deleted) elements. */
  get length(): number {
    return this.visible;
  }

  /** Serialize the full state (including tombstones for proper merge). */
  serialize(): RGAState<V> {
    const nodes: RGANode<V>[] = [];
    for (let slot = this.head.next; slot; slot = slot.next) nodes.push(copyNode(slot.node));
    return { schemaVersion: CRDT_SCHEMA_VERSION, clock: this.clock.current(), nodes };
  }

  /**
   * Merge with a remote RGA replica. Integrates remote nodes into the
   * local sequence respecting causal ordering, and propagates tombstones.
   *
   * Throws TypeError, before changing anything, when the state is
   * malformed: a node whose id differs from its timestamp, a node that is
   * not causally after its predecessor, a predecessor that is in neither
   * replica, or a node id that carries different content on the two sides
   * (two writers sharing a replica id). Returns true if changed.
   */
  merge(remote: RGAState<V>): boolean {
    const incoming = parseRGAState<V>(remote);

    const fresh = new Map<string, RGANode<V>>();
    const toDelete: Slot<V>[] = [];
    for (const node of incoming.nodes) {
      const key = nodeIdKey(node.id);
      const known = this.slots.get(key)?.node ?? fresh.get(key);
      if (!known) {
        fresh.set(key, node);
        continue;
      }
      assertSameNode(known, node);
      if (node.deleted && !known.deleted) {
        const slot = this.slots.get(key);
        if (slot) toDelete.push(slot);
        else known.deleted = true;
      }
    }

    for (const [key, node] of fresh) {
      if (!node.parent) continue;
      const parentKey = nodeIdKey(node.parent);
      const parent = this.slots.get(parentKey)?.node ?? fresh.get(parentKey);
      if (!parent) fail(KIND, `node ${key}`, `follows ${parentKey}, which is in neither replica`);
      if (compareLamport(node.timestamp, parent.timestamp) <= 0) {
        fail(KIND, `node ${key}`, `is not causally after its predecessor ${parentKey}`);
      }
    }

    // Predecessors carry smaller timestamps, so ascending order integrates
    // every predecessor before the nodes that follow it.
    const ordered = [...fresh.values()].sort((a, b) => compareLamport(a.timestamp, b.timestamp));
    for (const node of ordered) this.integrate(node);
    for (const slot of new Set(toDelete)) {
      if (!slot.node.deleted) {
        slot.node.deleted = true;
        this.visible--;
      }
    }
    if (incoming.clock !== undefined) this.clock.observe(incoming.clock);
    for (const node of incoming.nodes) this.clock.observe(node.timestamp.counter);

    return ordered.length > 0 || toDelete.length > 0;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Link a node whose predecessor is already integrated: right after the
   * predecessor, past every node with a greater timestamp (concurrent
   * siblings inserted later and, transitively, everything after them).
   */
  private integrate(node: RGANode<V>): void {
    let prev: Link<V> = node.parent ? this.slots.get(nodeIdKey(node.parent))! : this.head;
    while (prev.next && compareLamport(prev.next.node.timestamp, node.timestamp) > 0) {
      prev = prev.next;
    }
    const slot: Slot<V> = { node, prev, next: prev.next };
    if (prev.next) prev.next.prev = slot;
    else this.tail = slot;
    prev.next = slot;
    this.slots.set(nodeIdKey(node.id), slot);
    if (!node.deleted) this.visible++;
  }

  private visibleNodes(): RGANode<V>[] {
    const nodes: RGANode<V>[] = [];
    for (let slot = this.head.next; slot; slot = slot.next) {
      if (!slot.node.deleted) nodes.push(slot.node);
    }
    return nodes;
  }

  /** Create from serialized state (restores the clock). */
  static from<V>(agentId: AgentId, state: RGAState<V>): RGA<V> {
    const rga = new RGA<V>(agentId);
    rga.merge(state);
    return rga;
  }
}

/** Two copies of one node id must agree on everything but the tombstone. */
function assertSameNode<V>(a: RGANode<V>, b: RGANode<V>): void {
  const sameParent =
    a.parent === null || b.parent === null
      ? a.parent === b.parent
      : a.parent.agentId === b.parent.agentId && a.parent.counter === b.parent.counter;
  const sameValue = a.value === b.value || canonicalJson(a.value) === canonicalJson(b.value);
  if (!sameParent || !sameValue) {
    fail(
      KIND,
      `node ${nodeIdKey(a.id)}`,
      `differs between replicas: two writers share replica id "${a.id.agentId}" ` +
        '(restore a replica with RGA.from before it writes again)',
    );
  }
}

/** Validate a peer's RGA state and return normalized node copies. */
function parseRGAState<V>(state: unknown): { clock?: number; nodes: RGANode<V>[] } {
  const s = checkState(KIND, state);
  const clock = checkClockField(KIND, s);
  if (!Array.isArray(s.nodes)) fail(KIND, 'nodes', 'must be an array');
  const nodes = s.nodes.map((raw, i): RGANode<V> => {
    const path = `nodes[${i}]`;
    if (!isRecord(raw)) fail(KIND, path, 'must be an object');
    if (!isRecord(raw.id)) fail(KIND, `${path}.id`, 'must be a node id');
    const id: RGANodeId = {
      agentId: checkString(KIND, `${path}.id.agentId`, raw.id.agentId),
      counter: checkCounter(KIND, `${path}.id.counter`, raw.id.counter),
    };
    const timestamp = checkLamport(KIND, `${path}.timestamp`, raw.timestamp);
    if (timestamp.agentId !== id.agentId || timestamp.counter !== id.counter) {
      fail(KIND, `${path}.timestamp`, 'must equal the node id');
    }
    let parent: RGANodeId | null = null;
    if (raw.parent !== null && raw.parent !== undefined) {
      if (!isRecord(raw.parent)) fail(KIND, `${path}.parent`, 'must be a node id or null');
      parent = {
        agentId: checkString(KIND, `${path}.parent.agentId`, raw.parent.agentId),
        counter: checkCounter(KIND, `${path}.parent.counter`, raw.parent.counter),
      };
    }
    if (typeof raw.deleted !== 'boolean') fail(KIND, `${path}.deleted`, 'must be a boolean');
    return { id, value: raw.value as V, timestamp, parent, deleted: raw.deleted };
  });
  return { clock, nodes };
}
