/**
 * Importance Detection — domain-agnostic importance scoring
 * using information-theoretic signals.
 *
 * Three signals, no domain hints required:
 *   1. State delta — entity-relationship graph mutations
 *   2. Reference frequency — retrospective citation analysis (PageRank-like)
 *   3. Trajectory discontinuity — embedding-space change-point detection
 *
 * This is a thin re-export of `@shorthand/core/importance`, not a local
 * implementation. PR #58 extracted compaction, CRDT, and importance scoring
 * into the vendored `@shorthand/core` package, but only compaction and CRDT
 * were actually switched over to re-export from it — this directory kept a
 * full duplicate copy of the importance-scoring source, which then drifted
 * (see CHANGELOG.md and docs/ecosystem/engineering-guide.md for the
 * history). Re-exporting here instead — matching how compaction and CRDT
 * already work — means there is exactly one copy of this logic, and it
 * cannot drift again.
 */
export {
  ImportanceDetector,
  EntityGraph,
  computeStateDelta,
  extractEntities,
  extractRelations,
  TrajectoryTracker,
  RunningStats,
  cosineSimilarity,
  cosineDistance,
  ReferenceGraph,
  DEFAULT_IMPORTANCE_CONFIG,
} from '@shorthand/core/importance';

export type {
  ConversationMessage,
  EntityNode,
  EntityRelation,
  StateDelta,
  MessageReference,
  ReferenceScore,
  TrajectoryPoint,
  ImportanceScore,
  ImportanceDetectorConfig,
  SignalWeights,
} from '@shorthand/core/importance';
