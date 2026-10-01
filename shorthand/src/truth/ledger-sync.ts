/**
 * Ledger sync for the LSM pipeline — project ground truth into L4
 * invariants and displace stale projections.
 *
 * Parsing and classification live in `wiki.ts` (`parseWikiLines`,
 * `selectCurrentTruth`); rendering lives in `compaction-bridge.ts`. This
 * module is the opt-in L4 projection for hosts that consume only
 * invariants, and the displacement step `CompactionEngine.syncTruthLedger`
 * runs on every sync.
 */

import type { Invariant } from '../types.js';
import type { TruthSelection, TruthTbEntry } from './types.js';
import { TRUTH_SOURCE_PREFIX } from './types.js';
import { classifyEntry } from './wiki.js';

/**
 * Projects a ground-truth (active) TB into an L4 invariant. The `truth:`
 * sourceMessage prefix is the displacement hook: on the next sync, any
 * projected invariant whose ledger entry is no longer ground truth is
 * removed. Contested TBs are deliberately not projectable — an invariant
 * row cannot carry the asterisk, so contested truth must flow through the
 * rendered truth section, both sides visible. Returns null for anything
 * but an active TB.
 */
export function groundTruthToInvariant(tb: TruthTbEntry): Invariant | null {
  if (classifyEntry(tb) !== 'ground-truth') return null;
  return {
    key: tb.id,
    value: tb.claim,
    sourceMessage: `${TRUTH_SOURCE_PREFIX}${tb.id}`,
    timestamp: Date.parse(tb.ts) || 0,
  };
}

/**
 * Removes invariants whose backing ledger entry is no longer ground truth
 * (overridden, struck, contested, refuted, unknown, or gone). Returns the
 * surviving invariants and the keys removed. Invariants not sourced from
 * the ledger are untouched.
 */
export function displaceStaleInvariants(
  invariants: Invariant[],
  selection: TruthSelection,
): { kept: Invariant[]; displacedKeys: string[] } {
  const stillGroundTruth = new Set(selection.groundTruth.map((tb) => tb.id));
  const kept: Invariant[] = [];
  const displacedKeys: string[] = [];

  for (const inv of invariants) {
    if (!inv.sourceMessage.startsWith(TRUTH_SOURCE_PREFIX)) {
      kept.push(inv);
      continue;
    }
    const id = inv.sourceMessage.slice(TRUTH_SOURCE_PREFIX.length);
    if (stillGroundTruth.has(id)) {
      kept.push(inv);
    } else {
      displacedKeys.push(inv.key);
    }
  }

  return { kept, displacedKeys };
}
