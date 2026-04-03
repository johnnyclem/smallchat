/**
 * RGA (Replicated Growable Array) — a sequence CRDT for ordered collections.
 *
 * Used for L0/L1 (recent history / session context). Merging two agents'
 * message sequences into a coherent interleaved order is the same problem
 * as collaborative text editing. RGA handles this at message granularity.
 *
 * Each element is identified by a unique (agentId, counter) pair.
 * Insertions reference the element they follow (causal predecessor).
 * Concurrent insertions at the same position are ordered by timestamp
 * (higher timestamp = later in sequence), with agentId as tiebreaker.
 *
 * Reference: Roh et al., "Replicated abstract data types" (2011)
 */

import type { AgentId, LamportTimestamp, CRDT } from './types.js';
import { LamportClock, compareLamport } from './clock.js';

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
  timestamp: LamportTimestamp;
  /** The node this was inserted after. null = head of sequence. */
  parent: RGANodeId | null;
  /** Tombstone flag — true means this node has been deleted. */
  deleted: boolean;
}

/** Serialized RGA state. */
export interface RGAState<V> {
  nodes: RGANode<V>[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeIdEq(a: RGANodeId | null, b: RGANodeId | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.agentId === b.agentId && a.counter === b.counter;
}

function nodeIdKey(id: RGANodeId): string {
  return `${id.agentId}:${id.counter}`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RGA<V> implements CRDT<V[], RGAState<V>> {
  private nodes: Map<string, RGANode<V>> = new Map();
  /** Ordered list of node keys representing the current sequence. */
  private sequence: string[] = [];
  private clock: LamportClock;

  constructor(agentId: AgentId) {
    this.clock = new LamportClock(agentId);
  }

  /**
   * Insert a value after the given reference node (or at head if null).
   * Returns the ID of the newly inserted node.
   */
  insertAfter(value: V, after: RGANodeId | null): RGANodeId {
    const ts = this.clock.tick();
    const id: RGANodeId = { agentId: ts.agentId, counter: ts.counter };
    const node: RGANode<V> = {
      id,
      value,
      timestamp: ts,
      parent: after,
      deleted: false,
    };

    this.addNode(node);
    return id;
  }

  /** Append a value at the end of the sequence. */
  append(value: V): RGANodeId {
    const lastKey = this.findLastVisibleKey();
    const after = lastKey ? this.nodes.get(lastKey)!.id : null;
    return this.insertAfter(value, after);
  }

  /** Mark a node as deleted (tombstone). */
  delete(id: RGANodeId): boolean {
    const key = nodeIdKey(id);
    const node = this.nodes.get(key);
    if (!node || node.deleted) return false;
    node.deleted = true;
    return true;
  }

  /** Get the current ordered sequence (excluding tombstones). */
  value(): V[] {
    return this.sequence
      .map(key => this.nodes.get(key)!)
      .filter(n => !n.deleted)
      .map(n => n.value);
  }

  /** Get all node IDs in order (excluding tombstones). */
  nodeIds(): RGANodeId[] {
    return this.sequence
      .map(key => this.nodes.get(key)!)
      .filter(n => !n.deleted)
      .map(n => n.id);
  }

  /** Get the number of visible (non-deleted) elements. */
  get length(): number {
    let count = 0;
    for (const key of this.sequence) {
      if (!this.nodes.get(key)!.deleted) count++;
    }
    return count;
  }

  /** Serialize the full state (including tombstones for proper merge). */
  serialize(): RGAState<V> {
    return {
      nodes: this.sequence.map(key => this.nodes.get(key)!),
    };
  }

  /**
   * Merge with a remote RGA replica. Integrates remote nodes into the
   * local sequence respecting causal ordering. Returns true if changed.
   */
  merge(remote: RGAState<V>): boolean {
    let changed = false;

    for (const remoteNode of remote.nodes) {
      const key = nodeIdKey(remoteNode.id);
      const existing = this.nodes.get(key);

      if (!existing) {
        this.addNode(remoteNode);
        this.clock.receive(remoteNode.timestamp);
        changed = true;
      } else if (!existing.deleted && remoteNode.deleted) {
        // Remote has tombstoned this node
        existing.deleted = true;
        changed = true;
      }
    }

    return changed;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /**
   * Add a node to the internal structure, finding its correct position
   * in the sequence based on parent reference and timestamp ordering.
   */
  private addNode(node: RGANode<V>): void {
    const key = nodeIdKey(node.id);
    if (this.nodes.has(key)) return;

    this.nodes.set(key, { ...node });

    // Find insertion position
    const insertIdx = this.findInsertPosition(node);
    this.sequence.splice(insertIdx, 0, key);
  }

  /**
   * Find the correct position to insert a node in the sequence.
   * The node goes after its parent. Among siblings (nodes with the same
   * parent), higher timestamps come first (left-to-right = newest first
   * among concurrent inserts at the same position).
   */
  private findInsertPosition(node: RGANode<V>): number {
    if (node.parent === null) {
      // Insert at head — but after any existing head-inserts with higher timestamps
      let idx = 0;
      while (idx < this.sequence.length) {
        const existing = this.nodes.get(this.sequence[idx])!;
        if (!nodeIdEq(existing.parent, null)) break;
        if (compareLamport(node.timestamp, existing.timestamp) > 0) break;
        idx++;
      }
      return idx;
    }

    const parentKey = nodeIdKey(node.parent);
    const parentIdx = this.sequence.indexOf(parentKey);

    if (parentIdx === -1) {
      // Parent not found — append to end (will be corrected on merge)
      return this.sequence.length;
    }

    // Scan right from parent, past all descendants and concurrent siblings
    let idx = parentIdx + 1;
    while (idx < this.sequence.length) {
      const existing = this.nodes.get(this.sequence[idx])!;
      // Stop if we've left the parent's subtree
      if (!nodeIdEq(existing.parent, node.parent) && !this.isDescendantOf(existing, node.parent)) {
        // But also check: is this a sibling with lower timestamp?
        if (nodeIdEq(existing.parent, node.parent)) {
          if (compareLamport(node.timestamp, existing.timestamp) > 0) break;
        } else {
          break;
        }
      }
      // Among siblings, higher timestamp comes first
      if (nodeIdEq(existing.parent, node.parent) && compareLamport(node.timestamp, existing.timestamp) > 0) {
        break;
      }
      idx++;
    }

    return idx;
  }

  /** Check if a node is a descendant of a given ancestor. */
  private isDescendantOf(node: RGANode<V>, ancestorId: RGANodeId | null): boolean {
    if (ancestorId === null) return true; // everything descends from head
    let current: RGANode<V> | undefined = node;
    const visited = new Set<string>();
    while (current?.parent) {
      const parentKey = nodeIdKey(current.parent);
      if (visited.has(parentKey)) return false; // cycle protection
      visited.add(parentKey);
      if (nodeIdEq(current.parent, ancestorId)) return true;
      current = this.nodes.get(parentKey);
    }
    return false;
  }

  /** Find the key of the last visible (non-deleted) node. */
  private findLastVisibleKey(): string | null {
    for (let i = this.sequence.length - 1; i >= 0; i--) {
      if (!this.nodes.get(this.sequence[i])!.deleted) {
        return this.sequence[i];
      }
    }
    return null;
  }

  /** Create from serialized state. */
  static from<V>(agentId: AgentId, state: RGAState<V>): RGA<V> {
    const rga = new RGA<V>(agentId);
    rga.merge(state);
    return rga;
  }
}
