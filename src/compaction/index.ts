/**
 * Compaction Verification Module
 *
 * Provides multi-level conversation state compaction with formal verification
 * of compaction correctness using three complementary strategies:
 *
 *   1. Round-trip recall testing (practical eval harness)
 *   2. Invariant preservation proofs (semi-formal, mechanically checkable)
 *   3. Information-theoretic bounds (rate-distortion framework)
 */

// Types
export type {
  CompactedState,
  CompactionInvariant,
  CompactionLevel,
  CompactionVerificationConfig,
  Compactor,
  ConversationHistory,
  ConversationMessage,
  Decision,
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
  Tombstone,
  VerificationResult,
} from './types.js';

export { DEFAULT_VERIFICATION_CONFIG } from './types.js';

// Compactor
export {
  DefaultCompactor,
  estimateTokens,
  estimateConversationTokens,
  extractEntities,
  extractDecisions,
  detectTombstones,
} from './compactor.js';

// Strategy 1: Recall testing
export {
  DefaultQuizGenerator,
  DefaultQuizEvaluator,
  tokenOverlapScore,
  runRecallTest,
} from './recall-test.js';

// Strategy 2: Invariant checking
export {
  correctionPropagation,
  entityProvenance,
  decisionCompleteness,
  tombstoneConsistency,
  temporalOrdering,
  BUILTIN_INVARIANTS,
  checkInvariants,
} from './invariant-check.js';

// Strategy 3: Information-theoretic
export {
  tokenize,
  shannonEntropy,
  totalInformationBits,
  computeEntropyMetrics,
  computeRateDistortion,
  measureEntityRetention,
  analyzeInformationTheoretic,
} from './information-theoretic.js';

// Verification harness
export { VerificationHarness } from './verification-harness.js';
