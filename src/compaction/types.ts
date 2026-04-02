/**
 * Compaction Verification Types — interfaces for multi-level conversation
 * state compaction and formal verification of compaction correctness.
 *
 * Draws on refinement checking from formal methods: a compacted state should
 * be a refinement of the original conversation — preserving all
 * decision-relevant information.
 *
 * Three verification strategies, in order of increasing rigor:
 *   1. Round-trip recall testing (practical eval harness)
 *   2. Invariant preservation proofs (semi-formal, mechanically checkable)
 *   3. Information-theoretic bounds (rate-distortion framework)
 */

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

/** A single message in a conversation. */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  /** Tool call metadata, if this message is a tool invocation or result. */
  toolCall?: {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
  };
  /** If this message corrects/supersedes a prior message, reference its ID. */
  supersedes?: string;
}

/** A full conversation history (the "ground truth"). */
export interface ConversationHistory {
  sessionId: string;
  messages: ConversationMessage[];
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Compaction levels — hierarchical summarization
// ---------------------------------------------------------------------------

/**
 * CompactionLevel — defines the depth of summarization.
 *
 * L0: Raw messages (no compaction)
 * L1: Within-turn deduplication and noise removal
 * L2: Cross-turn summarization (entity extraction, decision tracking)
 * L3: High-level state snapshot (entities + decisions + corrections only)
 */
export type CompactionLevel = 'L0' | 'L1' | 'L2' | 'L3';

/** A named entity extracted from the conversation. */
export interface ExtractedEntity {
  name: string;
  type: string;
  /** First message ID where this entity appeared. */
  firstMention: string;
  /** Most recent message ID referencing this entity. */
  lastMention: string;
  /** Current known value/state. */
  value: unknown;
  /** If this entity's value was corrected, track the correction chain. */
  corrections: EntityCorrection[];
}

/** A correction applied to an entity's value. */
export interface EntityCorrection {
  /** Message ID where the correction occurred. */
  messageId: string;
  previousValue: unknown;
  correctedValue: unknown;
  reason?: string;
}

/** A decision recorded during the conversation. */
export interface Decision {
  id: string;
  /** What was decided. */
  description: string;
  /** Message ID where this decision was made. */
  madeAt: string;
  /** What alternatives were considered and rejected. */
  alternatives: Array<{ description: string; reason: string }>;
  /** If this decision was later reversed or modified. */
  supersededBy?: string;
  /** Entity names involved in this decision. */
  involvedEntities: string[];
}

/** A tombstone — marks information that was explicitly invalidated. */
export interface Tombstone {
  /** The superseded content (summary or reference). */
  supersededContent: string;
  /** Message ID of the original information. */
  originalMessageId: string;
  /** Message ID of the correction/invalidation. */
  correctionMessageId: string;
  /** Why the information was invalidated. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Compacted state — the output of compaction
// ---------------------------------------------------------------------------

/** The compacted representation of a conversation at a given level. */
export interface CompactedState {
  /** Which compaction level produced this state. */
  level: CompactionLevel;
  /** Session this state belongs to. */
  sessionId: string;
  /** ISO timestamp when compaction was performed. */
  compactedAt: string;
  /** Number of compaction rounds applied (1 = first pass, N = Nth re-compaction). */
  roundNumber: number;
  /** Summarized text — the primary compacted representation. */
  summary: string;
  /** Entities extracted from the conversation. */
  entities: ExtractedEntity[];
  /** Decisions tracked through the conversation. */
  decisions: Decision[];
  /** Tombstones for invalidated information. */
  tombstones: Tombstone[];
  /** Original message count before compaction. */
  originalMessageCount: number;
  /** Token count of the compacted state (approximate). */
  compactedTokenCount: number;
  /** Token count of the original conversation (approximate). */
  originalTokenCount: number;
  /** Provenance: which message IDs contributed to this compacted state. */
  sourceMessageIds: string[];
}

// ---------------------------------------------------------------------------
// Strategy 1: Round-trip recall testing
// ---------------------------------------------------------------------------

/** A quiz question generated from the full conversation for recall testing. */
export interface RecallQuestion {
  id: string;
  /** The question text. */
  question: string;
  /** The ground-truth answer derived from the full conversation. */
  groundTruth: string;
  /** Which message IDs contain the answer. */
  sourceMessageIds: string[];
  /** Category of information being tested. */
  category: 'entity' | 'decision' | 'correction' | 'temporal' | 'tool_result' | 'rejection';
  /** Difficulty: how deep in the conversation the information is buried. */
  difficulty: 'easy' | 'medium' | 'hard';
}

/** Result of answering a single recall question using compacted state. */
export interface RecallAnswer {
  questionId: string;
  /** The answer produced using only the compacted state as context. */
  answer: string;
  /** Whether the answer is correct (matches ground truth semantically). */
  correct: boolean;
  /** Confidence score (0–1) of the correctness judgment. */
  confidence: number;
  /** If incorrect, what information was missing or wrong. */
  failureMode?: 'missing' | 'outdated' | 'hallucinated' | 'partial';
}

/** Aggregate result of a round-trip recall test. */
export interface RecallTestResult {
  /** The compacted state that was tested. */
  compactedState: CompactedState;
  /** All questions asked. */
  questions: RecallQuestion[];
  /** All answers received. */
  answers: RecallAnswer[];
  /** Overall recall score (fraction correct, 0–1). */
  recallScore: number;
  /** Recall broken down by category. */
  categoryScores: Record<RecallQuestion['category'], number>;
  /** Recall broken down by difficulty. */
  difficultyScores: Record<RecallQuestion['difficulty'], number>;
  /** Questions that failed — the most diagnostic output. */
  failures: RecallAnswer[];
}

// ---------------------------------------------------------------------------
// Strategy 2: Invariant preservation
// ---------------------------------------------------------------------------

/** An invariant that compaction must preserve. */
export interface CompactionInvariant {
  /** Unique identifier for this invariant. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** The category of property being checked. */
  category: 'correction_propagation' | 'entity_provenance' | 'decision_completeness' | 'tombstone_consistency' | 'temporal_ordering';
  /**
   * Check function: returns a violation report if the invariant is broken,
   * or null if it holds.
   */
  check(compacted: CompactedState, original: ConversationHistory): InvariantViolation | null;
}

/** A violation of a compaction invariant. */
export interface InvariantViolation {
  invariantId: string;
  /** Severity: 'error' = information loss, 'warning' = degraded quality. */
  severity: 'error' | 'warning';
  /** What went wrong. */
  message: string;
  /** Which entities/decisions are affected. */
  affectedItems: string[];
  /** Evidence: relevant message IDs from the original conversation. */
  evidence: string[];
}

/** Result of checking all invariants against a compacted state. */
export interface InvariantCheckResult {
  compactedState: CompactedState;
  /** All invariants that were checked. */
  invariantsChecked: string[];
  /** Violations found. */
  violations: InvariantViolation[];
  /** Whether all invariants passed (no errors — warnings are OK). */
  passed: boolean;
  /** Count of error-level violations. */
  errorCount: number;
  /** Count of warning-level violations. */
  warningCount: number;
}

// ---------------------------------------------------------------------------
// Strategy 3: Information-theoretic metrics
// ---------------------------------------------------------------------------

/** Entropy measurements for a conversation or compacted state. */
export interface EntropyMetrics {
  /** Shannon entropy of the token distribution (bits). */
  shannonEntropy: number;
  /** Unique token count. */
  vocabularySize: number;
  /** Total token count. */
  totalTokens: number;
  /** Type-token ratio (vocabularySize / totalTokens). */
  typeTokenRatio: number;
  /** Estimated bits of "decision-relevant" information. */
  decisionRelevantBits: number;
}

/**
 * Rate-distortion measurement: how much information survives compaction
 * relative to theoretical bounds.
 */
export interface RateDistortionMetrics {
  /** Bits retained in the compacted state. */
  retainedBits: number;
  /** Bits in the original conversation. */
  originalBits: number;
  /** Compression ratio (retained / original). */
  compressionRatio: number;
  /** Estimated distortion (information loss) on a 0–1 scale. */
  distortion: number;
  /** Theoretical minimum bits needed at this distortion level. */
  theoreticalMinBits: number;
  /** Whether the compacted state is above the theoretical minimum. */
  withinBounds: boolean;
  /** How far above/below the theoretical minimum (positive = headroom). */
  marginBits: number;
}

/** Entity-level information retention measurement. */
export interface EntityRetention {
  entityName: string;
  /** Whether the entity appears in the compacted state. */
  retained: boolean;
  /** Whether all corrections to this entity survived compaction. */
  correctionsIntact: boolean;
  /** Fraction of source messages about this entity reflected in compaction. */
  coverageFraction: number;
}

/** Complete information-theoretic analysis result. */
export interface InformationTheoreticResult {
  compactedState: CompactedState;
  /** Entropy of the original conversation. */
  originalEntropy: EntropyMetrics;
  /** Entropy of the compacted state. */
  compactedEntropy: EntropyMetrics;
  /** Rate-distortion analysis. */
  rateDistortion: RateDistortionMetrics;
  /** Per-entity retention analysis. */
  entityRetention: EntityRetention[];
  /** Overall information retention score (0–1). */
  retentionScore: number;
}

// ---------------------------------------------------------------------------
// Unified verification result
// ---------------------------------------------------------------------------

/** Combined result of all verification strategies applied to a compacted state. */
export interface VerificationResult {
  sessionId: string;
  compactedState: CompactedState;
  /** Strategy 1 results (null if not run). */
  recallTest: RecallTestResult | null;
  /** Strategy 2 results (null if not run). */
  invariantCheck: InvariantCheckResult | null;
  /** Strategy 3 results (null if not run). */
  informationTheoretic: InformationTheoreticResult | null;
  /** Overall pass/fail based on configured thresholds. */
  passed: boolean;
  /** Human-readable summary of all verification results. */
  summary: string;
  /** ISO timestamp of when verification was performed. */
  verifiedAt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the compaction verification harness. */
export interface CompactionVerificationConfig {
  /** Which strategies to run. */
  strategies: {
    recallTest: boolean;
    invariantCheck: boolean;
    informationTheoretic: boolean;
  };
  /** Minimum recall score to pass (Strategy 1). */
  minRecallScore: number;
  /** Whether warnings count as failures for invariant checks (Strategy 2). */
  warningsAreErrors: boolean;
  /** Minimum information retention score to pass (Strategy 3). */
  minRetentionScore: number;
  /** Number of recall questions to generate per category. */
  questionsPerCategory: number;
}

/** Default verification configuration. */
export const DEFAULT_VERIFICATION_CONFIG: CompactionVerificationConfig = {
  strategies: {
    recallTest: true,
    invariantCheck: true,
    informationTheoretic: true,
  },
  minRecallScore: 0.85,
  warningsAreErrors: false,
  minRetentionScore: 0.70,
  questionsPerCategory: 5,
};

// ---------------------------------------------------------------------------
// Compactor interface — the compaction engine contract
// ---------------------------------------------------------------------------

/** Interface for a conversation compactor. */
export interface Compactor {
  /** Compact a conversation to the specified level. */
  compact(history: ConversationHistory, level: CompactionLevel): Promise<CompactedState>;
  /** Re-compact an already-compacted state to a deeper level. */
  recompact(state: CompactedState, targetLevel: CompactionLevel): Promise<CompactedState>;
}

/** Interface for a recall question generator. */
export interface QuizGenerator {
  /** Generate recall questions from a full conversation. */
  generateQuestions(
    history: ConversationHistory,
    questionsPerCategory: number,
  ): RecallQuestion[];
}

/** Interface for answering recall questions using compacted state. */
export interface QuizEvaluator {
  /** Answer a recall question using only the compacted state. */
  evaluate(
    question: RecallQuestion,
    compactedState: CompactedState,
  ): RecallAnswer;
}
