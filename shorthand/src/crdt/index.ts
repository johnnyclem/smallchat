/**
 * CRDT module — Conflict-free Replicated Data Types for multi-agent shared memory.
 *
 * Provides four CRDT primitives mapped to agent memory compaction levels:
 *
 * - LWW-Register → L4 (core invariants): last writer wins by Lamport timestamp
 * - OR-Set       → L3 (entity-relationship graph): add-wins set for graph nodes
 * - G-Set        → L2 (topic-clustered summaries): grow-only with domain-aware dedup
 * - RGA          → L0/L1 (recent history): replicated sequence for message interleaving
 *
 * Plus supporting primitives:
 * - Lamport Clock: logical time without wall-clock synchronization
 * - Vector Clock: detecting true concurrency between events
 */

// Clock primitives
export { LamportClock, compareLamport } from './clock.js';
export {
  createVectorClock,
  tickVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
} from './clock.js';

// CRDT types
export type {
  AgentId,
  LamportTimestamp,
  VectorClock,
  UniqueTag,
  CausalMeta,
  MergeResult,
  CRDT as CRDTInterface,
} from './types.js';

// LWW-Register (L4)
export { LWWRegister } from './lww-register.js';
export type { LWWEntry, LWWRegisterState } from './lww-register.js';

// OR-Set (L3)
export { ORSet } from './or-set.js';
export type { ORSetState } from './or-set.js';

// G-Set (L2)
export { GSet, defaultMergeFn } from './g-set.js';
export type { GSetEntry, GSetState, GSetMergeFn } from './g-set.js';

// RGA (L0/L1)
export { RGA } from './rga.js';
export type { RGANodeId, RGANode, RGAState } from './rga.js';

// Memory layer system
export { AgentMemory } from './memory/agent-memory.js';
export { MemoryMerge } from './memory/memory-merge.js';
export { ConflictDetector, type SemanticConflict, type ConflictSeverity } from './memory/conflict-detector.js';
export type {
  MemoryLayer,
  L4Invariants,
  L3Entity,
  L3Edge,
  L3Graph,
  L2Summary,
  L1Context,
  L0Message,
  AgentMemoryState,
} from './memory/types.js';
