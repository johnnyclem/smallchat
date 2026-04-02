/**
 * CRDT Types — shared interfaces for Conflict-free Replicated Data Types.
 *
 * These primitives enable multi-agent shared memory where each agent
 * maintains a local replica that can be merged with any other replica
 * in any order, always converging to the same state.
 */

// ---------------------------------------------------------------------------
// Agent identity
// ---------------------------------------------------------------------------

/** Unique identifier for an agent in the system. */
export type AgentId = string;

// ---------------------------------------------------------------------------
// Lamport clock
// ---------------------------------------------------------------------------

/**
 * Lamport timestamp — a logical clock that establishes causal ordering
 * without wall-clock synchronization (Lamport, 1978).
 */
export interface LamportTimestamp {
  /** Monotonically increasing counter. */
  counter: number;
  /** Agent that created this timestamp — used as tiebreaker. */
  agentId: AgentId;
}

// ---------------------------------------------------------------------------
// Vector clock
// ---------------------------------------------------------------------------

/**
 * Vector clock — maps each agent to its latest known counter.
 * Used for detecting causal ordering vs. concurrency between events.
 */
export type VectorClock = Record<AgentId, number>;

// ---------------------------------------------------------------------------
// CRDT operation metadata
// ---------------------------------------------------------------------------

/** Unique tag for OR-Set add operations. */
export type UniqueTag = string;

/** Causal metadata attached to every CRDT operation. */
export interface CausalMeta {
  timestamp: LamportTimestamp;
  vectorClock: VectorClock;
}

// ---------------------------------------------------------------------------
// Merge result
// ---------------------------------------------------------------------------

/** Result of merging two CRDT replicas. */
export interface MergeResult<T> {
  /** The merged state. */
  merged: T;
  /** Whether the merge produced any changes relative to the local state. */
  hadChanges: boolean;
}

// ---------------------------------------------------------------------------
// CRDT interface
// ---------------------------------------------------------------------------

/** Common interface for all CRDT types. */
export interface CRDT<State, Serialized = State> {
  /** Get the current state value. */
  value(): State;
  /** Serialize to a JSON-safe representation. */
  serialize(): Serialized;
  /** Merge with another serialized replica. Returns whether changes occurred. */
  merge(remote: Serialized): boolean;
}
