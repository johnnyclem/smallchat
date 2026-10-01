/** smallchat's src/importance/index.ts re-exports, exactly (see smallchat-reexports.ts). */
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
