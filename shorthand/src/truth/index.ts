/**
 * Truth Ledger Interop Module
 *
 * Consumer-side seam for stenographer's TB/UV v2 asserted-truth ledger.
 * Short-hand reads signed TB/UV entries from the append-only wiki JSONL,
 * carries them through compaction under the §7 consumption rules, and may
 * emit candidate invariants back as machine-drafted PROPOSAL lines —
 * never as signed truth.
 */

// Types
export type {
  TruthConfidence,
  TbStatus,
  UvStatus,
  TruthEvidence,
  TruthVerifyBy,
  WikiEntryLine,
  TruthTbEntry,
  TruthUvEntry,
  TruthTombstonedLiteral,
  TruthLedgerEntry,
  ConsumptionAction,
  TruthSelection,
  CompactedTruth,
  InvariantProposalLine,
} from './types.js';
export {
  CONSUMPTION_RULES,
  isAnonymousIdentity,
  assertAccountableAuthor,
  ulid,
} from './types.js';

// JSONL codec + consumption-rule selection
export type { WikiParseResult } from './wiki.js';
export {
  wikiLineToEntry,
  entryToWikiLine,
  literalValidationError,
  parseWikiLines,
  serializeWikiEntries,
  readWikiFile,
  writeWikiFile,
  classifyEntry,
  selectCurrentTruth,
} from './wiki.js';

// Compaction bridge
export type { TruthInvariantRecord, ProposeInvariantsOptions } from './compaction-bridge.js';
export {
  renderTruthSection,
  applyTruthToCompactedState,
  TruthAwareCompactor,
  truthToInvariantRecords,
  proposeInvariants,
  serializeProposals,
  appendProposalsFile,
} from './compaction-bridge.js';
