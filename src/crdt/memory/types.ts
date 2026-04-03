/**
 * Memory Layer Types — the five compaction levels for agent shared memory.
 *
 * L4: Core invariants (project-level facts) → LWW-Register
 * L3: Entity-relationship graph (knowledge graph) → OR-Set + LWW-Register
 * L2: Topic-clustered summaries → G-Set with merge function
 * L1: Session context (recent exchanges) → RGA sequence
 * L0: Raw message buffer → RGA sequence
 */

import type { AgentId, LamportTimestamp, VectorClock } from '../types.js';
import type { LWWRegisterState } from '../lww-register.js';
import type { ORSetState } from '../or-set.js';
import type { GSetState, GSetEntry } from '../g-set.js';
import type { RGAState } from '../rga.js';

// ---------------------------------------------------------------------------
// L4 — Core invariants
// ---------------------------------------------------------------------------

/**
 * L4 stores project-level facts as key-value pairs with LWW semantics.
 * Examples: "database" → "PostgreSQL", "framework" → "Next.js"
 */
export interface L4Invariants {
  layer: 'L4';
  state: LWWRegisterState<string>;
}

// ---------------------------------------------------------------------------
// L3 — Entity-relationship graph
// ---------------------------------------------------------------------------

/** An entity (node) in the knowledge graph. */
export interface L3Entity {
  /** Unique identifier for this entity. */
  id: string;
  /** Entity type (e.g., "service", "file", "concept", "person"). */
  type: string;
  /** Human-readable name. */
  name: string;
  /** Optional properties bag. */
  properties?: Record<string, string>;
}

/** A directed edge in the knowledge graph. */
export interface L3Edge {
  /** Source entity ID. */
  from: string;
  /** Target entity ID. */
  to: string;
  /** Relationship type (e.g., "depends-on", "calls", "owns"). */
  relation: string;
  /** Optional edge properties. */
  properties?: Record<string, string>;
}

/**
 * L3 stores the entity-relationship graph using:
 * - OR-Set for nodes (add-wins semantics: better to have a spurious node than silent deletion)
 * - LWW-Register for edge properties (most recent relationship state wins)
 */
export interface L3Graph {
  layer: 'L3';
  nodes: ORSetState<L3Entity>;
  edges: LWWRegisterState<L3Edge>;
}

// ---------------------------------------------------------------------------
// L2 — Topic-clustered summaries
// ---------------------------------------------------------------------------

/** A topic summary produced by an agent. */
export interface L2Summary {
  /** Topic identifier (used as dedupeKey). */
  topic: string;
  /** The summary text. */
  content: string;
  /** When this summary was produced. */
  timestamp: string;
}

/**
 * L2 stores topic-clustered summaries using a G-Set.
 * Summaries from different agents about different topics are all retained.
 * Summaries about the same topic are deduplicated using domain-aware merge.
 */
export type L2Summaries = GSetState<L2Summary>;

// ---------------------------------------------------------------------------
// L1 — Session context
// ---------------------------------------------------------------------------

/** A contextual exchange (compressed from raw messages). */
export interface L1Context {
  /** Which agent produced this context entry. */
  agentId: AgentId;
  /** Summary of the exchange. */
  summary: string;
  /** Original message IDs this context was derived from. */
  sourceMessageIds?: string[];
  /** Timestamp for ordering. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// L0 — Raw message buffer
// ---------------------------------------------------------------------------

/** A raw message in the agent communication log. */
export interface L0Message {
  /** Unique message identifier. */
  id: string;
  /** Agent that sent this message. */
  agentId: AgentId;
  /** Message role. */
  role: 'user' | 'assistant' | 'system';
  /** Message content. */
  content: string;
  /** Wall-clock timestamp (informational, not used for ordering). */
  timestamp: string;
  /** Causal predecessors — message IDs that this message is a response to. */
  causalPredecessors?: string[];
}

// ---------------------------------------------------------------------------
// Composite agent memory state
// ---------------------------------------------------------------------------

/** Union type for any memory layer. */
export type MemoryLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

/** Complete serialized state of an agent's memory across all layers. */
export interface AgentMemoryState {
  /** Agent that owns this memory state. */
  agentId: AgentId;
  /** Vector clock reflecting this agent's causal knowledge. */
  vectorClock: VectorClock;
  /** L4: Core invariants (LWW-Register). */
  l4: L4Invariants;
  /** L3: Entity-relationship graph (OR-Set + LWW-Register). */
  l3: L3Graph;
  /** L2: Topic-clustered summaries (G-Set). */
  l2: GSetState<L2Summary>;
  /** L1: Session context (RGA sequence). */
  l1: RGAState<L1Context>;
  /** L0: Raw message buffer (RGA sequence). */
  l0: RGAState<L0Message>;
}
