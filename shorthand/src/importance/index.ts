/**
 * Importance Detection — domain-agnostic importance scoring
 * using information-theoretic signals.
 *
 * Three signals, no domain hints required:
 *   1. State delta — entity-relationship graph mutations
 *   2. Reference frequency — retrospective citation analysis (PageRank-like)
 *   3. Trajectory discontinuity — embedding-space change-point detection
 */

export { ImportanceDetector } from './importance-detector.js';
export { EntityGraph, computeStateDelta, extractEntities, extractRelations } from './state-delta.js';
export { TrajectoryTracker, RunningStats, cosineSimilarity, cosineDistance } from './trajectory-discontinuity.js';
export { ReferenceGraph } from './reference-frequency.js';

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
} from './types.js';

export { DEFAULT_IMPORTANCE_CONFIG } from './types.js';
