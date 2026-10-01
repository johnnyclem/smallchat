/**
 * smallchat's re-exports of @shorthand/core, copied exactly from the
 * blocks its src/index.ts ships today (src/importance/index.ts's are in
 * smallchat-importance.ts). Typechecked against the packed package by
 * scripts/pack-smoke.mjs and against the source by
 * src/package-surface.test.ts, so a removed or renamed value or type fails
 * here before smallchat sees it (SH-REV-C3).
 *
 * The blocks compile, but five compaction type names changed meaning in
 * 1.0 (MIGRATION.md, "snapshot types were renamed"): the last section pins
 * what each name now denotes, so neither side can drift silently.
 */

// ---- smallchat src/index.ts: compaction ----
export {
  DefaultCompactor,
  estimateTokens,
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
} from '@shorthand/core/compaction';
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
} from '@shorthand/core/compaction';
export type { VerificationResult as CompactionVerificationResult } from '@shorthand/core/compaction';

// ---- smallchat src/index.ts: truth ----
export {
  CONSUMPTION_RULES,
  isAnonymousIdentity,
  assertAccountableAuthor,
  ulid,
  wikiLineToEntry,
  entryToWikiLine,
  parseWikiLines,
  serializeWikiEntries,
  readWikiFile,
  writeWikiFile,
  classifyEntry,
  selectCurrentTruth,
  renderTruthSection,
  applyTruthToCompactedState,
  TruthAwareCompactor,
  truthToInvariantRecords,
  proposeInvariants,
  serializeProposals,
  appendProposalsFile,
} from '@shorthand/core/truth';
export type {
  TruthConfidence,
  TbStatus,
  UvStatus,
  TruthEvidence,
  TruthVerifyBy,
  WikiEntryLine,
  TruthTbEntry,
  TruthUvEntry,
  TruthLedgerEntry,
  ConsumptionAction,
  TruthSelection,
  CompactedTruth,
  InvariantProposalLine,
  WikiParseResult,
  TruthInvariantRecord,
  ProposeInvariantsOptions,
} from '@shorthand/core/truth';

// ---- smallchat src/index.ts: crdt ----
export {
  LamportClock,
  compareLamport,
  createVectorClock,
  tickVectorClock,
  mergeVectorClocks,
  compareVectorClocks,
  LWWRegister,
  ORSet,
  GSet,
  defaultMergeFn,
  RGA,
  AgentMemory,
  MemoryMerge,
  ConflictDetector,
} from '@shorthand/core/crdt';
export type {
  AgentId,
  LamportTimestamp,
  VectorClock,
  UniqueTag,
  CausalMeta,
  MergeResult,
  CRDTInterface,
  LWWEntry,
  LWWRegisterState,
  ORSetState,
  GSetEntry,
  GSetState,
  GSetMergeFn,
  RGANodeId,
  RGANode,
  RGAState,
  MemoryLayer,
  L4Invariants,
  L3Entity,
  L3Edge,
  L3Graph,
  L2Summary,
  L1Context,
  L0Message,
  AgentMemoryState,
  SemanticConflict,
  ConflictSeverity,
} from '@shorthand/core/crdt';

// ---- What the five renamed compaction names denote in 1.0 ----
import {
  CompactionLevel as LsmLevel,
  DefaultCompactor as SnapshotCompactorImpl,
  VerificationHarness as SnapshotHarness,
  type CompactedState as ReexportedCompactedState,
  type CompactedSnapshot,
  type CompactionLevel as ReexportedCompactionLevel,
  type ConversationHistory as History,
  type SnapshotLevel,
  type SnapshotVerificationResult,
  type VerificationResult as ReexportedVerificationResult,
} from '@shorthand/core/compaction';
import type { CompactedState as RootCompactedState, VerificationResult as RootVerificationResult } from '@shorthand/core';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertSame = <A, B>(same: Same<A, B>): Same<A, B> => same;

// The old names are the LSM pipeline's types now…
export const lsmLevel: ReexportedCompactionLevel = LsmLevel.L1_COMPACTED;
assertSame<ReexportedCompactedState, RootCompactedState>(true);
assertSame<ReexportedVerificationResult, RootVerificationResult>(true);
// …and what DefaultCompactor and VerificationHarness use is the renamed snapshot types
assertSame<ReexportedCompactedState, CompactedSnapshot>(false);
export async function snapshotRoundTrip(history: History): Promise<SnapshotVerificationResult> {
  const level: SnapshotLevel = 'L2';
  const snapshot: CompactedSnapshot = await new SnapshotCompactorImpl().compact(history, level);
  return new SnapshotHarness().verify(snapshot, history);
}
