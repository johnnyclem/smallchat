/**
 * AgentMemory — per-agent memory state manager across all compaction levels.
 *
 * Each agent maintains a local AgentMemory instance. The memory can be
 * serialized, transmitted, and merged with other agents' memories using
 * CRDT merge semantics — guaranteeing convergence without coordination.
 */

import type { AgentId, VectorClock } from '../types.js';
import { tickVectorClock, mergeVectorClocks, createVectorClock } from '../clock.js';
import { LWWRegister } from '../lww-register.js';
import { ORSet } from '../or-set.js';
import { GSet } from '../g-set.js';
import type { GSetEntry } from '../g-set.js';
import { RGA } from '../rga.js';
import type {
  AgentMemoryState,
  L3Entity,
  L3Edge,
  L2Summary,
  L1Context,
  L0Message,
} from './types.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class AgentMemory {
  readonly agentId: AgentId;
  private vectorClock: VectorClock;

  /** L4: Core invariants — LWW-Register<string>. */
  readonly l4: LWWRegister<string>;
  /** L3: Entity-relationship graph — nodes as OR-Set, edges as LWW-Register. */
  readonly l3Nodes: ORSet<L3Entity>;
  readonly l3Edges: LWWRegister<L3Edge>;
  /** L2: Topic-clustered summaries — G-Set. */
  readonly l2: GSet<L2Summary>;
  /** L1: Session context — RGA sequence. */
  readonly l1: RGA<L1Context>;
  /** L0: Raw message buffer — RGA sequence. */
  readonly l0: RGA<L0Message>;

  constructor(agentId: AgentId) {
    this.agentId = agentId;
    this.vectorClock = createVectorClock(agentId, 0);

    this.l4 = new LWWRegister<string>(agentId);
    this.l3Nodes = new ORSet<L3Entity>(agentId);
    this.l3Edges = new LWWRegister<L3Edge>(agentId);
    this.l2 = new GSet<L2Summary>();
    this.l1 = new RGA<L1Context>(agentId);
    this.l0 = new RGA<L0Message>(agentId);
  }

  // -------------------------------------------------------------------------
  // L4: Core invariant operations
  // -------------------------------------------------------------------------

  /** Set a core invariant (e.g., "database" → "PostgreSQL"). */
  setInvariant(key: string, value: string): void {
    this.l4.set(key, value);
    this.tick();
  }

  /** Get a core invariant value. */
  getInvariant(key: string): string | undefined {
    return this.l4.get(key);
  }

  /** Get all invariants. */
  getInvariants(): Map<string, string> {
    return this.l4.value();
  }

  // -------------------------------------------------------------------------
  // L3: Knowledge graph operations
  // -------------------------------------------------------------------------

  /** Add an entity to the knowledge graph. */
  addEntity(entity: L3Entity): void {
    this.l3Nodes.add(entity);
    this.tick();
  }

  /** Remove an entity from the knowledge graph. */
  removeEntity(entity: L3Entity): void {
    this.l3Nodes.remove(entity);
    this.tick();
  }

  /** Add or update an edge in the knowledge graph. */
  setEdge(edgeKey: string, edge: L3Edge): void {
    this.l3Edges.set(edgeKey, edge);
    this.tick();
  }

  /** Get all entities in the graph. */
  getEntities(): Set<L3Entity> {
    return this.l3Nodes.value();
  }

  /** Get all edges in the graph. */
  getEdges(): Map<string, L3Edge> {
    return this.l3Edges.value() as Map<string, L3Edge>;
  }

  // -------------------------------------------------------------------------
  // L2: Summary operations
  // -------------------------------------------------------------------------

  /** Add a topic summary. */
  addSummary(
    topic: string,
    content: string,
    isDirectParticipant: boolean,
  ): void {
    const entry: GSetEntry<L2Summary> = {
      value: {
        topic,
        content,
        timestamp: new Date().toISOString(),
      },
      sourceAgent: this.agentId,
      isDirectParticipant,
      dedupeKey: topic,
    };
    this.l2.add(entry);
    this.tick();
  }

  /** Get all summaries. */
  getSummaries(): GSetEntry<L2Summary>[] {
    return this.l2.value();
  }

  // -------------------------------------------------------------------------
  // L1: Session context operations
  // -------------------------------------------------------------------------

  /** Append a context entry to the session log. */
  appendContext(summary: string, sourceMessageIds?: string[]): void {
    this.l1.append({
      agentId: this.agentId,
      summary,
      sourceMessageIds,
      timestamp: new Date().toISOString(),
    });
    this.tick();
  }

  /** Get the ordered session context. */
  getContext(): L1Context[] {
    return this.l1.value();
  }

  // -------------------------------------------------------------------------
  // L0: Raw message operations
  // -------------------------------------------------------------------------

  /** Append a raw message to the buffer. */
  appendMessage(
    id: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    causalPredecessors?: string[],
  ): void {
    this.l0.append({
      id,
      agentId: this.agentId,
      role,
      content,
      timestamp: new Date().toISOString(),
      causalPredecessors,
    });
    this.tick();
  }

  /** Get the ordered message history. */
  getMessages(): L0Message[] {
    return this.l0.value();
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  /** Serialize the full agent memory state. */
  serialize(): AgentMemoryState {
    return {
      agentId: this.agentId,
      vectorClock: { ...this.vectorClock },
      l4: { layer: 'L4', state: this.l4.serialize() },
      l3: {
        layer: 'L3',
        nodes: this.l3Nodes.serialize(),
        edges: this.l3Edges.serialize(),
      },
      l2: this.l2.serialize(),
      l1: this.l1.serialize(),
      l0: this.l0.serialize(),
    };
  }

  /**
   * Merge a remote agent's memory state into this agent's memory.
   * All CRDT layers merge independently and converge regardless of order.
   * Returns true if any layer changed.
   */
  mergeFrom(remote: AgentMemoryState): boolean {
    const changes = [
      this.l4.merge(remote.l4.state),
      this.l3Nodes.merge(remote.l3.nodes),
      this.l3Edges.merge(remote.l3.edges),
      this.l2.merge(remote.l2),
      this.l1.merge(remote.l1),
      this.l0.merge(remote.l0),
    ];

    this.vectorClock = mergeVectorClocks(this.vectorClock, remote.vectorClock);

    return changes.some(Boolean);
  }

  /** Get the current vector clock. */
  getVectorClock(): VectorClock {
    return { ...this.vectorClock };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private tick(): void {
    this.vectorClock = tickVectorClock(this.vectorClock, this.agentId);
  }

  /** Create an AgentMemory from a serialized state. */
  static from(state: AgentMemoryState): AgentMemory {
    const mem = new AgentMemory(state.agentId);
    mem.mergeFrom(state);
    return mem;
  }
}
