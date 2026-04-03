/**
 * Lamport Clock & Vector Clock — logical time primitives for causal ordering.
 *
 * Lamport clocks (1978) provide a total order over events: if event A
 * causally precedes event B, then A's timestamp < B's timestamp.
 * The converse is not true — concurrent events may have any ordering.
 *
 * Vector clocks extend this to detect true concurrency: two events are
 * concurrent iff neither vector clock dominates the other.
 */

import type { AgentId, LamportTimestamp, VectorClock } from './types.js';

// ---------------------------------------------------------------------------
// Lamport clock
// ---------------------------------------------------------------------------

export class LamportClock {
  private counter: number;
  readonly agentId: AgentId;

  constructor(agentId: AgentId, initial = 0) {
    this.agentId = agentId;
    this.counter = initial;
  }

  /** Increment and return a new timestamp for a local event. */
  tick(): LamportTimestamp {
    this.counter++;
    return { counter: this.counter, agentId: this.agentId };
  }

  /** Update the clock upon receiving a remote timestamp, then tick. */
  receive(remote: LamportTimestamp): LamportTimestamp {
    this.counter = Math.max(this.counter, remote.counter) + 1;
    return { counter: this.counter, agentId: this.agentId };
  }

  /** Current counter value (without ticking). */
  current(): number {
    return this.counter;
  }

  /** Get a timestamp snapshot without incrementing. */
  peek(): LamportTimestamp {
    return { counter: this.counter, agentId: this.agentId };
  }
}

// ---------------------------------------------------------------------------
// Lamport timestamp comparison
// ---------------------------------------------------------------------------

/**
 * Compare two Lamport timestamps.
 * Returns negative if a < b, positive if a > b, zero if equal.
 * Ties are broken by agentId lexicographic order.
 */
export function compareLamport(a: LamportTimestamp, b: LamportTimestamp): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Vector clock operations
// ---------------------------------------------------------------------------

/** Create a new vector clock with a single agent entry. */
export function createVectorClock(agentId: AgentId, counter = 0): VectorClock {
  return { [agentId]: counter };
}

/** Increment an agent's entry in the vector clock. */
export function tickVectorClock(vc: VectorClock, agentId: AgentId): VectorClock {
  const next = { ...vc };
  next[agentId] = (next[agentId] ?? 0) + 1;
  return next;
}

/**
 * Merge two vector clocks by taking the component-wise maximum.
 * This is the join operation in the lattice of vector clocks.
 */
export function mergeVectorClocks(a: VectorClock, b: VectorClock): VectorClock {
  const merged: VectorClock = { ...a };
  for (const [agent, counter] of Object.entries(b)) {
    merged[agent] = Math.max(merged[agent] ?? 0, counter);
  }
  return merged;
}

/**
 * Determine the causal relationship between two vector clocks.
 * - 'before': a happened before b (a < b)
 * - 'after': a happened after b (a > b)
 * - 'equal': identical clocks
 * - 'concurrent': neither dominates — true concurrency
 */
export function compareVectorClocks(
  a: VectorClock,
  b: VectorClock,
): 'before' | 'after' | 'equal' | 'concurrent' {
  const allAgents = new Set([...Object.keys(a), ...Object.keys(b)]);

  let aBeforeB = false;
  let bBeforeA = false;

  for (const agent of allAgents) {
    const ca = a[agent] ?? 0;
    const cb = b[agent] ?? 0;
    if (ca < cb) aBeforeB = true;
    if (ca > cb) bBeforeA = true;
  }

  if (!aBeforeB && !bBeforeA) return 'equal';
  if (aBeforeB && !bBeforeA) return 'before';
  if (!aBeforeB && bBeforeA) return 'after';
  return 'concurrent';
}
