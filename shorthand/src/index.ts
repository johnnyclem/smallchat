/**
 * @shorthand/core
 *
 * Progressive context compaction for LLMs.
 * Old computer science for new constraints.
 *
 * The root barrel re-exports every runtime module. Each module is also
 * importable on its own subpath: `@shorthand/core/compaction`, `/crdt`,
 * `/importance`, `/truth`, `/wiki`, `/ingestion`, `/interpreter`,
 * `/verification`. The context-shift benchmark is a dev tool and lives
 * only on `@shorthand/core/benchmark`.
 */

// Core types
export type {
  ConversationMessage,
  MessageRole,
  CompactedState,
  CompactedEntry,
  CodeSpan,
  ArchivedItem,
  ArchiveReason,
  CompactionConfig,
  Compactor,
  CompactorTier,
  ContextFrame,
  ContextSection,
  ContextSectionKind,
  ContextItem,
  Tombstone,
  Entity,
  EntityType,
  Edge,
  EdgeRelation,
  KnowledgeGraph,
  Decision,
  TopicSummary,
  Invariant,
  VerificationResult,
  AgentProfile,
  Source,
  IngestionConfig,
  IngestionEvent,
  WikiPage,
  WikiRenderConfig,
  ActiveEngram,
  ActivationPolicy,
  ActiveEngramResult,
} from './types.js';

export {
  CompactionLevel,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_INGESTION_CONFIG,
  DEFAULT_WIKI_RENDER_CONFIG,
  normalizeTimestamp,
} from './types.js';

// Compaction — LSM pipeline (CompactionEngine, RegexCompactor) and
// snapshot pipeline (DefaultCompactor + verification strategies)
export {
  CompactionEngine,
  RegexCompactor,
  escapeUntrusted,
  renderContextFrame,
  statesOnlySuperseded,
  isValidCorrectionSubject,
  applyTombstone,
  revertTombstone,
  retractMessages,
  DefaultCompactor,
  estimateConversationTokens,
  extractEntities,
  extractDecisions,
  detectTombstones,
  DefaultQuizGenerator,
  DefaultQuizEvaluator,
  tokenOverlapScore,
  runRecallTest,
  correctionPropagation,
  entityProvenance,
  decisionCompleteness,
  tombstoneConsistency,
  temporalOrdering,
  BUILTIN_INVARIANTS,
  checkInvariants,
  tokenize,
  shannonEntropy,
  totalInformationBits,
  computeEntropyMetrics,
  computeRateDistortion,
  measureEntityRetention,
  analyzeInformationTheoretic,
  VerificationHarness,
  DEFAULT_VERIFICATION_CONFIG,
} from './compaction/index.js';
export type {
  CorrectionInput,
  EscapeOptions,
  ApplyTombstoneOptions,
  CompactedSnapshot,
  CompactionInvariant,
  BuiltinInvariantCategory,
  SnapshotLevel,
  CompactionVerificationConfig,
  SnapshotCompactor,
  ConversationHistory,
  SnapshotDecision,
  EntityCorrection,
  EntityRetention,
  EntropyMetrics,
  ExtractedEntity,
  InformationTheoreticResult,
  InvariantCheckResult,
  InvariantViolation,
  QuizEvaluator,
  QuizGenerator,
  RateDistortionMetrics,
  RecallAnswer,
  RecallQuestion,
  RecallTestResult,
  SnapshotVerificationResult,
} from './compaction/index.js';

// CRDTs + agential memory
export * from './crdt/index.js';

// Importance detection — compaction's extractEntities keeps the bare name;
// the importance extractor is re-exported as extractImportanceEntities.
export {
  ImportanceDetector,
  EntityGraph,
  computeStateDelta,
  extractEntities as extractImportanceEntities,
  extractRelations,
  TrajectoryTracker,
  RunningStats,
  cosineSimilarity,
  cosineDistance,
  ReferenceGraph,
  DEFAULT_IMPORTANCE_CONFIG,
} from './importance/index.js';
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
} from './importance/index.js';

// Truth-ledger interop (stenographer TB/UV, JSONL seam)
export * from './truth/index.js';

// Interpreter (bounded LM step at retrieval time)
export * from './interpreter/index.js';

// Verification of LSM compacted state
export * from './verification/index.js';

// Embedding (stub)
export { StubEmbedder } from './embedding/index.js';
export type { Embedder, EmbeddingResult } from './embedding/index.js';

// Source ingestion
export * from './ingestion/index.js';

// Wiki rendering
export * from './wiki/index.js';

// Utilities
export { estimateTokens, generateId } from './utils.js';
