/**
 * Compaction — two pipelines over one message type.
 *
 * - LSM pipeline (`CompactionEngine`, `RegexCompactor`): incremental,
 *   token-budgeted compaction of a live conversation into L0–L4
 *   (`CompactedState`) and context frames (typed sections with provenance,
 *   rendered by one escaping renderer).
 * - Snapshot pipeline (`DefaultCompactor`): compacts a whole
 *   `ConversationHistory` into one `CompactedSnapshot` at L0–L3, with three
 *   verification strategies (recall testing, invariant checks,
 *   information-theoretic bounds) and the `VerificationHarness`.
 */

// Shared types
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
  Decision,
  Invariant,
  TopicSummary,
  VerificationResult,
} from '../types.js';
export { CompactionLevel, DEFAULT_COMPACTION_CONFIG, normalizeTimestamp } from '../types.js';

// LSM pipeline
export { RegexCompactor } from './regex-compactor.js';
export { CompactionEngine } from './compaction-engine.js';
export type { CorrectionInput } from './compaction-engine.js';

// Frames: the single escaping renderer
export { escapeUntrusted, renderContextFrame } from './frame.js';
export type { EscapeOptions } from './frame.js';

// Corrections: the shared supersession matcher and level-complete application
export { statesOnlySuperseded, isValidCorrectionSubject } from './matching.js';
export { applyTombstone, revertTombstone, retractMessages } from './corrections.js';
export type { ApplyTombstoneOptions } from './corrections.js';

// Snapshot pipeline — types
export type {
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
} from './snapshot/types.js';
export { DEFAULT_VERIFICATION_CONFIG } from './snapshot/types.js';

// Snapshot pipeline — compactor
export {
  DefaultCompactor,
  estimateTokens,
  estimateConversationTokens,
  extractEntities,
  extractDecisions,
  detectTombstones,
} from './snapshot/compactor.js';

// Strategy 1: Recall testing
export {
  DefaultQuizGenerator,
  DefaultQuizEvaluator,
  tokenOverlapScore,
  runRecallTest,
} from './snapshot/recall-test.js';

// Strategy 2: Invariant checking (pluggable — pass your own invariants)
export {
  correctionPropagation,
  entityProvenance,
  decisionCompleteness,
  tombstoneConsistency,
  temporalOrdering,
  BUILTIN_INVARIANTS,
  checkInvariants,
} from './snapshot/invariant-check.js';

// Strategy 3: Information-theoretic
export {
  tokenize,
  shannonEntropy,
  totalInformationBits,
  computeEntropyMetrics,
  computeRateDistortion,
  measureEntityRetention,
  analyzeInformationTheoretic,
} from './snapshot/information-theoretic.js';

// Verification harness
export { VerificationHarness } from './snapshot/verification-harness.js';
