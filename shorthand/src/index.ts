/**
 * @shorthand/core — Progressive context compaction for LLMs
 *
 * LSM-tree-inspired conversation state management with CRDT-based
 * multi-agent shared memory and information-theoretic importance detection.
 */

// Shared types
export type { ConversationMessage } from './types.js';
export { normalizeTimestamp } from './types.js';

// Compaction
export * from './compaction/index.js';

// CRDTs
export * from './crdt/index.js';

// Importance detection — re-export explicitly to avoid name collision
// with compaction's extractEntities
export { ImportanceDetector } from './importance/importance-detector.js';
export {
  EntityGraph,
  computeStateDelta,
  extractEntities as extractImportanceEntities,
  extractRelations,
} from './importance/state-delta.js';
export { TrajectoryTracker, RunningStats, cosineSimilarity, cosineDistance } from './importance/trajectory-discontinuity.js';
export { ReferenceGraph } from './importance/reference-frequency.js';
export type {
  EntityNode,
  EntityRelation,
  StateDelta,
  MessageReference,
  ReferenceScore,
  TrajectoryPoint,
  ImportanceScore,
  ImportanceDetectorConfig,
  SignalWeights,
} from './importance/types.js';
export { DEFAULT_IMPORTANCE_CONFIG } from './importance/types.js';
