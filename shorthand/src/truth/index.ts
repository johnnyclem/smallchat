/**
 * Truth Ledger Interop Module
 *
 * Consumer-side seam for stenographer's TB/UV asserted-truth ledger, in
 * stenographer's truth format v2 (spec/truth-format; golden fixtures in
 * test/fixtures/truth-format). @shorthand/core reads one writer's
 * hash-chained stream (or several, one per teammate), folds each entry's
 * status from its TRANSITION lines, carries current truth through
 * compaction under the §7 consumption rules (failing closed on anything it
 * does not understand or cannot verify, and on a TB an agent signed without
 * a quorum of agents), and may emit candidates back as a hash-chained
 * PROPOSAL stream — never as signed truth.
 */

// Types
export type {
  TruthConfidence,
  TbStatus,
  UvStatus,
  UnknownStatus,
  TruthEvidence,
  TruthVerifyBy,
  WikiEntryLine,
  TruthTbEntry,
  TruthUvEntry,
  TruthTombstonedLiteral,
  TruthLedgerEntry,
  TruthEntrySource,
  TruthInadmissible,
  TruthTransition,
  ConsumptionAction,
  TruthSelection,
  CompactedTruth,
  TruthSyncResult,
  ProposalSignalSource,
  ProposalLine,
  UvProposalLine,
  TbProposalLine,
  UvProposalDraft,
  TbProposalDraft,
  WrittenProposalLine,
  InvariantProposalLine,
  TruthEvidenceClass,
  TruthQuorumMember,
} from './types.js';
export { CONSUMPTION_RULES, TRUTH_SOURCE_PREFIX, ulid, EVIDENCE_KINDS, SETTLING_EVIDENCE_KINDS, evidenceClass } from './types.js';

// The agent quorum: agents settle claims only together
export type { TruthQuorumSubject } from './quorum.js';
export { QUORUM_WINDOW_MS, QUORUM_MIN_MEMBERS, checkQuorum } from './quorum.js';

// Identities and the signer registry
export type { TruthSigner, TruthSignerFile, TruthSignerKey, TruthSignerRegistry, TruthSignerRole } from './identity.js';
export {
  MIGRATION_AUTHOR,
  DETECTOR_PREFIX,
  identityKey,
  identityIssue,
  isAnonymousIdentity,
  isReservedIdentity,
  hasControlCharacters,
  assertAccountableAuthor,
  createSignerRegistry,
} from './identity.js';

// Truth format v2: the line codec, the chain, JCS
export type { DecodedTruthLine, StreamHead, TruthLineType } from './format.js';
export {
  TRUTH_SCHEMA_VERSION,
  TRUTH_LINE_TYPES,
  TRUTH_STATUSES,
  CAUSE_KINDS,
  LINK_TYPES,
  TruthLineError,
  decodeTruthLine,
  checkTruthChain,
  truthLineHash,
  literalIssue,
} from './format.js';
export { canonicalize as canonicalizeJcs, CanonicalizationError } from './jcs.js';

// Reading streams + consumption-rule selection
export type { WikiParseResult, TruthReadOptions, TruthLineRecord } from './wiki.js';
export {
  wikiLineToEntry,
  entryToWikiLine,
  literalValidationError,
  parseWikiLines,
  parseWikiFiles,
  serializeWikiEntries,
  readWikiFile,
  writeWikiFile,
  classifyEntry,
  selectCurrentTruth,
  truthStatusTable,
} from './wiki.js';

// Rendering + snapshot compaction bridge
export type { TruthInvariantRecord, ProposeInvariantsOptions, TruthItem } from './compaction-bridge.js';
export {
  TRUTH_SECTION_HEADING,
  renderTruthItems,
  renderTruthLines,
  renderTruthSection,
  applyTruthToSnapshot,
  applyTruthToCompactedState,
  TruthAwareCompactor,
  truthToInvariantRecords,
  proposeInvariants,
  serializeProposals,
  appendProposalsFile,
} from './compaction-bridge.js';

// PROPOSAL streams (the write path) and their reader
export type { ParsedProposal, ProposalParseResult } from './proposals.js';
export {
  COMPACTION_DETECTOR,
  ProposalStream,
  parseProposalLines,
  proposalDedupeKey,
  proposalDraftIssue,
} from './proposals.js';

// LSM pipeline: L4 projection + displacement
export { groundTruthToInvariant, displaceStaleInvariants } from './ledger-sync.js';

// LSM pipeline: proposal export
export type { ProposalSpec } from './proposal-export.js';
export {
  uvProposal,
  tbProposal,
  invariantsToProposalDrafts,
  tombstonesToProposalDrafts,
  exportProposalDrafts,
} from './proposal-export.js';
