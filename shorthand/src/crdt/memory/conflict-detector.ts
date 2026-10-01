/**
 * ConflictDetector — semantic conflict detection for agent memory merges.
 *
 * CRDTs guarantee syntactic convergence — the data structures merge cleanly.
 * But they cannot detect that agent A decided REST while agent B decided
 * GraphQL for the same API. That's a semantic conflict.
 *
 * This detector compares memory states across agents to identify:
 * 1. L4 invariant conflicts — same key, different values written concurrently
 * 2. L3 graph contradictions — contradictory edges written concurrently
 * 3. L2 summary divergence — same topic, structurally incompatible summaries
 *
 * L4 and L3 entries carry the writer's vector clock, so an overwrite made
 * after the writer had seen the other value (a causal overwrite — an
 * ordinary update) is not a conflict. Only concurrent writes are reported.
 * Entries from pre-1.0 states carry no vector clock and are treated as
 * concurrent. L2 has no causal metadata; its check stays structural.
 *
 * For full semantic conflict detection, an embedding pipeline would compare
 * subgraphs in embedding space. This implementation provides the structural
 * detection layer that can be extended with embeddings.
 */

import type { AgentId } from '../types.js';
import type { AgentMemoryState } from './types.js';
import { isLWWTombstone, type LWWEntry } from '../lww-register.js';
import { canonicalJson } from '../wire.js';

/** Whether `a` is in the causal past of `b` (b's writer had seen a). */
function happenedBefore<V>(a: LWWEntry<V>, b: LWWEntry<V>): boolean {
  return b.vc !== undefined && (b.vc[a.timestamp.agentId] ?? 0) >= a.timestamp.counter;
}

/**
 * Whether two entries for one key were written concurrently: neither
 * writer had seen the other's write. Two entries with the same timestamp
 * but different content (two writers sharing a replica id) count as
 * concurrent.
 */
function concurrentWrites<V>(a: LWWEntry<V>, b: LWWEntry<V>): boolean {
  if (a.timestamp.counter === b.timestamp.counter && a.timestamp.agentId === b.timestamp.agentId) {
    return true;
  }
  return !happenedBefore(a, b) && !happenedBefore(b, a);
}

function sameContent<V>(a: LWWEntry<V>, b: LWWEntry<V>): boolean {
  const aDeleted = isLWWTombstone(a);
  if (aDeleted !== isLWWTombstone(b)) return false;
  return aDeleted || canonicalJson(a.value) === canonicalJson(b.value);
}

function describeValue<V>(entry: LWWEntry<V>): string {
  return isLWWTombstone(entry) ? '(deleted)' : String(entry.value);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity levels for semantic conflicts. */
export type ConflictSeverity = 'info' | 'warning' | 'critical';

/** A detected semantic conflict between two agents' memory states. */
export interface SemanticConflict {
  /** Which memory layer the conflict was detected in. */
  layer: 'L4' | 'L3' | 'L2';
  /** Conflict severity. */
  severity: ConflictSeverity;
  /** The key/identifier where the conflict occurs. */
  key: string;
  /** Agent A's value. */
  valueA: string;
  /** Agent B's value. */
  valueB: string;
  /** Agent A's ID. */
  agentA: AgentId;
  /** Agent B's ID. */
  agentB: AgentId;
  /** Human-readable description of the conflict. */
  description: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ConflictDetector {
  /**
   * Detect semantic conflicts between two agent memory states.
   *
   * @param stateA — first agent's memory state
   * @param stateB — second agent's memory state
   * @param _threshold — similarity threshold for fuzzy matching (reserved for embedding-based detection)
   */
  detectConflicts(
    stateA: AgentMemoryState,
    stateB: AgentMemoryState,
    _threshold = 0.7,
  ): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    conflicts.push(...this.detectL4Conflicts(stateA, stateB));
    conflicts.push(...this.detectL3Conflicts(stateA, stateB));
    conflicts.push(...this.detectL2Conflicts(stateA, stateB));

    return conflicts;
  }

  // -------------------------------------------------------------------------
  // L4: Invariant conflicts
  // -------------------------------------------------------------------------

  /**
   * Detect L4 conflicts: same invariant key, different values, written
   * concurrently. This is the clearest form of conflict — agent A says
   * "database=PostgreSQL" while agent B, without having seen it, says
   * "database=SQLite". An update made after seeing the old value is not
   * reported.
   *
   * Note: LWW-Register will resolve this by timestamp, but we still flag it
   * so humans can review whether the resolution was correct.
   */
  private detectL4Conflicts(
    stateA: AgentMemoryState,
    stateB: AgentMemoryState,
  ): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];
    const entriesA = stateA.l4.state.entries;
    const entriesB = stateB.l4.state.entries;

    for (const [key, entryA] of Object.entries(entriesA)) {
      const entryB = entriesB[key];
      if (!entryB) continue;

      // Same key, different values, neither write saw the other → conflict
      if (!sameContent(entryA, entryB) && concurrentWrites(entryA, entryB)) {
        const valueA = describeValue(entryA);
        const valueB = describeValue(entryB);
        conflicts.push({
          layer: 'L4',
          severity: 'critical',
          key,
          valueA,
          valueB,
          agentA: stateA.agentId,
          agentB: stateB.agentId,
          description: `Invariant "${key}" was written concurrently: agent ${stateA.agentId} says "${valueA}" but agent ${stateB.agentId} says "${valueB}". LWW resolves to the later timestamp.`,
        });
      }
    }

    return conflicts;
  }

  // -------------------------------------------------------------------------
  // L3: Graph contradictions
  // -------------------------------------------------------------------------

  /**
   * Detect L3 conflicts: contradictory edges between the same entity pair,
   * written concurrently. E.g., agent A says "API → REST" while agent B
   * says "API → GraphQL" for the same from/to pair. Deleted edges are not
   * compared.
   */
  private detectL3Conflicts(
    stateA: AgentMemoryState,
    stateB: AgentMemoryState,
  ): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];
    const edgesA = stateA.l3.edges.entries;
    const edgesB = stateB.l3.edges.entries;

    for (const [key, entryA] of Object.entries(edgesA)) {
      const entryB = edgesB[key];
      if (!entryB) continue;
      if (isLWWTombstone(entryA) || isLWWTombstone(entryB)) continue;
      if (!concurrentWrites(entryA, entryB)) continue;

      const edgeA = entryA.value!;
      const edgeB = entryB.value!;

      // Same edge key but different relation or properties
      if (edgeA.from === edgeB.from && edgeA.to === edgeB.to) {
        if (edgeA.relation !== edgeB.relation) {
          conflicts.push({
            layer: 'L3',
            severity: 'warning',
            key,
            valueA: `${edgeA.from} -[${edgeA.relation}]-> ${edgeA.to}`,
            valueB: `${edgeB.from} -[${edgeB.relation}]-> ${edgeB.to}`,
            agentA: stateA.agentId,
            agentB: stateB.agentId,
            description: `Edge "${key}" has conflicting relations: "${edgeA.relation}" vs "${edgeB.relation}" between ${edgeA.from} and ${edgeA.to}.`,
          });
        }

        // Check property conflicts
        if (edgeA.properties && edgeB.properties) {
          for (const [propKey, propValA] of Object.entries(edgeA.properties)) {
            const propValB = edgeB.properties[propKey];
            if (propValB !== undefined && propValA !== propValB) {
              conflicts.push({
                layer: 'L3',
                severity: 'warning',
                key: `${key}.${propKey}`,
                valueA: propValA,
                valueB: propValB,
                agentA: stateA.agentId,
                agentB: stateB.agentId,
                description: `Edge property "${propKey}" on "${key}" differs: "${propValA}" vs "${propValB}".`,
              });
            }
          }
        }
      }
    }

    return conflicts;
  }

  // -------------------------------------------------------------------------
  // L2: Summary divergence
  // -------------------------------------------------------------------------

  /**
   * Detect L2 conflicts: same topic, structurally different summaries.
   *
   * For true semantic detection, you'd compare summaries in embedding space.
   * This structural detector flags cases where the same dedupeKey has
   * summaries from different agents — a signal that the G-Set merge function
   * had to choose a winner.
   */
  private detectL2Conflicts(
    stateA: AgentMemoryState,
    stateB: AgentMemoryState,
  ): SemanticConflict[] {
    const conflicts: SemanticConflict[] = [];

    // Build topic maps from each agent's summaries
    const topicsA = new Map<string, string>();
    const topicsB = new Map<string, string>();

    for (const entry of stateA.l2.entries) {
      if (entry.dedupeKey) {
        topicsA.set(entry.dedupeKey, entry.value.content);
      }
    }

    for (const entry of stateB.l2.entries) {
      if (entry.dedupeKey) {
        topicsB.set(entry.dedupeKey, entry.value.content);
      }
    }

    // Compare shared topics
    for (const [topic, contentA] of topicsA) {
      const contentB = topicsB.get(topic);
      if (contentB === undefined) continue;

      if (contentA !== contentB) {
        // Structural divergence — same topic, different content
        const similarity = this.jaccard(contentA, contentB);

        // Only flag if the summaries are somewhat similar (suggesting same
        // topic) but not identical (which would be fine)
        if (similarity < 0.9) {
          conflicts.push({
            layer: 'L2',
            severity: similarity < 0.3 ? 'warning' : 'info',
            key: topic,
            valueA: contentA.slice(0, 200),
            valueB: contentB.slice(0, 200),
            agentA: stateA.agentId,
            agentB: stateB.agentId,
            description: `Topic "${topic}" has divergent summaries (similarity: ${(similarity * 100).toFixed(0)}%). G-Set merge function selects the preferred version.`,
          });
        }
      }
    }

    return conflicts;
  }

  // -------------------------------------------------------------------------
  // Similarity helpers
  // -------------------------------------------------------------------------

  /**
   * Jaccard similarity between two strings (word-level).
   * A simple structural proxy for semantic similarity.
   * In production, this would be replaced by embedding cosine similarity.
   */
  private jaccard(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }
}
