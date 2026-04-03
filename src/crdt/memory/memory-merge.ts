/**
 * MemoryMerge — orchestrates merging multiple agents' memory states.
 *
 * This is the coordination layer that sits above individual CRDT merges.
 * It tracks which agents' states have been incorporated, detects semantic
 * conflicts (via ConflictDetector), and produces a unified merged memory.
 *
 * Because all underlying CRDTs are commutative, associative, and idempotent,
 * merges can happen in any order with any subset of agents and will always
 * converge to the same final state. No central coordinator needed.
 */

import type { AgentId, VectorClock } from '../types.js';
import { compareVectorClocks, mergeVectorClocks } from '../clock.js';
import { AgentMemory } from './agent-memory.js';
import type { AgentMemoryState } from './types.js';
import { ConflictDetector, type SemanticConflict } from './conflict-detector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a multi-agent memory merge. */
export interface MergeReport {
  /** The merged memory state. */
  mergedState: AgentMemoryState;
  /** Agents whose states were incorporated. */
  mergedAgents: AgentId[];
  /** Semantic conflicts detected during merge. */
  conflicts: SemanticConflict[];
  /** Whether any CRDT state actually changed. */
  hadChanges: boolean;
  /** Per-layer change flags. */
  layerChanges: {
    l4: boolean;
    l3: boolean;
    l2: boolean;
    l1: boolean;
    l0: boolean;
  };
}

/** Options for the merge operation. */
export interface MergeOptions {
  /** If true, don't actually apply the merge — just detect conflicts. */
  dryRun?: boolean;
  /** Similarity threshold for semantic conflict detection (0-1). Default 0.7. */
  conflictThreshold?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class MemoryMerge {
  private conflictDetector: ConflictDetector;

  constructor(conflictDetector?: ConflictDetector) {
    this.conflictDetector = conflictDetector ?? new ConflictDetector();
  }

  /**
   * Merge multiple agent memory states into a single target memory.
   * The target is typically the local agent's memory.
   *
   * Because CRDTs guarantee convergence, the merge order doesn't matter.
   * However, we process agents in a deterministic order (sorted by ID)
   * to make debugging easier.
   */
  mergeAll(
    target: AgentMemory,
    remoteStates: AgentMemoryState[],
    options: MergeOptions = {},
  ): MergeReport {
    const { dryRun = false, conflictThreshold = 0.7 } = options;

    // Sort by agent ID for deterministic ordering
    const sorted = [...remoteStates].sort((a, b) => a.agentId.localeCompare(b.agentId));

    const mergedAgents: AgentId[] = [];
    let hadChanges = false;
    const layerChanges = { l4: false, l3: false, l2: false, l1: false, l0: false };

    // Detect semantic conflicts before merging
    const allConflicts: SemanticConflict[] = [];

    // Check each pair of remote states for conflicts
    for (let i = 0; i < sorted.length; i++) {
      const conflicts = this.conflictDetector.detectConflicts(
        target.serialize(),
        sorted[i],
        conflictThreshold,
      );
      allConflicts.push(...conflicts);
    }

    // Also check remote states against each other
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const conflicts = this.conflictDetector.detectConflicts(
          sorted[i],
          sorted[j],
          conflictThreshold,
        );
        allConflicts.push(...conflicts);
      }
    }

    // Deduplicate conflicts
    const uniqueConflicts = this.deduplicateConflicts(allConflicts);

    if (!dryRun) {
      for (const remote of sorted) {
        // Track per-layer changes by comparing before/after
        const beforeL4 = JSON.stringify(target.l4.serialize());
        const beforeL3Nodes = JSON.stringify(target.l3Nodes.serialize());
        const beforeL3Edges = JSON.stringify(target.l3Edges.serialize());
        const beforeL2 = JSON.stringify(target.l2.serialize());
        const beforeL1 = JSON.stringify(target.l1.serialize());
        const beforeL0 = JSON.stringify(target.l0.serialize());

        const changed = target.mergeFrom(remote);

        if (changed) {
          hadChanges = true;
          mergedAgents.push(remote.agentId);

          // Check which layers changed
          if (JSON.stringify(target.l4.serialize()) !== beforeL4) layerChanges.l4 = true;
          if (JSON.stringify(target.l3Nodes.serialize()) !== beforeL3Nodes) layerChanges.l3 = true;
          if (JSON.stringify(target.l3Edges.serialize()) !== beforeL3Edges) layerChanges.l3 = true;
          if (JSON.stringify(target.l2.serialize()) !== beforeL2) layerChanges.l2 = true;
          if (JSON.stringify(target.l1.serialize()) !== beforeL1) layerChanges.l1 = true;
          if (JSON.stringify(target.l0.serialize()) !== beforeL0) layerChanges.l0 = true;
        }
      }
    }

    return {
      mergedState: target.serialize(),
      mergedAgents,
      conflicts: uniqueConflicts,
      hadChanges,
      layerChanges,
    };
  }

  /**
   * Pairwise merge: merge a single remote state into the target.
   * Simpler API for two-agent scenarios.
   */
  mergePair(
    target: AgentMemory,
    remote: AgentMemoryState,
    options: MergeOptions = {},
  ): MergeReport {
    return this.mergeAll(target, [remote], options);
  }

  /**
   * Check if two agent memory states are causally related or concurrent.
   */
  causalRelation(
    a: AgentMemoryState,
    b: AgentMemoryState,
  ): 'before' | 'after' | 'equal' | 'concurrent' {
    return compareVectorClocks(a.vectorClock, b.vectorClock);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Deduplicate conflicts by their description. */
  private deduplicateConflicts(conflicts: SemanticConflict[]): SemanticConflict[] {
    const seen = new Set<string>();
    return conflicts.filter(c => {
      const key = `${c.layer}:${c.key}:${c.agentA}:${c.agentB}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
